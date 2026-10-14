import { expect, it } from "vitest";
import { lintGeometry, lintText } from "./seed-lint.mjs";

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

it("lints a Coord[] polyline as road geometry, not as places", () => {
  // Greenacres Branch Library → center: the interior vertices are road points, so they are
  // not in the §1 table and must not be flagged (ADR-007 committed geometry).
  const geometry = `const G: Coord[] = [
    [-80.145953, 26.622639],
    [-80.1457, 26.6229],
    [-80.14556, 26.641],
    [-80.145541, 26.645352],
  ];`;
  expect(lintText(geometry)).toEqual([]);
});

it("still requires a polyline to run landmark-to-landmark, inside the service area", () => {
  // Starts on a landmark, ends on an untabled point 1.5 km up the road.
  const strayEnd = `const G: Coord[] = [[-80.145953, 26.622639], [-80.1457, 26.6364]];`;
  expect(lintText(strayEnd).length).toBe(1);
  expect(lintText(strayEnd)[0]).toMatch(/must start and end on a MOCKS §1 landmark/);

  // A vertex in another state cannot hide inside an otherwise valid polyline.
  const strayVertex = `const G: Coord[] = [
    [-80.145953, 26.622639],
    [-74.005974, 40.712776],
    [-80.145541, 26.645352],
  ];`;
  expect(lintGeometry(strayVertex).hits).toEqual([
    "<text>: route geometry vertex outside the service area: -74.005974, 40.712776",
  ]);

  // OSRM's 7.4 m snap of the center onto Jog Road is within tolerance.
  const snapped = `const G: Coord[] = [[-80.164767, 26.652165], [-80.145467, 26.64535]];`;
  expect(lintText(snapped)).toEqual([]);
});

it("treats an empty Coord[] accumulator as code, not as geometry", () => {
  expect(lintText("const coords: Coord[] = [];")).toEqual([]);
});

it("keeps the landmark rule outside geometry blocks", () => {
  const place = `const G: Coord[] = [[-80.145953, 26.622639], [-80.145541, 26.645352]];
    const home = { lat: 26.612345, lng: -80.123456 };`;
  expect(lintText(place).length).toBe(2);
});
