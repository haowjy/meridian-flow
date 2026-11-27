import type { ChromeContext } from "./chrome-context";

export type GesturePhase = "idle" | "drag" | "sweep";

export type ChromeLayer = {
  readonly id: string;
  readonly ownerId: string;
};

export type EscSituation = {
  gesture: GesturePhase;
  layers: readonly ChromeLayer[];
  context: ChromeContext;
};

export type EscStep =
  | { kind: "cancel-gesture"; gesture: "drag" | "sweep" }
  | { kind: "close-layer"; layerId: string }
  | { kind: "select-object"; pos: number }
  | { kind: "caret-after-block"; pos: number }
  | { kind: "at-home" };

export function escStep(situation: EscSituation): EscStep {
  if (situation.gesture !== "idle") {
    return { kind: "cancel-gesture", gesture: situation.gesture };
  }

  const topmost = situation.layers[situation.layers.length - 1];
  if (topmost) return { kind: "close-layer", layerId: topmost.id };

  const { owner, pos, objectPos } = situation.context;
  if ((owner === "source-block" || owner === "object") && pos !== null) {
    return { kind: "caret-after-block", pos };
  }

  if (objectPos !== null) return { kind: "select-object", pos: objectPos };

  return { kind: "at-home" };
}
