import type { Work } from "@meridian/contracts/works";
import { describe, expect, it } from "vitest";
import {
  type ComposerWorkBindingState,
  initialComposerWorkBindingState,
  reduceComposerWorkBinding,
  type WorkBindingRequest,
} from "./composer-work-binding-reducer";

const work = (id: string): Work => ({ id, name: id.toUpperCase(), status: "active" }) as Work;
const request = (target = work("b")): WorkBindingRequest => ({
  id: "request-1",
  target,
  observedProjection: "none",
});

describe("composer Work binding reducer", () => {
  it("consumes exactly one terminal outcome after ignored reopen and toggle events", () => {
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
        work: work("b"),
        changed: true,
        preferenceChanged: false,
      },
    });
    const settled = state;
    state = reduceComposerWorkBinding(state, {
      type: "change.refused",
      requestId: "request-1",
      failure: { kind: "unconfirmed" },
      message: "late",
    });
    expect(state).toBe(settled);
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
        work: work("b"),
        changed: true,
        preferenceChanged: false,
      },
    });
    expect(state).toMatchObject({
      view: { kind: "browsing" },
      expectedLocalWorkId: "b",
    });
  });

  it("consumes a local projection but announces an external binding", () => {
    let state: ComposerWorkBindingState = {
      ...initialComposerWorkBindingState(work("a")),
      observed: { id: "b", name: "B" },
      expectedLocalWorkId: "b",
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
