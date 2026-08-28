/** Pure authority phase for bootstrap-before-live Context ownership. */

import type { EditorWorkScope } from "./editor-work-scope";

export type ContextProjectPhase =
  | { status: "waiting-for-desk"; generation: number }
  | {
      status: "waiting-for-work";
      generation: number;
      work: Exclude<EditorWorkScope, { status: "ready" }>;
    }
  | { status: "bootstrapping"; generation: number; workId: string }
  | { status: "live"; generation: number; workId: string };

export function contextProjectPhaseForReadiness(
  current: ContextProjectPhase,
  deskHydrated: boolean,
  work: EditorWorkScope,
): ContextProjectPhase {
  if (!deskHydrated) return { status: "waiting-for-desk", generation: current.generation };
  if (work.status !== "ready") {
    return { status: "waiting-for-work", generation: current.generation, work };
  }
  if (current.status === "live") return { ...current, workId: work.workId };
  if (current.status === "bootstrapping" && current.workId === work.workId) return current;
  return { status: "bootstrapping", generation: current.generation + 1, workId: work.workId };
}

export function settleContextProjectBootstrap(
  current: ContextProjectPhase,
  generation: number,
  workId: string,
): ContextProjectPhase {
  return current.status === "bootstrapping" &&
    current.generation === generation &&
    current.workId === workId
    ? { status: "live", generation, workId }
    : current;
}
