import { describe, expect, it } from "vitest";
import {
  bearingDeg,
  distanceM,
  headingAtDistance,
  measurePath,
  offsetByMeters,
  pathUpTo,
  pointAtDistance,
  projectToPath,
  type Coord,
} from "./geo";

/** Okeeheelee Park → center, the committed OSRM probe (docs/research/osrm-probe.txt). */
const OKEEHEELEE: Coord = [-80.164767, 26.652165];
const CENTER: Coord = [-80.145541, 26.645352];

/** A straight 1 km-ish north leg on Jog Rd, easy to reason about. */
const JOG: Coord[] = [
  [-80.1456, 26.6338],
  [-80.14558, 26.6374],
  [-80.14556, 26.641],
];

describe("distanceM (haversine)", () => {
  it("is zero for a point against itself", () => {
    expect(distanceM(CENTER, CENTER)).toBe(0);
  });

  it("matches the straight-line distance between the probe's endpoints", () => {
    // Great-circle, so shorter than OSRM's 2,739.8 m of road.
    const d = distanceM(OKEEHEELEE, CENTER);
    expect(d).toBeGreaterThan(2000);
    expect(d).toBeLessThan(2200);
  });

  it("is symmetric", () => {
    expect(distanceM(OKEEHEELEE, CENTER)).toBeCloseTo(distanceM(CENTER, OKEEHEELEE), 6);
  });

  it("measures a degree of latitude at about 111 km", () => {
    expect(distanceM([-80, 26], [-80, 27])).toBeCloseTo(111_195, -2);
  });
});

describe("bearingDeg", () => {
  it("reads due north and due east", () => {
    expect(bearingDeg([-80, 26], [-80, 27])).toBeCloseTo(0, 6);
    // Over a short hop; the initial bearing of a long east-west great circle is not 90°.
    expect(bearingDeg([-80, 26], [-79.999, 26])).toBeCloseTo(90, 1);
  });

  it("stays in [0, 360)", () => {
    expect(bearingDeg([-80, 26], [-81, 26])).toBeGreaterThan(269);
    expect(bearingDeg([-80, 26], [-81, 26])).toBeLessThan(271);
  });
});

describe("offsetByMeters (the ±40 m jitter fault)", () => {
  it("moves exactly the requested distance", () => {
    const moved = offsetByMeters(CENTER, 40, 0);
    expect(distanceM(CENTER, moved)).toBeCloseTo(40, 1);
    expect(distanceM(CENTER, offsetByMeters(CENTER, 0, -40))).toBeCloseTo(40, 1);
  });
});

describe("measurePath / pointAtDistance", () => {
  const path = measurePath(JOG);

  it("accumulates segment lengths", () => {
    expect(path.cumulativeM[0]).toBe(0);
    expect(path.totalM).toBeCloseTo(
      distanceM(JOG[0], JOG[1]) + distanceM(JOG[1], JOG[2]),
      6,
    );
  });

  it("returns the endpoints at 0 and totalM, and clamps outside", () => {
    expect(pointAtDistance(path, 0)).toEqual(JOG[0]);
    expect(pointAtDistance(path, path.totalM)).toEqual(JOG[2]);
    expect(pointAtDistance(path, -500)).toEqual(JOG[0]);
    expect(pointAtDistance(path, path.totalM + 500)).toEqual(JOG[2]);
  });

  it("puts the halfway point on the line, half the length along", () => {
    const mid = pointAtDistance(path, path.totalM / 2);
    expect(distanceM(JOG[0], mid)).toBeCloseTo(path.totalM / 2, 0);
    expect(projectToPath(path, mid).offsetM).toBeLessThan(1);
  });

  it("tolerates repeated vertices, which the OSRM fixture contains", () => {
    const dup = measurePath([JOG[0], JOG[0], JOG[1]]);
    expect(dup.cumulativeM[1]).toBe(0);
    expect(pointAtDistance(dup, 0)).toEqual(JOG[0]);
    expect(headingAtDistance(dup, 0)).toBeCloseTo(bearingDeg(JOG[0], JOG[1]), 0);
  });

  it("refuses an empty polyline rather than returning a silent zero", () => {
    expect(() => measurePath([])).toThrow(/empty/);
  });
});

describe("projectToPath (how 'how far along' survives jitter)", () => {
  const path = measurePath(JOG);

  it("returns the chainage of the nearest point on the line", () => {
    const target = path.totalM * 0.3;
    const on = pointAtDistance(path, target);
    const projection = projectToPath(path, on);
    expect(projection.alongM).toBeCloseTo(target, 0);
    expect(projection.offsetM).toBeLessThan(1);
  });

  it("keeps chainage within a few metres when a point is thrown 40 m sideways", () => {
    const target = path.totalM * 0.5;
    const on = pointAtDistance(path, target);
    // Due east of a northbound road: almost entirely perpendicular.
    const jittered = offsetByMeters(on, 40, 0);
    const projection = projectToPath(path, jittered);
    expect(projection.offsetM).toBeGreaterThan(35);
    expect(Math.abs(projection.alongM - target)).toBeLessThan(5);
  });

  it("clamps to the ends for points beyond them", () => {
    expect(projectToPath(path, offsetByMeters(JOG[0], 0, -200)).alongM).toBe(0);
    expect(projectToPath(path, offsetByMeters(JOG[2], 0, 200)).alongM).toBeCloseTo(path.totalM, 6);
  });

  /**
   * A route that drives one stretch twice — up Jog Rd, turn round, back down it — which is the
   * shape of a real run that collects a child at a stop and leaves the way it came (R1's morning
   * at the Lantana library, src/fixtures/run-routes.ts). One position on the shared road then has
   * two chainages, and only the vehicle's own history says which it is.
   */
  describe("a road the route drives twice", () => {
    const thereAndBack = measurePath([...JOG, ...[...JOG].reverse().slice(1)]);
    const turnM = path.totalM;
    const half = turnM * 0.5;
    /** The same spot on the tarmac, as a chainage on the way up and on the way back. */
    const outbound = half;
    const inbound = turnM * 2 - half;
    const spot = pointAtDistance(thereAndBack, outbound);

    it("is genuinely ambiguous when nothing says where the vehicle was", () => {
      // Both passes are the same tarmac, so both are "on the road" and which one comes back is
      // a matter of floating-point luck — the ambiguity this hint exists to resolve.
      const blind = projectToPath(thereAndBack, spot);
      expect(blind.offsetM).toBeLessThan(1);
      expect(Math.min(Math.abs(blind.alongM - outbound), Math.abs(blind.alongM - inbound))).
        toBeLessThan(1);
    });

    it("reads a vehicle on the way back as being on the way back", () => {
      // Without the hint this point is "half way up", and the ETA gains the whole loop.
      const projection = projectToPath(thereAndBack, spot, { nearM: inbound - 50 });
      expect(projection.alongM).toBeCloseTo(inbound, 0);
      expect(projection.offsetM).toBeLessThan(1);
    });

    it("prefers the pass ahead of the vehicle, not merely the nearest chainage", () => {
      // Just past the turn, the two passes are nearly equidistant: a van that has turned round
      // is on the way back, and reading it as still climbing would run the ETA up the road again.
      expect(projectToPath(thereAndBack, spot, { nearM: outbound + 10 }).alongM).toBeCloseTo(
        inbound,
        0,
      );
    });

    it("still follows a vehicle that is genuinely behind where it was", () => {
      // A tie-break and nothing more: where the road is driven once, the position decides, and a
      // hint from further down the route does not pin the answer forward.
      const target = path.totalM * 0.3;
      const on = pointAtDistance(path, target);
      expect(projectToPath(path, on, { nearM: path.totalM }).alongM).toBeCloseTo(target, 0);
    });

    it("changes nothing on a route that never doubles back", () => {
      const target = path.totalM * 0.3;
      const on = pointAtDistance(path, target);
      expect(projectToPath(path, on, { nearM: 0 })).toEqual(projectToPath(path, on));
    });
  });
});

describe("headingAtDistance", () => {
  it("reads the heading of the segment the vehicle is on", () => {
    const path = measurePath(JOG);
    expect(headingAtDistance(path, 10)).toBeCloseTo(bearingDeg(JOG[0], JOG[1]), 0);
  });
});

describe("pathUpTo (the driven-route line)", () => {
  const path = measurePath(JOG);

  it("is empty-ish at the start and the whole line at the end", () => {
    expect(pathUpTo(path, 0)).toEqual([JOG[0]]);
    expect(pathUpTo(path, path.totalM)).toEqual(JOG);
  });

  it("ends exactly at the given distance, not at the last vertex passed", () => {
    const target = path.cumulativeM[1] + 100;
    const driven = pathUpTo(path, target);
    expect(driven).toHaveLength(3);
    expect(measurePath(driven).totalM).toBeCloseTo(target, 0);
    expect(driven[driven.length - 1]).not.toEqual(JOG[1]);
  });

  it("clamps rather than throwing", () => {
    expect(pathUpTo(path, -10)).toEqual([JOG[0]]);
    expect(pathUpTo(path, path.totalM * 10)).toEqual(JOG);
  });
});
