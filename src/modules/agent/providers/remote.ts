/**
 * The live vendor adapter — OpenRouter, over `fetch` (B-08 slice 5).
 *
 * ADR-000 #4/#12 put the agent live on OpenRouter with the founder's key; the founder's
 * 2026-10-15 decision made the model a *free* one, on demo data only, with the move to a
 * HIPAA-compliant endpoint sequenced behind a signed BAA
 * (docs/research/QUEUES-AND-OPENROUTER-ZDR.md §2.5A). This file is the only one in the agent
 * module that calls `fetch`, and `no-network.test.ts` holds that down by name.
 *
 * Four gates, in this order, and the order is the design:
 *
 *  1. **The demo-data guard, fail shut** (`config.demoDataGuardRefusal`: the confirmation var, the
 *     ADR-015 boot data class, and this module's data mode, all three). No key is read, no body is
 *     built, no URL is constructed and `fetch` is not touched unless it passes. None of the free
 *     endpoints offer ZDR, some log or train on prompts, and OpenRouter has no BAA — so this guard
 *     is the only thing keeping real family data away from them. It refuses *before* the key check
 *     on purpose: a deployment that has a key but has not confirmed demo data is exactly the
 *     dangerous one, and it must not matter whether the key is present.
 *  2. **The destination, before there is a Bearer header to send.** `config.baseUrl` must be https
 *     and its host must be on `config.baseUrlHostAllowList` (`baseUrlRefusalReason`). Config
 *     refuses such a value at parse time; this is the re-check on the path that leaves the
 *     building, because the base URL is the one knob that decides *where the key goes* and a
 *     caller can hold a config object this file did not parse.
 *
 *     And the base URL is only half of it: the endpoint is joined onto it, so the destination is
 *     checked *twice more* on the way out. The endpoint must be a plain absolute path
 *     (`endpointPathRefusalReason`) — `"@evil.example/…"` concatenated onto an allow-listed origin
 *     is a request to `evil.example` with the origin as a username, and `"//evil.example/…"` and
 *     `"/\evil.example/…"` land there too. Then the URL is *built* with the URL parser rather than
 *     concatenated, and `verifiedRequestUrl` re-reads the scheme, the userinfo and the host off
 *     the finished URL on the line before the `Bearer` header is written. Each of the two refuses
 *     every one of those shapes on its own; neither is the only thing standing there.
 *  3. **The key, by env var name only** (`config.apiKeyEnvVar`). Read here and nowhere else, never
 *     logged, never in an error message, never in a thrown stack.
 *  4. **The model chain.** Primary, then backup on a 429 or any other failure, and then nothing:
 *     `RemoteProviderUnavailable`. There is no third attempt in another form. PRD §18.1 l.1200 put
 *     a keyword reader here — the model is down, so a deterministic parser answers the family —
 *     and the founder's 2026-10-17 rule removed it: "never compensate with a deterministic text
 *     parser if the model isn't available; the owner/staff need to be notified". So this adapter's
 *     only answer to a dead vendor is to say so, and the caller's answer is a staff alert
 *     (`agent/staff-alert.ts`): no reply to the family, no ride change, no send. Every model in
 *     the chain is re-checked against `config.modelAllowList` before the first request, for the
 *     same reason as the endpoint and the host: config checked it, and this is the outbound path.
 *
 * What this file does *not* do is any of the gateway's work. It does not redact, validate, audit
 * or interpret: the prompt arriving here has already passed `validatePromptTokensOnly()`, and the
 * body leaving here is normalized onto `ProviderResponseBody` for the gateway to accept or refuse.
 * That is why a response carrying prose is returned as-is rather than patched — free text is a
 * contract violation for the gateway to reject, not something an adapter should paper over.
 *
 * The AWS/Bedrock swap (ARCHITECTURE §10) is a new `baseUrl`, `model` and `modelAllowList` in
 * config plus `vendorAttestation`; nothing in this file names a vendor, a model or a host.
 */
import type { AgentConfig, DemoDataGuardFailure } from "../config";
import {
  baseUrlRefusalReason,
  demoDataGuardFailure,
  endpointPathRefusalReason,
  forbiddenEndpointReason,
  vendorRequestUrl,
} from "../config";
import {
  type LlmProvider,
  type ProviderCall,
  type ProviderResponseBody,
  ProviderError,
} from "./provider";

/** The provider is not usable in this environment: no demo-data confirmation, or no key. */
export class RemoteProviderNotEnabled extends ProviderError {}

/**
 * The §2.5A demo-data guard refused: one of `AGENT_DEMO_DATA_ONLY`, `APP_DATA_CLASS` or
 * `AGENT_DATA_MODE` does not hold (`config.demoDataGuardFailure`).
 *
 * It carries the structured failure rather than only the sentence, because the caller has to say
 * **which** condition refused — in a log line, and on the staff alert the founder's 2026-10-17
 * rule requires — and re-deriving that by matching this error's message is how it breaks on the
 * first rewording. `failure.envVar` is a name; no value of any of the three ever leaves here.
 */
export class RemoteDemoDataGuardRefused extends RemoteProviderNotEnabled {
  constructor(readonly failure: DemoDataGuardFailure) {
    super(failure.message);
  }
}

/**
 * The narrower half of the above: the environment is otherwise fine and `$<apiKeyEnvVar>` is not
 * set. A subclass rather than a flag, so every existing `instanceof RemoteProviderNotEnabled`
 * still catches it, and so the one caller that needs to tell the two apart can.
 *
 * It needs telling apart because the two are different work for different people. A missing
 * demo-data confirmation is a deployment that has not been told it may call a vendor at all, and
 * the fix is a setting. A missing key is the model being unavailable, which under the founder's
 * 2026-10-17 rule is a **staff alert**: somebody has to answer the family by hand right now.
 * `agent/staff-alert.ts` reads this class to say which.
 */
export class RemoteApiKeyMissing extends RemoteProviderNotEnabled {
  constructor(
    message: string,
    /** The env var NAME that is unset. The value is not read here and never will be. */
    readonly apiKeyEnvVar: string,
  ) {
    super(message);
  }
}

/** The call named an endpoint this deployment may not POST to (PRD §11.2 allow-list). */
export class RemoteEndpointRefused extends ProviderError {}

/**
 * The configured origin is not one this deployment may send a key to: plain http, a host off
 * `baseUrlHostAllowList`, credentials in the URL, or not a URL at all. Its own class because it is
 * a different accident from a missing confirmation — somebody repointed the vendor.
 */
export class RemoteBaseUrlRefused extends ProviderError {}

/**
 * The URL a call was about to be sent to is not one this deployment may send a key to, read off
 * the *built* URL rather than off either half of it. Its own class because it is a different
 * accident again: not a misconfigured origin, and not an endpoint off the allow-list, but an
 * endpoint that moved the host the allow-listed origin named. Reached only if
 * `endpointPathRefusalReason` is ever wrong, which is the point of it being here.
 */
export class RemoteRequestUrlRefused extends ProviderError {}

/** A model in the chain is not on `config.modelAllowList`, re-checked on the outbound path. */
export class RemoteModelRefused extends ProviderError {}

/**
 * Every model in the chain failed, so this deployment cannot reach a model at all.
 *
 * The *only* outcome of an exhausted chain, and the whole of the founder's 2026-10-17 rule in one
 * class: there is no degraded answer to fall through to, so the adapter raises and the gateway
 * turns it into `PROVIDER_ERROR`, which is what `agent/staff-alert.ts` reads to raise the one
 * "needs a person" alert. It used to be reachable only when an option switched the keyword
 * fallback off; it is now the single path.
 */
export class RemoteProviderUnavailable extends ProviderError {
  constructor(
    message: string,
    /**
     * How each attempt in the chain ended, in order. The reason the caller can say "timeout" or
     * "429 on both models" in a log line without parsing this error's message.
     */
    readonly attempts: readonly RemoteAttempt[] = [],
  ) {
    super(message);
  }
}

/** HTTP 429. Named because it is the expected failure on a free endpoint, not an exceptional one. */
export const RATE_LIMITED = 429;

/** How one attempt ended. `attempts` on a response is this, in order, for the caller's logs. */
export type RemoteAttempt = {
  readonly model: string;
  readonly status: number | null;
  readonly ok: boolean;
  /** Failure class, never the vendor's message — that could quote the prompt back at us. */
  readonly failure: "rate_limited" | "http_error" | "malformed_body" | "network_error" | "timeout" | null;
};

export type RemoteResponseBody = ProviderResponseBody & {
  /** Which models were tried and how each ended. Codes and counts only. */
  readonly attempts?: readonly RemoteAttempt[];
};

export interface RemoteProvider extends LlmProvider {
  readonly kind: "remote";
  /** Name of the env var carrying the key. The value appears in no other property. */
  readonly apiKeyEnvVar: string;
  /** One entry per attempt across every call, newest last. Hashes, codes and model ids only. */
  readonly attempts: readonly RemoteAttempt[];
  /**
   * Narrows `LlmProvider.invoke` to the richer body: the gateway reads only the base shape, but a
   * caller holding the adapter directly can see which models were tried and how each one ended.
   * That is what a failed run reports — in a reason class, never a vendor message.
   */
  invoke(call: ProviderCall): Promise<RemoteResponseBody>;
}

/**
 * Gates one to three as a classed error, or null when this environment may make a live call. The
 * order is the one documented at the top of the file, and the key is the *last* thing looked at:
 * every refusal above it has to hold whether or not a key is present, and none of them may be
 * reached only after the key has been read.
 */
function liveCallRefusal(
  config: AgentConfig,
  env: Record<string, string | undefined>,
): ProviderError | null {
  const guard = demoDataGuardFailure(config, env);
  if (guard) return new RemoteDemoDataGuardRefused(guard);

  const destination = baseUrlRefusalReason(config.baseUrl, config.baseUrlHostAllowList);
  if (destination) return new RemoteBaseUrlRefused(destination);

  if ((env[config.apiKeyEnvVar] ?? "").trim() === "") {
    return new RemoteApiKeyMissing(
      `remote provider ${config.provider} is not configured: $${config.apiKeyEnvVar} is not set in this environment`,
      config.apiKeyEnvVar,
    );
  }
  return null;
}

/**
 * Why this environment may not make a live call, or null when it may. Exported because the
 * refusal is worth asserting on directly, and because a caller deciding between the live and the
 * recorded provider should be able to ask without constructing one.
 *
 * Every message is one lowercase clause per fact, the house style for every other refusal in this
 * module — and the reason `src/ui/copy.test.ts` does not read any of them as user-facing copy. A
 * staff-readable sentence, if this ever needs one, belongs in `ui/copy.ts` like the rest.
 */
export function liveCallRefusalReason(
  config: AgentConfig,
  env: Record<string, string | undefined>,
): string | null {
  return liveCallRefusal(config, env)?.message ?? null;
}

/**
 * The URL one call is about to be sent to, or a throw. Built with the URL parser and re-checked on
 * the finished URL (`config.vendorRequestUrl`).
 *
 * It throws rather than returning a reason because of where it sits: the line before the `Bearer`
 * header is written, in the one function in this module that attaches the key. A return value
 * there is something a later edit can forget to read; an exception is not.
 *
 * Exported for the same reason `liveCallRefusalReason` is — this is the backstop behind
 * `endpointPathRefusalReason`, so it is worth asserting on its own, with that gate out of the way,
 * rather than only through a path that can never reach it while the gate is correct.
 */
export function verifiedRequestUrl(
  config: Pick<AgentConfig, "baseUrl" | "baseUrlHostAllowList">,
  endpoint: string,
): string {
  const built = vendorRequestUrl(config, endpoint);
  if (built.refusal !== null) throw new RemoteRequestUrlRefused(built.refusal);
  return built.url;
}

/**
 * The models to try, in order: primary, then backup when it is a different id. The order only —
 * `invoke` re-checks the chain against `modelAllowList` before it posts anything, so this stays a
 * pure list and the refusal has one home.
 */
export function modelChain(config: AgentConfig): readonly string[] {
  return config.model === config.backupModel ? [config.model] : [config.model, config.backupModel];
}

export function remoteProvider(
  config: AgentConfig,
  env: Record<string, string | undefined> = process.env,
): RemoteProvider {
  const endpoint = config.endpointAllowList[0];
  const attempts: RemoteAttempt[] = [];

  // Gates one to three, at wiring time: a deployment that selected this provider without
  // confirming demo data, pointed at a host it may not send a key to, or without a key at all,
  // gets a clear refusal naming what is wrong rather than a provider object that looks usable and
  // fails on the first family message.
  const refusal = liveCallRefusal(config, env);
  if (refusal) throw refusal;

  // Read once, here, and never stored on the returned object.
  const apiKey = (env[config.apiKeyEnvVar] ?? "").trim();

  return {
    kind: "remote",
    vendor: config.provider,
    endpoint,
    apiKeyEnvVar: config.apiKeyEnvVar,
    attempts,

    async invoke(call: ProviderCall): Promise<RemoteResponseBody> {
      // Re-checked per call, not just at wiring time: config is a value a caller can rebuild, and
      // the guard has to be the thing that is impossible to get past, not the thing that happened
      // to be true when the object was made. The destination check rides along for the same
      // reason, and still lands before the Bearer header is built.
      const perCall = liveCallRefusal(config, env);
      if (perCall) throw perCall;

      // The gateway already checked this, and checks it again here because *this* file is the one
      // that leaves the building: a caller holding the adapter directly must not be able to POST
      // to an endpoint the §11.2 allow-list excludes. Belt and braces on the only outbound path.
      if (!config.endpointAllowList.includes(call.endpoint)) {
        throw new RemoteEndpointRefused(`endpoint ${call.endpoint} is not on the configured allow-list`);
      }
      const forbidden = forbiddenEndpointReason(call.endpoint);
      if (forbidden) throw new RemoteEndpointRefused(`endpoint ${call.endpoint} refused: ${forbidden}`);

      // An allow-listed endpoint is still only a *path*, and this is where that is established.
      // The allow-list is a list of strings a deployment configured, and a string like
      // "@evil.example/api/v1/chat/completions" on it is on the list and also a different host
      // once it is joined onto the base URL — so membership is not the question, shape is.
      const shape = endpointPathRefusalReason(call.endpoint);
      if (shape) throw new RemoteEndpointRefused(`endpoint ${call.endpoint} refused: ${shape}`);

      // The model allow-list, re-checked here for the same reason as the endpoint above: config
      // refuses a model off the list at parse time, and this is the file that puts a model id in a
      // body and posts it. The whole chain is checked before the first request rather than each
      // model before its own, so a tampered-with config sends nothing at all instead of spending
      // one call on the model that happened to still be allowed.
      const chain = modelChain(config);
      const offList = chain.filter((m) => !config.modelAllowList.includes(m));
      if (offList.length > 0) {
        throw new RemoteModelRefused(
          `model${offList.length > 1 ? "s" : ""} ${offList.join(", ")} not on the configured model allow-list`,
        );
      }

      const theseAttempts: RemoteAttempt[] = [];
      for (const model of chain) {
        const attempt = await attemptOnce(model, call);
        theseAttempts.push(attempt.record);
        attempts.push(attempt.record);
        if (attempt.body) return { ...attempt.body, attempts: theseAttempts };
      }

      // Every model failed, and that is the end of it. Nothing stands in for a model here: the
      // founder's 2026-10-17 rule forbids a deterministic parser answering in its place, so the
      // adapter raises and a person is told (`agent/staff-alert.ts`). The message is reason
      // classes and status codes only — a vendor's own error text can quote the prompt back.
      throw new RemoteProviderUnavailable(
        `every configured model failed [${theseAttempts
          .map((a) => `${a.model}:${a.failure ?? "unknown"}${a.status === null ? "" : `(${a.status})`}`)
          .join(", ")}]`,
        theseAttempts,
      );
    },
  };

  /**
   * One model, one request. Returns a body on success and a record either way; it never throws,
   * because a failure here is the fallback chain's input rather than the call's outcome.
   */
  async function attemptOnce(
    model: string,
    call: ProviderCall,
  ): Promise<{ readonly record: RemoteAttempt; readonly body: ProviderResponseBody | null }> {
    // The last thing checked before a Bearer header exists: the URL is *built* from the base URL
    // and the endpoint with the URL parser, and then the finished URL is asked where it is going —
    // https, no userinfo, and a host on the allow-list. A concatenated string could not be asked:
    // "https://openrouter.ai" + "@evil.example/…" is a request to evil.example, and the only way
    // to find that out is to parse the result and read its host.
    //
    // Outside the try below on purpose. A refusal here has to leave `invoke` as a thrown
    // RemoteRequestUrlRefused rather than being recorded as one more failed attempt in the chain:
    // "the key nearly went to a host nobody vetted" is a different accident from a dead vendor,
    // and it must keep its own class all the way out.
    const url = verifiedRequestUrl(config, call.endpoint);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      // The global, called plainly. There is no injected transport seam on purpose: tests stub
      // the global (vi.stubGlobal), and an alias here would evade the `fetch(` pattern that
      // no-network.test.ts uses to prove this is the only file in the module that calls out.
      const response = await fetch(url, {
        method: "POST",
        headers: {
          // The key goes in a header and nowhere else: not a query param, which would put it in
          // the vendor's access logs and in ours.
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody(model, call)),
        signal: controller.signal,
      });
      if (!response.ok) {
        const failure = response.status === RATE_LIMITED ? "rate_limited" : "http_error";
        // PPE-101: one diagnosable line per failed model — status, OpenRouter's error code and a
        // short slice of its message (e.g. "No endpoints found matching your data policy"). Never
        // the key, the request headers or the request body.
        const detail = await openRouterErrorDetail(response);
        console.warn(JSON.stringify({ event: "agent.provider_error", model, status: response.status, ...detail }));
        return { record: { model, status: response.status, ok: false, failure }, body: null };
      }
      const parsed = normalize(await response.json());
      return parsed === null
        ? { record: { model, status: response.status, ok: false, failure: "malformed_body" }, body: null }
        : { record: { model, status: response.status, ok: true, failure: null }, body: parsed };
    } catch (e) {
      // The vendor's error text is not recorded: a network stack can quote the request body, and
      // the request body contains the prompt.
      const failure = isAbort(e) ? "timeout" : "network_error";
      return { record: { model, status: null, ok: false, failure }, body: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The outbound body. `provider.allow_fallbacks:false` and `require_parameters:true` are on every
   * request (§2.5): the first means OpenRouter may not silently route to a model that is not the
   * one named — which would make both the audit row and the model allow-list a lie — and the
   * second means an endpoint that cannot honour the tool-call parameters is refused rather than
   * answering in prose.
   *
   * The ZDR block rides on `call.zdr`, which the gateway stamps from config. It is *not* forced on
   * here: the free demo endpoints have no ZDR to ask for, and OpenRouter's Google ZDR toggle
   * blocks Gemma free outright (§2A.4), so the demo deployment sets `AGENT_MODEL_ZDR=0` and the
   * demo-data guard above is what protects the data instead. The compliant endpoint turns it back
   * on with one env var.
   */
  function requestBody(model: string, call: ProviderCall): Record<string, unknown> {
    return {
      model,
      messages: [{ role: "user", content: call.prompt }],
      // §11.2 "JSON-schema tool calls only" — declared as functions, and required, so the model
      // cannot answer this turn with prose.
      tools: call.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          // The only words about a tool the model reads (tools.ts `description`). Guidance only.
          ...(t.description ? { description: t.description } : {}),
          parameters: t.parameters,
        },
      })),
      tool_choice: "required",
      provider: {
        allow_fallbacks: false,
        require_parameters: true,
        ...(call.zdr ? { zdr: true, data_collection: "deny" } : {}),
      },
    };
  }
}

/** Was this an AbortController firing, i.e. our own timeout? */
function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

/**
 * Map the vendor envelope onto ProviderResponseBody, or null when it is not one. A body that does
 * not parse is a failed attempt, so the chain moves to the backup rather than handing the gateway
 * a shape it would reject — the backup might answer properly, and a 200 carrying HTML from a proxy
 * is not a model refusing, it is a transport problem.
 *
 * A well-formed response carrying prose and no tool call *is* returned, for the gateway to refuse
 * with REJECTED_FREE_TEXT. That is a model contract violation and it belongs in the audit log.
 */
export function normalize(raw: unknown): ProviderResponseBody | null {
  if (typeof raw !== "object" || raw === null) return null;
  const choices = (raw as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0] as { message?: unknown; finish_reason?: unknown };
  const message = (choice.message ?? {}) as { content?: unknown; tool_calls?: unknown };
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;

  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
        .map((tc) => {
          const fn = (tc as { function?: { name?: unknown; arguments?: unknown } }).function;
          // The gateway's coerceArgs() handles both an object and a JSON string, so arguments are
          // passed through untouched rather than parsed here.
          return typeof fn?.name === "string" ? { name: fn.name, arguments: fn.arguments } : null;
        })
        .filter((tc): tc is { name: string; arguments: unknown } => tc !== null)
    : [];

  return {
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    content: typeof message.content === "string" ? message.content : null,
    ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
  };
}

/** OpenRouter's `{ error: { code, message } }`, bounded; nothing else from the body is kept. */
async function openRouterErrorDetail(
  response: Response,
): Promise<{ readonly code: string | number | null; readonly message: string | null }> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } } | null;
    const code = body?.error?.code;
    const message = body?.error?.message;
    return {
      code: typeof code === "number" || typeof code === "string" ? code : null,
      message: typeof message === "string" ? message.slice(0, 200) : null,
    };
  } catch {
    return { code: null, message: null };
  }
}
