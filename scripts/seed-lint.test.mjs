import { expect, it } from "vitest";
import { lintText } from "./seed-lint.mjs";

it("allows synthetic identities", () => {
  expect(lintText("SYN-Ava f1@example.com +1-561-555-0101")).toEqual([]);
});
it("flags real-looking email and phone", () => {
  expect(lintText("someone@gmail.com").length).toBe(1);
  expect(lintText("+1-561-867-5309").length).toBe(1);
});
