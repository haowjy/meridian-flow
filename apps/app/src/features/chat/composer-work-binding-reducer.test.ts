import type { Work } from "@meridian/contracts/works";
import { describe, expect, it } from "vitest";
import {
  type ComposerWorkBindingState,
  initialComposerWorkBindingState,
  reduceComposerWorkBinding,
  type WorkBindingRequest,
} from "./composer-work-binding-reducer";

const work = (id: string): Work => ({ id, name: id.toUpperCase(), status: "active" }) as Work;
const request = (target = work("b"), intent: "change" | "undo" = "change"): WorkBindingRequest => ({
  id: "request-1",
  target,
  previousWorkId: "a",
  intent,
  origin: "direct-panel",
  observedProjection: "none",
});

describe("composer Work binding reducer", () => {
  it("contains dismissal while changing and migrates the active surface", () => {
    let state = initialComposerWorkBindingState(work("a"));
    state = reduceComposerWorkBinding(state, { type: "surface.opened", surface: "direct" });
    state = reduceComposerWorkBinding(state, {
      type: "change.started",
      request: request(),
      message: "pending",
    });
    expect(reduceComposerWorkBinding(state, { type: "surface.dismissed" })).toBe(state);
    state = reduceComposerWorkBinding(state, { type: "layout.changed", layout: "overflow" });
    expect(state.view).toMatchObject({ kind: "changing", surface: "overflow", page: "works" });
  });

  it.each(["confirmed", "reconciled"])("uses one commit path for %s success", () => {
    let state = reduceComposerWorkBinding(initialComposerWorkBindingState(work("a")), {
      type: "change.started",
      request: request(),
      message: "pending",
    });
    state = reduceComposerWorkBinding(state, {
      type: "change.committed",
      requestId: "request-1",
      message: "done",
      commit: {
        threadId: "thread",
        previousWorkId: "a",
        work: work("b"),
        changed: true,
        preferenceChanged: false,
        undoWorkId: "a",
      },
    });
    expect(state).toMatchObject({
      view: { kind: "closed" },
      expectedLocalWorkId: "b",
      undo: { workId: "a", resultWorkId: "b" },
    });
  });

  it("consumes a local projection but announces and clears Undo for an external binding", () => {
    let state: ComposerWorkBindingState = {
      ...initialComposerWorkBindingState(work("a")),
      observed: { id: "b", name: "B" },
      expectedLocalWorkId: "b",
      undo: { workId: "a", resultWorkId: "b" },
    };
    state = reduceComposerWorkBinding(state, {
      type: "binding.observed",
      work: work("b"),
      message: "external",
    });
    expect(state.effects).toEqual([]);
    state = reduceComposerWorkBinding(state, {
      type: "binding.observed",
      work: work("c"),
      message: "external",
    });
    expect(state.undo).toBeNull();
    expect(state.effects.at(-1)).toMatchObject({ type: "announce", message: "external" });
  });

  it("records a conflicting projected binding while the request remains contained", () => {
    let state = reduceComposerWorkBinding(initialComposerWorkBindingState(work("a")), {
      type: "change.started",
      request: request(),
      message: "pending",
    });
    state = reduceComposerWorkBinding(state, {
      type: "binding.observed",
      work: work("c"),
      message: "external",
    });
    expect(state.view).toMatchObject({
      kind: "changing",
      request: { observedProjection: "other" },
    });
  });
});
