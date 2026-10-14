import type { Handlers } from "./runner";

/**
 * Registered timer kinds. Domain timers (T−90 capability request, 10-min therapist ack, EOD, …) are added
 * by their milestones (B-04/B-06/B-14). `noop.test` exists for the TEST-INF-01 harness and smoke checks.
 */
export const handlers: Handlers = {
  "noop.test": async () => {},
};
