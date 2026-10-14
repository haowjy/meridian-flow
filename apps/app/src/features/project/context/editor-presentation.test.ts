import { expect, it } from "vitest";
import { resolveEditorFrame, resolveEditorPresentation } from "./editor-presentation";

const old = {
  editorWorkId: "old-work",
  activeContextScheme: "manuscript",
  activeContextPath: "Old",
};
const next = { editorWorkId: "new-work", activeContextScheme: "kb", activeContextPath: "New" };

it("a warm navigation whose read fails frames the requested destination; off-screen keeps the warm route", () => {
  const { mounted } = resolveEditorPresentation({
    current: next,
    prior: old,
    requestedWorkId: "new-work",
    screen: "context",
    contextLive: false,
    issue: "error",
  });
  expect(mounted).toBe(old);
  expect(resolveEditorFrame({ screen: "context", requested: next, mounted })).toEqual(next);
  expect(resolveEditorFrame({ screen: "chat", requested: next, mounted })).toEqual(old);
});
