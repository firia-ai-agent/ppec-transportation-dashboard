import { assertBootEnv } from "@/lib/env";

// Runtime boot guard: the server refuses to start unless APP_DATA_CLASS=SYNTHETIC.
export function register() {
  assertBootEnv(process.env);
}
