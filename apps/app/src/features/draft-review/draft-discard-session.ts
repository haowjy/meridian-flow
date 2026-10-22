/** Local Discard and its surface-owned undo session. */
import {
  applySpanPatches,
  blocksEqual,
  composeGroups,
  recordRestorations,
  writeDiscardBlocks,
} from "@meridian/agent-edit/diff";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import type { DocumentSession } from "@/core/editor/document-session";
import type { DraftRoomRegistry } from "@/core/editor/draft-room-read";
import { readDraftRoom } from "@/core/editor/draft-room-read";
import type { ApplyClickQueue } from "./apply-click-queue";
import type { CommandOutcome, DiscardNotice, DraftCommandState } from "./draft-command-owner";
import type { DraftRef } from "./review-command-types";
import type { TextTarget } from "./review-model";
import type { ReviewRuntime } from "./review-runtime";

const EDITOR_DISCARD_ORIGIN = Symbol("editor-draft-discard");
const sameClicks = <T>(before: readonly T[], now: readonly T[]) =>
  before.length === now.length && before.every((click, index) => now[index] === click);

type Entry = {
  binding: {
    session: DocumentSession;
    runtime: ReviewRuntime;
    notices: Set<() => void>;
  } | null;
  users: number;
  item: { queue: ApplyClickQueue };
};

export function startDraftDiscardSession(input: {
  ref: DraftRef;
  target: TextTarget;
  surface: "editor" | "dock";
  onNoticeEnd?: () => void;
  entry: Entry | undefined;
  registry: DraftRoomRegistry;
  active(): boolean;
  state(): DraftCommandState;
  setState(state: Partial<DraftCommandState>): void;
  textClicks(entry: Entry): readonly unknown[];
  releaseIdle(entry: Entry): void;
}): { notice: DiscardNotice; outcome: Promise<CommandOutcome> } | null {
  const { ref, target, surface, onNoticeEnd, entry } = input;
  const binding = entry?.binding;
  if (!input.active() || !entry || !binding?.runtime.state().ready || input.state().discarding)
    return null;
  const frame = surface === "editor" ? binding.runtime.projectNow() : binding.runtime.state().frame;
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
  const editor = surface === "editor" ? binding.runtime.editor("editor") : null;
  if (surface === "editor" && !editor) return null;
  const doc = binding.session.document;
  const fragment = doc.getXmlFragment("prosemirror");
  const wholeClick = !editor && target.kind === "draft";
  const queued = wholeClick ? input.textClicks(entry) : [];
  let changed = false;
  const onTextChange = () => {
    changed = true;
  };
  if (wholeClick) doc.on("update", onTextChange);
  if (!editor)
    for (const surface of ["editor", "dock"] as const) {
      const attached = binding.runtime.editor(surface);
      if (attached) yUndoPluginKey.getState(attached.state)?.undoManager.stopCapturing();
    }
  const origin = editor ? EDITOR_DISCARD_ORIGIN : {};
  const history: Y.UndoManager = editor
    ? yUndoPluginKey.getState(editor.state).undoManager
    : new Y.UndoManager(fragment, { trackedOrigins: new Set(), captureTimeout: 0 });
  history.addTrackedOrigin(origin);
  recordRestorations(history);
  history.stopCapturing();
  const write = (): CommandOutcome => {
    doc.off("update", onTextChange);
    if (!input.active() || entry.binding !== binding || input.state().closed)
      return { kind: "blocked" };
    const current = binding.runtime.projectNow();
    if (
      !current ||
      (wholeClick
        ? changed || !sameClicks(queued, input.textClicks(entry))
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
    doc.transact(() => writeDiscardBlocks(fragment, cut.doc.type.schema, blocks), origin);
    history.stopCapturing();
    binding.runtime.projectNow();
    return { kind: "done" };
  };
  if (editor) {
    const outcome = write();
    return { notice: { kind: "discarded", end() {} }, outcome: Promise.resolve(outcome) };
  }
  const lease = readDraftRoom(input.registry, binding.session.roomKey);
  entry.users++;
  let active = true;
  let pending = true;
  let settle!: (outcome: CommandOutcome) => void;
  const outcome = new Promise<CommandOutcome>((resolve) => {
    settle = resolve;
  });
  const finish = (answer: CommandOutcome) => {
    doc.off("update", onTextChange);
    input.setState({ discarding: null });
    settle(answer);
  };
  const commit = () => {
    if (!pending) return;
    pending = false;
    cancelAnimationFrame(paintFrame);
    document.removeEventListener("visibilitychange", onVisibility);
    try {
      const answer = write();
      finish(answer);
      if (answer.kind !== "done") end();
    } catch {
      input.setState({ failure: { code: "discard-unknown" } });
      finish({ kind: "change-refused", code: "discard-unknown" });
      end();
    }
    release();
  };
  let released = false;
  const release = () => {
    if (pending || active || released) return;
    released = true;
    history.destroy();
    lease.dispose();
    entry.users--;
    input.releaseIdle(entry);
  };
  const end = () => {
    if (!active) return;
    active = false;
    binding.notices.delete(end);
    release();
    onNoticeEnd?.();
  };
  binding.notices.add(end);
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
  return {
    outcome,
    notice: {
      kind: "discarded",
      itemKey: ref.itemKey,
      end,
      undo: () => {
        if (!active || !input.active() || entry.binding !== binding || input.state().closed) {
          end();
          return Promise.resolve();
        }
        if (pending) {
          pending = false;
          cancelAnimationFrame(paintFrame);
          document.removeEventListener("visibilitychange", onVisibility);
          finish({ kind: "done" });
        } else {
          history.undo();
          binding.runtime.projectNow();
        }
        const acknowledged = binding.session.whenCurrentChangesAcknowledged();
        end();
        return acknowledged;
      },
    },
  };
}
