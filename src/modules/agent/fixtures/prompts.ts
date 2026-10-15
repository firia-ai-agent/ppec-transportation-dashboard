/**
 * Tokenized prompts for the recorded cassette, in the §11.1 tier shape: T1 approved facts and
 * authorization, T2 current state with versions, T3 the last family-scoped messages wrapped as
 * untrusted, T4 structured preferences.
 *
 * Every person, child, leg and thread here is a token. No name, no number, no address — these
 * strings are what `validatePromptTokensOnly()` is supposed to accept, and `redact.test.ts`
 * asserts exactly that, which makes them the positive half of TEST-SEC-01.
 */
import { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from "../policy";

const tiers = (t1: string, t2: string, t3: string, t4: string): string =>
  [
    "role=transport_coordinator_agent",
    `T1 ${t1}`,
    `T2 ${t2}`,
    `T3 ${UNTRUSTED_OPEN}${t3}${UNTRUSTED_CLOSE}`,
    `T4 ${t4}`,
    "task=choose exactly one tool call",
  ].join("\n");

/** AT-01: one guardian cancels the AM leg and names a self-arrival (demo step 2). */
export const PROMPT_AT01_CANCEL_AM = tiers(
  "site=S1 family=F1 child=C1 scopes=CANCEL_LEG,RECEIVE_TRANSPORT_UPDATES",
  "leg=L-C1-AM state=SCHEDULED version=3 am_window=08:00 pm_leg=L-C1-PM state=SCHEDULED version=3",
  "wont need the AM van, dropping off at 9:30",
  "channel=SMS locale=en-US",
);

/** AT-06: a shared number, two children, no child named — the clarification case (demo step 3). */
export const PROMPT_AT06_SIBLING_AMBIGUITY = tiers(
  "site=S1 family=F4 children=C4,C5 scopes=CANCEL_LEG",
  "leg=L-C4-AM state=SCHEDULED version=2 leg=L-C5-AM state=SCHEDULED version=2 thread=TH-F4",
  "staying home sick today",
  "channel=SMS locale=en-US",
);

/** Every prompt in the cassette, with the label its cassette entry carries. */
export const RECORDED_PROMPTS: readonly { note: string; prompt: string }[] = [
  { note: "AT-01 inbound cancel AM leg", prompt: PROMPT_AT01_CANCEL_AM },
  { note: "AT-06 sibling ambiguity", prompt: PROMPT_AT06_SIBLING_AMBIGUITY },
];
