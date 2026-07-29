import { describe, expect, it } from "vitest";

import {
  centerPan,
  clampScale,
  contentPointAt,
  fitScale,
  fitTransform,
  pinchStep,
  pointerSpan,
  type ViewerPoint,
  type ViewerTransform,
  wheelScaleFactor,
  zoomAtPoint,
} from "./viewer-math";

/** Where a content point actually lands on screen under a transform. */
function project(transform: ViewerTransform, point: ViewerPoint): ViewerPoint {
  return {
    x: transform.pan.x + point.x * transform.scale,
    y: transform.pan.y + point.y * transform.scale,
  };
}

describe("fit and center", () => {
  it("contains rather than crops, on whichever axis binds", () => {
    // Wide host, tall content: height binds.
    expect(fitScale({ width: 1000, height: 400 }, { width: 200, height: 800 })).toBeCloseTo(
      0.5,
      10,
    );
    // Tall host, wide content: width binds.
    expect(fitScale({ width: 300, height: 900 }, { width: 600, height: 100 })).toBeCloseTo(0.5, 10);
  });

  it("keeps the padding clear on every side", () => {
    const scale = fitScale({ width: 500, height: 500 }, { width: 100, height: 100 }, 50);
    expect(scale).toBeCloseTo(4, 10);
  });

  it("centers what it fits", () => {
    const { scale, pan } = fitTransform({ width: 1000, height: 400 }, { width: 200, height: 800 });
    expect(pan.y).toBeCloseTo(0, 10);
    expect(pan.x).toBeCloseTo((1000 - 200 * scale) / 2, 10);
  });

  it("refits when the aspect flips under it", () => {
    const content = { width: 400, height: 200 };
    const landscape = fitTransform({ width: 800, height: 800 }, content);
    const portrait = fitTransform({ width: 200, height: 800 }, content);

    expect(landscape.scale).toBeCloseTo(2, 10);
    expect(portrait.scale).toBeCloseTo(0.5, 10);
    // Still centered on both axes after the flip.
    expect(portrait.pan.x).toBeCloseTo(0, 10);
    expect(portrait.pan.y).toBeCloseTo((800 - 200 * 0.5) / 2, 10);
  });

  it("clamps the fit into the caller's limits", () => {
    const transform = fitTransform(
      { width: 4000, height: 4000 },
      { width: 100, height: 100 },
      { limits: { minScale: 0.1, maxScale: 3 } },
    );
    expect(transform.scale).toBe(3);
    expect(transform.pan).toEqual(
      centerPan({ width: 4000, height: 4000 }, { width: 100, height: 100 }, 3),
    );
  });

  it("treats unlaid-out content as fitting at 1", () => {
    expect(fitScale({ width: 500, height: 500 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe("zoom at a point", () => {
  const cases: ReadonlyArray<{
    name: string;
    transform: ViewerTransform;
    at: ViewerPoint;
    to: number;
  }> = [
    {
      name: "in, from fit",
      transform: { scale: 1, pan: { x: 0, y: 0 } },
      at: { x: 300, y: 120 },
      to: 2.5,
    },
    {
      name: "out, from a zoomed view",
      transform: { scale: 3, pan: { x: -420, y: -180 } },
      at: { x: 80, y: 400 },
      to: 0.75,
    },
    {
      name: "at the origin corner",
      transform: { scale: 1.4, pan: { x: 55, y: -12 } },
      at: { x: 0, y: 0 },
      to: 4,
    },
    {
      name: "no-op",
      transform: { scale: 2, pan: { x: 10, y: 10 } },
      at: { x: 640, y: 480 },
      to: 2,
    },
  ];

  for (const { name, transform, at, to } of cases) {
    it(`holds the anchor: ${name}`, () => {
      const before = contentPointAt(transform, at);
      const next = zoomAtPoint(transform, to, at);
      const after = project(next, before);

      // The point under the pointer does not move. Anything above ~0.001 px
      // reads as the diagram sliding while you zoom.
      expect(after.x).toBeCloseTo(at.x, 9);
      expect(after.y).toBeCloseTo(at.y, 9);
      expect(next.scale).toBe(to);
    });
  }

  it("returns to where it started after a round trip", () => {
    const start: ViewerTransform = { scale: 1, pan: { x: 40, y: 25 } };
    const at = { x: 210, y: 90 };
    const stepped = zoomAtPoint(start, start.scale * 1.6 ** 5, at);
    const back = zoomAtPoint(stepped, start.scale, at);

    expect(back.scale).toBeCloseTo(start.scale, 9);
    expect(back.pan.x).toBeCloseTo(start.pan.x, 9);
    expect(back.pan.y).toBeCloseTo(start.pan.y, 9);
  });
});

describe("pointer span", () => {
  it("is a drag with one pointer: a centroid and no spread", () => {
    expect(pointerSpan([{ x: 10, y: 20 }])).toEqual({ centroid: { x: 10, y: 20 }, spread: 0 });
  });

  it("has no answer for no pointers", () => {
    expect(pointerSpan([])).toBeNull();
  });

  it("reads scale out of two-pointer deltas", () => {
    const before = pointerSpan([
      { x: 170, y: 200 },
      { x: 230, y: 200 },
    ]);
    const after = pointerSpan([
      { x: 70, y: 200 },
      { x: 330, y: 200 },
    ]);
    if (!before || !after) throw new Error("expected spans");

    // Fingers 60 px apart spread to 260 px: the spike's own pinch scenario.
    expect(pinchStep(before, after).factor).toBeCloseTo(260 / 60, 10);
    expect(pinchStep(before, after).delta).toEqual({ x: 0, y: 0 });
  });

  it("separates the pinch's pan from its scale", () => {
    const before = pointerSpan([
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ]);
    const after = pointerSpan([
      { x: 150, y: 140 },
      { x: 250, y: 140 },
    ]);
    if (!before || !after) throw new Error("expected spans");

    const step = pinchStep(before, after);
    expect(step.factor).toBe(1);
    expect(step.delta).toEqual({ x: 50, y: 40 });
  });

  it("keeps a drag a drag when a second pointer lands", () => {
    const drag = pointerSpan([{ x: 10, y: 10 }]);
    const twoUp = pointerSpan([
      { x: 10, y: 10 },
      { x: 90, y: 10 },
    ]);
    if (!drag || !twoUp) throw new Error("expected spans");

    // No previous spread to compare against, so the frame the finger lands on
    // must not snap the scale.
    expect(pinchStep(drag, twoUp).factor).toBe(1);
  });
});

describe("wheel", () => {
  it("is symmetric: n notches out then n notches in is identity", () => {
    const inFactor = wheelScaleFactor(-100);
    const outFactor = wheelScaleFactor(100);
    expect(inFactor * outFactor).toBeCloseTo(1, 12);
  });

  it("zooms in on a negative delta and out on a positive one", () => {
    expect(wheelScaleFactor(-100)).toBeGreaterThan(1);
    expect(wheelScaleFactor(100)).toBeLessThan(1);
  });

  it("reads line and page deltas as bigger pixel deltas", () => {
    expect(wheelScaleFactor(3, 1)).toBeLessThan(wheelScaleFactor(3, 0));
    expect(wheelScaleFactor(1, 2)).toBeLessThan(wheelScaleFactor(1, 1));
  });

  it("clamps one violent notch", () => {
    expect(wheelScaleFactor(100_000)).toBe(wheelScaleFactor(200));
  });
});

describe("scale limits", () => {
  it("clamps both ends", () => {
    const limits = { minScale: 0.25, maxScale: 4 };
    expect(clampScale(0.01, limits)).toBe(0.25);
    expect(clampScale(99, limits)).toBe(4);
    expect(clampScale(1.5, limits)).toBe(1.5);
  });
});
