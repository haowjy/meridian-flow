/** Local Discard and its one Undo: the notice's handle, and Ctrl+Z when a reviewing editor issued it. */
import {
  applySpanPatches,
  composeGroups,
  recordRestorations,
  writeDiscardBlocks,
} from "@meridian/agent-edit/diff";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import type { DocumentSession } from "@/core/editor/document-session";
import type { DraftRoomRegistry } from "@/core/editor/draft-room-read";
import { readDraftRoom } from "@/core/editor/draft-room-read";
import { endUndoStep } from "@/core/editor/editor-history";
import { markStepDone, touchedSince } from "@/core/editor/touched-since";
import type { CommandOutcome, DraftCommandState } from "./draft-command-owner";
import type { DiscardUndo } from "./draft-notices";
import { readChosen } from "./review-frame";
import type { GroupsTarget } from "./review-model";
import type { ReviewRuntime } from "./review-runtime";

type Entry = {
  ref: { documentId: string };
  binding: {
    session: DocumentSession;
    runtime: ReviewRuntime;
    notices: Set<() => void>;
  } | null;
  users: number;
};

export function startDraftDiscardSession(input: {
  target: GroupsTarget;
  /**
   * The issuing host's editor, whose Ctrl+Z also takes it back; `notice`: the surface has no
   * editor. Either way the returned handle is the notice's Undo. Null: the surface's editor is
   * not reviewing this draft, so nothing is written.
   */
  history: Editor | "notice" | null;
  /**
   * `leftOut`: the Discard stays written, and this many of its changes can no longer come back.
   * None: it was never written, was taken back, or Ctrl+Z dropped it (said on the draft's line).
   */
  onNoticeEnd?: (leftOut?: number) => void;
  entry: Entry | undefined;
  registry: DraftRoomRegistry;
  active(): boolean;
  state(): DraftCommandState;
  setState(state: Partial<DraftCommandState>): void;
  releaseIdle(): void;
}): { handle: DiscardUndo | null; outcome: Promise<CommandOutcome> } | null {
  const { target, history: owner, onNoticeEnd, entry } = input;
  const editor = owner === "notice" ? null : owner;
  const binding = entry?.binding;
  if (
    owner === null ||
    !input.active() ||
    !entry ||
    !binding?.runtime.state().ready ||
    input.state().discarding
  )
    return null;
  const chosen = target.groupIds;
  if (!chosen.length) return null;
  const doc = binding.session.document;
  const fragment = doc.getXmlFragment("prosemirror");
  if (!editor) for (const attached of binding.runtime.editors()) endUndoStep(attached.state);
  // Its own origin, so the write is one stack item the notice can name.
  const origin = {};
  const steps = editor ? binding.session.history : null;
  const history: Y.UndoManager =
    steps?.manager ?? new Y.UndoManager(fragment, { trackedOrigins: new Set(), captureTimeout: 0 });
  history.addTrackedOrigin(origin);
  recordRestorations(history);
  history.stopCapturing();
  let item: StackItem | null = null;
  let changes = 0;
  const write = (): CommandOutcome => {
    if (!input.active() || entry.binding !== binding || input.state().ended)
      return { kind: "blocked" };
    // A read room drops the writer's text: a revert written here would show, then never land.
    if (binding.session.getSnapshot().access === "read") {
      input.setState({ failure: { code: "discard-refused", serverCode: "read_only" } });
      return { kind: "change-refused", code: "read_only" };
    }
    // The room may have moved since the click (Live typing reaching the base, a remote edit):
    // write the chosen changes as it names them now. One it can't name for certain stays in the draft.
    const current = binding.runtime.projectNow();
    if (!current) return { kind: "blocked" };
    const { going, stayed } = readChosen(target.frame, current, chosen);
    if (!going.length) {
      input.setState({
        failure: { code: "discard-refused", serverCode: "left_out_not_in_draft" },
      });
      return { kind: "change-refused", code: "left_out_not_in_draft" };
    }
    const ids = going.map((pair) => pair.read);
    const blocks = applySpanPatches(
      current.diff.draft.blocks,
      composeGroups(current.doc.type.schema, current, ids, "discard"),
      "draft",
    );
    const before = history.undoStack.length;
    try {
      doc.transact(() => writeDiscardBlocks(fragment, current.doc.type.schema, blocks), origin);
    } finally {
      history.removeTrackedOrigin(origin);
    }
    if (stayed.length)
      input.setState({
        failure: { code: "discard-refused", serverCode: "left_out_not_in_draft" },
      });
    history.stopCapturing();
    item = history.undoStack.length > before ? (history.undoStack.at(-1) ?? null) : null;
    changes = ids.length;
    binding.runtime.projectNow();
    if (item) {
      markStepDone(doc, item);
      // Ctrl+Z follows the notice's rule: a step whose text was edited since is dropped, not run.
      // Its line shows where Ctrl+Z's results do, so it is said even with the notice gone.
      steps?.guard(item, () => {
        end();
        input.setState({ failure: { code: "undo-left-out", leftOut: changes } });
      });
      watch();
    }
    return { kind: "done" };
  };
  // The Undo holds while what the Discard wrote and deleted stays as it left it, checked when
  // it is pressed: an edit since into or beside that text, or deleting the block that holds it,
  // means undoing would restore nothing or the same text twice. Edits elsewhere in the draft
  // (Live typing reaching it) leave it standing. Ctrl+Z taking it back ends the notice's share,
  // so the two never undo twice.
  const onPopped = ({ stackItem }: { stackItem: StackItem }) => {
    if (stackItem === item) end();
  };
  let watching = false;
  let stopAccess = () => {};
  const watch = () => {
    watching = true;
    history.on("stack-item-popped", onPopped);
    // A room that turns read-only (its Work was archived) drops an Undo written into it.
    stopAccess = binding.session.subscribe((snapshot) => {
      if (snapshot.access === "read") queueMicrotask(expire);
    });
  };
  const unwatch = () => {
    if (!watching) return;
    watching = false;
    history.off("stack-item-popped", onPopped);
    stopAccess();
  };
  const lease = readDraftRoom(input.registry, {
    roomKey: binding.session.roomKey,
    documentId: entry.ref.documentId,
  });
  entry.users++;
  let active = true;
  let pending = !editor;
  let settle!: (outcome: CommandOutcome) => void;
  const outcome = new Promise<CommandOutcome>((resolve) => {
    settle = resolve;
  });
  const finish = (answer: CommandOutcome) => {
    input.setState({ discarding: null });
    settle(answer);
  };
  let released = false;
  const release = () => {
    if (pending || active || released) return;
    released = true;
    unwatch();
    // The editor's history is the editor's; only the notice's own manager ends here.
    if (!editor) history.destroy();
    lease.dispose();
    entry.users--;
    input.releaseIdle();
  };
  const end = (leftOut?: number) => {
    if (!active) return;
    active = false;
    binding.notices.delete(expire);
    release();
    onNoticeEnd?.(leftOut);
  };
  const expire = () => end(changes);
  binding.notices.add(expire);
  const take = (stackItem: StackItem) => {
    if (steps) steps.take(stackItem);
    else history.undoStack.splice(history.undoStack.indexOf(stackItem), 1);
  };
  const handle: DiscardUndo = {
    end: () => end(),
    undo: () => {
      const none = Promise.resolve();
      if (!active) return { answer: "gone", landed: none };
      if (pending) {
        pending = false;
        cancelAnimationFrame(paintFrame);
        document.removeEventListener("visibilitychange", onVisibility);
        finish({ kind: "done" });
        end();
        return { answer: "ok", landed: none };
      }
      if (
        !item ||
        !input.active() ||
        entry.binding !== binding ||
        input.state().ended ||
        binding.session.getSnapshot().access === "read" ||
        touchedSince(doc, item)
      ) {
        if (item) take(item);
        end();
        return { answer: "gone", landed: none, leftOut: changes };
      }
      try {
        undoAlone(fragment, item, take);
      } catch {
        return { answer: "failed", landed: none };
      }
      binding.runtime.projectNow();
      // The prose is back in the room, which sends it whenever it can and drains unsent edits
      // before it closes; its acknowledgement fails only once the room itself has ended.
      // slop-lint: allow swallowed-error a rejection means the room ended, which ends the notice
      const landed = binding.session.whenCurrentChangesAcknowledged().catch(() => undefined);
      end();
      return { answer: "ok", landed };
    },
  };
  if (editor) {
    // A new command replaces what the last one left on the draft, as the dock's does below.
    input.setState({ failure: null });
    const answer = write();
    if (answer.kind !== "done" || !item) end();
    return {
      handle: answer.kind === "done" && item ? handle : null,
      outcome: Promise.resolve(answer),
    };
  }
  const commit = () => {
    if (!pending) return;
    pending = false;
    cancelAnimationFrame(paintFrame);
    document.removeEventListener("visibilitychange", onVisibility);
    try {
      const answer = write();
      finish(answer);
      if (answer.kind !== "done" || !item) end();
    } catch {
      input.setState({ failure: { code: "discard-unknown" } });
      finish({ kind: "change-refused", code: "discard-unknown" });
      end();
    }
    release();
  };
  input.setState({
    discarding: (change) => change.frame?.diff === target.frame.diff && chosen.includes(change.id),
    failure: null,
  });
  let paintFrame = 0;
  const onVisibility = () => {
    if (document.visibilityState === "hidden") commit();
  };
  document.addEventListener("visibilitychange", onVisibility);
  if (document.visibilityState === "hidden") setTimeout(commit, 0);
  else
    paintFrame = requestAnimationFrame(() => {
      paintFrame = requestAnimationFrame(() => {
        paintFrame = requestAnimationFrame(commit);
      });
    });
  return { outcome, handle };
}

type StackItem = Y.UndoManager["undoStack"][number];

/**
 * Undoes one stack item whatever its history holds above it: `take` lifts it out, and a manager of
 * its own pops it, with restorations recorded as any Undo does.
 */
function undoAlone(
  fragment: Y.XmlFragment,
  stackItem: StackItem,
  take: (stackItem: StackItem) => void,
) {
  take(stackItem);
  const alone = new Y.UndoManager(fragment, { trackedOrigins: new Set(), captureTimeout: 0 });
  recordRestorations(alone);
  alone.undoStack.push(stackItem);
  try {
    alone.undo();
  } finally {
    alone.destroy();
  }
}
