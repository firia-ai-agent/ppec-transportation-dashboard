/**
 * RecordedProvider: replays a cassette of JSON fixtures keyed by prompt hash.
 *
 * A missing key throws. That is the whole point: a recorded run that drifts — because a prompt
 * template changed, because the tier assembly changed, because someone edited a fixture — must
 * fail loudly rather than quietly fall back to a live call or an invented answer. The key is the
 * sha256 of the prompt (redact.sha256Hex), so the cassette holds no prompt text either.
 */
import { z } from "zod";
import { sha256Hex } from "../redact";
import {
  type LlmProvider,
  type ProviderCall,
  type ProviderResponseBody,
  ProviderError,
} from "./provider";

/** Response envelope as it appears in a cassette file. Mirrors ProviderResponseBody. */
const responseBodySchema = z.object({
  tool_calls: z.array(z.object({ name: z.string().min(1), arguments: z.unknown() })).optional(),
  content: z.string().nullable().optional(),
  finish_reason: z.string().optional(),
});

/**
 * A cassette file: `{ entries: [{ prompt_sha256, note, response }] }`. `note` is a human label
 * for the case ("AT-01 cancel AM leg"), never the prompt — a cassette is checked into the repo.
 */
export const cassetteSchema = z.object({
  entries: z
    .array(
      z.object({
        prompt_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        note: z.string().default(""),
        response: responseBodySchema,
      }),
    )
    .min(1),
});

export type CassetteFile = z.infer<typeof cassetteSchema>;
export type Cassette = ReadonlyMap<string, ProviderResponseBody>;

export class CassetteMissError extends ProviderError {}

/** The cassette key for a prompt. Exported so a recording script and a test agree on it. */
export function cassetteKey(prompt: string): string {
  return sha256Hex(prompt);
}

/** Parse a cassette file (JSON already read) into a replay map. Throws on a malformed file. */
export function loadCassette(json: unknown): Cassette {
  const parsed = cassetteSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError(`invalid cassette: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const map = new Map<string, ProviderResponseBody>();
  for (const e of parsed.data.entries) {
    if (map.has(e.prompt_sha256)) throw new ProviderError(`duplicate cassette key ${e.prompt_sha256}`);
    map.set(e.prompt_sha256, e.response);
  }
  return map;
}

/** Build a cassette straight from prompts, for a test that owns both sides. */
export function cassetteFrom(entries: readonly { prompt: string; response: ProviderResponseBody }[]): Cassette {
  return new Map(entries.map((e) => [cassetteKey(e.prompt), e.response]));
}

export type RecordedProviderOptions = { vendor?: string; endpoint?: string };

export interface RecordedProvider extends LlmProvider {
  readonly kind: "recorded";
  /** Prompt hashes replayed, in order. */
  readonly hits: readonly string[];
}

export function recordedProvider(cassette: Cassette, options: RecordedProviderOptions = {}): RecordedProvider {
  const hits: string[] = [];
  return {
    kind: "recorded",
    vendor: options.vendor ?? "openrouter",
    endpoint: options.endpoint ?? "/api/v1/chat/completions",
    hits,
    async invoke(call: ProviderCall): Promise<ProviderResponseBody> {
      const body = cassette.get(call.promptHash);
      if (!body) {
        // Hash only. A miss must not be diagnosable by printing the prompt (TEST-SEC-01).
        throw new CassetteMissError(
          `no recorded response for prompt sha256 ${call.promptHash} (cassette holds ${cassette.size})`,
        );
      }
      hits.push(call.promptHash);
      return body;
    },
  };
}
