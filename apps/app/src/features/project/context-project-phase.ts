/** Pure project-entry authority for one raw bootstrap operation and detachable live hosting. */

import type { EditorWorkScope } from "./editor-work-scope";

export type BootstrapAttempt = { token: number; workId: string };

export type ContextProjectReadiness =
  | { status: "waiting-for-desk" }
  | { status: "waiting-for-work"; work: Exclude<EditorWorkScope, { status: "ready" }> }
  | { status: "ready"; workId: string };

export type ContextProjectAuthority = {
  hasCompletedBootstrap: boolean;
  activeBootstrapAttempt: BootstrapAttempt | null;
  rawValidation: "not-started" | "running" | "settled";
  nextToken: number;
  readiness: ContextProjectReadiness;
  liveWorkId: string | null;
};

export type ContextProjectPhase =
  | { status: "waiting-for-desk" }
  | { status: "waiting-for-work"; work: Exclude<EditorWorkScope, { status: "ready" }> }
  | { status: "bootstrapping"; attempt: BootstrapAttempt }
  | { status: "suspended"; work: Exclude<EditorWorkScope, { status: "ready" }> }
  | { status: "live"; workId: string };

export type BootstrapAttemptEffect = {
  attempt: BootstrapAttempt;
  raw: "start" | "adopt";
};

export const INITIAL_CONTEXT_PROJECT_AUTHORITY: ContextProjectAuthority = {
  hasCompletedBootstrap: false,
  activeBootstrapAttempt: null,
  rawValidation: "not-started",
  nextToken: 1,
  readiness: { status: "waiting-for-desk" },
  liveWorkId: null,
};

export function contextProjectPhase(authority: ContextProjectAuthority): ContextProjectPhase {
  const readiness = authority.readiness;
  if (readiness.status === "waiting-for-desk") return readiness;
  if (readiness.status === "waiting-for-work") {
    return authority.hasCompletedBootstrap
      ? { status: "suspended", work: readiness.work }
      : readiness;
  }
  if (authority.hasCompletedBootstrap) return { status: "live", workId: readiness.workId };
  if (!authority.activeBootstrapAttempt) {
    throw new Error("ready Context bootstrap authority requires an active attempt");
  }
  return { status: "bootstrapping", attempt: authority.activeBootstrapAttempt };
}

export function updateContextProjectReadiness(
  authority: ContextProjectAuthority,
  deskHydrated: boolean,
  work: EditorWorkScope,
): { authority: ContextProjectAuthority; effect: BootstrapAttemptEffect | null } {
  const readiness: ContextProjectReadiness = !deskHydrated
    ? { status: "waiting-for-desk" }
    : work.status === "ready"
      ? { status: "ready", workId: work.workId }
      : { status: "waiting-for-work", work };
  if (readiness.status !== "ready") {
    return {
      authority: { ...authority, readiness, activeBootstrapAttempt: null, liveWorkId: null },
      effect: null,
    };
  }
  if (authority.hasCompletedBootstrap) {
    return {
      authority: {
        ...authority,
        readiness,
        activeBootstrapAttempt: null,
        liveWorkId: readiness.workId,
      },
      effect: null,
    };
  }
  if (authority.activeBootstrapAttempt?.workId === readiness.workId) {
    return { authority: { ...authority, readiness }, effect: null };
  }
  const attempt = { token: authority.nextToken, workId: readiness.workId };
  const raw = authority.rawValidation === "not-started" ? "start" : "adopt";
  return {
    authority: {
      ...authority,
      readiness,
      activeBootstrapAttempt: attempt,
      rawValidation: raw === "start" ? "running" : authority.rawValidation,
      nextToken: authority.nextToken + 1,
    },
    effect: { attempt, raw },
  };
}

export function cancelContextProjectAttempt(
  authority: ContextProjectAuthority,
  token: number,
): ContextProjectAuthority {
  return authority.activeBootstrapAttempt?.token === token
    ? { ...authority, activeBootstrapAttempt: null }
    : authority;
}

export function settleContextProjectBootstrap(
  authority: ContextProjectAuthority,
  token: number,
): ContextProjectAuthority {
  if (authority.activeBootstrapAttempt?.token !== token) {
    return { ...authority, rawValidation: "settled" };
  }
  return {
    ...authority,
    hasCompletedBootstrap: true,
    activeBootstrapAttempt: null,
    rawValidation: "settled",
    liveWorkId: authority.readiness.status === "ready" ? authority.readiness.workId : null,
  };
}
