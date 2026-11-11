/** Local Discard and its one Undo: the notice's handle, and Ctrl+Z when a reviewing editor issued it. */
import {
  applySpanPatches,
  blocksEqual,
  composeGroups,
  recordRestorations,
  writeDiscardBlocks,
} from "@meridian/agent-edit/diff";
import type { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import type { DocumentSession } from "@/core/editor/document-session";
import type { DraftRoomRegistry } from "@/core/editor/draft-room-read";
import { readDraftRoom } from "@/core/editor/draft-room-read";
import type { CommandOutcome, DraftCommandState } from "./draft-command-owner";
import type { DiscardUndo } from "./draft-notices";
import type { TextTarget } from "./review-model";
import type { ReviewRuntime } from "./review-runtime";

const sameClicks = <T>(before: readonly T[], now: readonly T[]) =>
  before.length === now.length && before.every((click, index) => now[index] === click);

type Entry = {
  binding: {
    session: DocumentSession;
    runtime: ReviewRuntime;
    notices: Set<() => void>;
  } | null;
  users: number;
};

export function startDraftDiscardSession(input: {
  target: TextTarget;
  /**
   * The issuing host's editor, whose Ctrl+Z also takes it back; `notice`: the surface has no
   * editor. Either way the returned handle is the notice's Undo. Null: the surface's editor is
   * not reviewing this draft, so nothing is written.
   */
  history: Editor | "notice" | null;
  onNoticeEnd?: () => void;
  entry: Entry | undefined;
  registry: DraftRoomRegistry;
  active(): boolean;
  state(): DraftCommandState;
  setState(state: Partial<DraftCommandState>): void;
  textClicks(): readonly unknown[];
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
  const frame = editor ? binding.runtime.projectNow() : binding.runtime.state().frame;
  if (!frame) return null;
  if (
    target.kind === "groups" &&
    (!blocksEqual(frame.diff.base.blocks, target.frame.diff.base.blocks) ||
      !blocksEqual(frame.diff.draft.blocks, target.frame.diff.draft.blocks))
  ) {
    input.setState({ failure: { code: "discard-refused", serverCode: "review_updated" } });
    return null;
  }
  const ids = target.kind === "draft" ? frame.groups.map((group) => group.id) : target.groupIds;
  if (!ids.length || ids.some((id) => !frame.groups.some((group) => group.id === id))) return null;
  const doc = binding.session.document;
  const fragment = doc.getXmlFragment("prosemirror");
  const wholeClick = !editor && target.kind === "draft";
  const queued = wholeClick ? input.textClicks() : [];
  let changed = false;
  const onTextChange = () => {
    changed = true;
  };
  if (wholeClick) doc.on("update", onTextChange);
  if (!editor)
    for (const attached of binding.runtime.editors())
      yUndoPluginKey.getState(attached.state)?.undoManager.stopCapturing();
  // Its own origin, so the write is one stack item the notice can name.
  const origin = {};
  const history: Y.UndoManager = editor
    ? yUndoPluginKey.getState(editor.state).undoManager
    : new Y.UndoManager(fragment, { trackedOrigins: new Set(), captureTimeout: 0 });
  history.addTrackedOrigin(origin);
  recordRestorations(history);
  history.stopCapturing();
  let item: StackItem | null = null;
  const write = (): CommandOutcome => {
    doc.off("update", onTextChange);
    if (!input.active() || entry.binding !== binding || input.state().closed)
      return { kind: "blocked" };
    // A read room drops the writer's text: a revert written here would show, then never land.
    if (binding.session.getSnapshot().access === "read") {
      input.setState({ failure: { code: "discard-refused", serverCode: "read_only" } });
      return { kind: "change-refused", code: "read_only" };
    }
    const current = binding.runtime.projectNow();
    if (
      !current ||
      (wholeClick
        ? changed || !sameClicks(queued, input.textClicks())
        : !blocksEqual(frame.diff.base.blocks, current.diff.base.blocks) ||
          !blocksEqual(frame.diff.draft.blocks, current.diff.draft.blocks))
    ) {
      input.setState({ failure: { code: "discard-refused", serverCode: "review_updated" } });
      return { kind: "change-refused", code: "review_updated" };
    }
    const cut = wholeClick ? current : frame;
    const selected = wholeClick ? cut.groups.map((group) => group.id) : ids;
    const blocks = applySpanPatches(
      cut.diff.draft.blocks,
      composeGroups(cut.doc.type.schema, cut, selected, "discard"),
      "draft",
    );
    const before = history.undoStack.length;
    try {
      doc.transact(() => writeDiscardBlocks(fragment, cut.doc.type.schema, blocks), origin);
    } finally {
      history.removeTrackedOrigin(origin);
    }
    history.stopCapturing();
    item = history.undoStack.length > before ? (history.undoStack.at(-1) ?? null) : null;
    binding.runtime.projectNow();
    if (item) watch();
    return { kind: "done" };
  };
  // The Undo holds while the draft's prose is as the Discard left it: a later edit, local or
  // remote, or Ctrl+Z taking it back ends it, so the notice and the editor never undo twice.
  let undoing = false;
  const onProse = (_events: unknown, transaction: Y.Transaction) => {
    if (!undoing && transaction.origin !== origin) end();
  };
  const onPopped = ({ stackItem }: { stackItem: StackItem }) => {
    if (!undoing && stackItem === item) end();
  };
  let watching = false;
  let stopAccess = () => {};
  const watch = () => {
    watching = true;
    fragment.observeDeep(onProse);
    history.on("stack-item-popped", onPopped);
    // A room that turns read-only (its Work was archived) drops an Undo written into it.
    stopAccess = binding.session.subscribe((snapshot) => {
      if (snapshot.access === "read") queueMicrotask(end);
    });
  };
  const unwatch = () => {
    if (!watching) return;
    watching = false;
    fragment.unobserveDeep(onProse);
    history.off("stack-item-popped", onPopped);
    stopAccess();
  };
  const lease = readDraftRoom(input.registry, binding.session.roomKey);
  entry.users++;
  let active = true;
  let pending = !editor;
  let settle!: (outcome: CommandOutcome) => void;
  const outcome = new Promise<CommandOutcome>((resolve) => {
    settle = resolve;
  });
  const finish = (answer: CommandOutcome) => {
    doc.off("update", onTextChange);
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
  const end = () => {
    if (!active) return;
    active = false;
    binding.notices.delete(end);
    release();
    onNoticeEnd?.();
  };
  binding.notices.add(end);
  const handle: DiscardUndo = {
    end,
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
        input.state().closed ||
        binding.session.getSnapshot().access === "read"
      ) {
        end();
        return { answer: "gone", landed: none };
      }
      const stackItem = item;
      undoing = true;
      try {
        if (history.undoStack.at(-1) === stackItem && !(editor?.isDestroyed ?? false))
          history.undo();
        else undoAlone(fragment, stackItem, history);
      } catch {
        return { answer: "failed", landed: none };
      } finally {
        undoing = false;
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
    discarding: (change) => change.frame?.diff === frame.diff && ids.includes(change.id),
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
 * Undoes one stack item whatever sits above it in its history (the reviewing editor went away
 * with its manager): a manager of its own pops it, with restorations recorded as any Undo does.
 */
function undoAlone(fragment: Y.XmlFragment, stackItem: StackItem, owner: Y.UndoManager) {
  const at = owner.undoStack.indexOf(stackItem);
  if (at >= 0) owner.undoStack.splice(at, 1);
  const alone = new Y.UndoManager(fragment, { trackedOrigins: new Set(), captureTimeout: 0 });
  recordRestorations(alone);
  alone.undoStack.push(stackItem);
  try {
    alone.undo();
  } finally {
    alone.destroy();
  }
}
