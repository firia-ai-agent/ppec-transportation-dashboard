import { expect, it } from "vitest";
import { lintText } from "./seed-lint.mjs";

it("allows synthetic identities", () => {
  expect(lintText("SYN-Ava f1@example.com +1-561-555-0101")).toEqual([]);
});
it("flags real-looking email and phone", () => {
  expect(lintText("someone@gmail.com").length).toBe(1);
  expect(lintText("+1-561-867-5309").length).toBe(1);
});

it("ignores UUIDs", () => {
  expect(lintText('"01900000-0000-7000-8000-0000000000d1"')).toEqual([]);
});

it("allows landmark coordinates and flags any other (MOCKS §1)", () => {
  expect(lintText("lat: 26.652165, lng: -80.164767")).toEqual([]);
  expect(lintText("lat: 26.652000, lng: -80.164767").length).toBe(1);
  expect(lintText("{ lat: 40.712776, lng: -74.005974 }").length).toBe(2);
  expect(lintText("version 1.0, ratio 0.5, speed 1.25")).toEqual([]);
});

it("ignores UUID prefixes used to build fixture ids", () => {
  expect(lintText('`01900000-0000-7000-8000-${kind}${n}`')).toEqual([]);
});
