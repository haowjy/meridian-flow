// The model's undo, revert and edit list over one document's stack.

import { randomUUID } from "node:crypto";
import type { DocumentEditResult, ModelInverseCommand } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts";
import { FileEditRefusedError } from "../../file-policy/index.js";
import { deltaExcerpt } from "./edit-excerpt.js";
import { partKey as key } from "./inverse-actions.js";
import type { InverseStep } from "./inverse-stream.js";
import { textOmission, textPlanRefusal } from "./model-inverse-presentation.js";
import { type Entry, entries, inspectionActions } from "./model-inverse-selection.js";
import { createReversalPlanner, type ModelInverseQuery } from "./model-reversal-planner.js";
import type {
  InverseCommitted,
  InverseDocument,
  StoredInversePart,
  TurnInverseStore,
} from "./turn-inverse-service.js";

/** A selection with steps: its answer once the command committed them. */
type Planned = {
  status: "planned";
  steps: InverseStep[];
  answer(committed: InverseCommitted): DocumentEditResult;
};

export function createModelInversePolicy(store: TurnInverseStore) {
  /**
   * The command's steps, each taken back on what the ones before it leave, or the answer when
   * there is nothing to take.
   */
  function plan(
    document: InverseDocument | undefined,
    query: ModelInverseQuery,
    command: ModelInverseCommand,
  ): DocumentEditResult | Planned {
    if (!document) return { status: "document_not_found", message: "File not found." };
    const policy = createReversalPlanner(document, query);
    const own = policy.own,
      actionId = randomUUID();
    const steps: InverseStep[] = [],
      stepEntries: { kind: "undo" | "revert"; handle: string }[] = [],
      skipped: string[] = [],
      partial: string[] = [];
    let selected = 0,
      compacted = 0;
    const count = command.command === "revert" ? 1 : (command.count ?? 1);
    const undoEntries = command.command === "undo" ? policy.actions.stack.slice(0, count) : [];
    if (command.command === "undo" && undoEntries.length < count)
      return undoEntries.length
        ? {
            status: "insufficient_undo",
            message: `Only ${undoEntries.length} ${undoEntries.length === 1 ? "edit" : "edits"} to undo in ${document.uri}; requested ${count}. Nothing was changed.`,
          }
        : {
            status: "nothing_to_undo",
            message: `You have no edits to undo in ${document.uri}. Nothing was changed.`,
          };
    /**
     * One step per original edit, in the order the command takes them: an undo's each its own
     * action; a revert's the command's.
     */
    const stepAction = (kind: "undo" | "revert") =>
      kind === "undo" && steps.length ? randomUUID() : actionId;
    const apply = (entry: Entry, selection: StoredInversePart[], kind: "undo" | "revert") => {
      selected += selection.length;
      const took = policy.takeOut(selection);
      compacted += took.compacted;
      if (!took.taken.length) return;
      stepEntries.push({ kind, handle: entry.handle });
      steps.push({
        actionId: stepAction(kind),
        actionKind: kind,
        at: Math.max(...entry.parts.map((part) => part.id)),
        parts: took.taken,
        rooms: took.rooms,
      });
    };
    const modelTextPlan = (entry: Entry, direction: "undo" | "revert") => {
      const planned = policy.textPlan(entry, direction);
      if (planned.failure) return textPlanRefusal(planned.failure);
      return {
        selection: planned.selection,
        actionKind: planned.actionKind as "undo" | "revert",
        omissions: planned.omissions.map((omission) =>
          textOmission(entry.handle, direction, omission),
        ),
        compacted: planned.omissions.filter((omission) => omission.cause === "compacted").length,
      };
    };
    if (command.command === "revert") {
      const entry = own.find((entry) => entry.handle === command.edit);
      if (!entry)
        return {
          status: "invalid_write",
          message: `Unknown edit ${command.edit} in ${document.uri}. The handles are listed by format: "edits".`,
        };
      const textPlan = modelTextPlan(entry, "revert");
      if ("status" in textPlan) return textPlan;
      skipped.push(...textPlan.omissions);
      if (!textPlan.selection.length)
        return {
          status: "nothing_to_revert",
          message: `Nothing was reverted: none of ${entry.handle} remains to revert in ${document.uri}.\nnot reverted: ${skipped.join("\nnot reverted: ")}`,
        };
      apply(entry, textPlan.selection, "revert");
    } else
      for (let n = 0; n < count; n++) {
        const entry = undoEntries[n];
        if (!entry) throw new Error("Captured undo selection changed while planning");
        const textPlan = modelTextPlan(entry, "undo");
        if ("status" in textPlan) return textPlan;
        partial.push(...textPlan.omissions);
        if (!textPlan.selection.length) return cantUndo(entry.handle, textPlan.compacted);
        apply(entry, textPlan.selection, textPlan.actionKind);
      }
    // Every part the selection named stayed: the room cut their history since it judged them.
    if (!steps.length) {
      const first =
        command.command === "revert"
          ? own.find((entry) => entry.handle === command.edit)
          : undoEntries[0];
      return command.command === "revert"
        ? {
            status: "nothing_to_revert",
            message: `Nothing was reverted: none of ${first?.handle} remains to revert in ${document.uri}.${skipped.map((reason) => `\nnot reverted: ${reason}`).join("")}`,
          }
        : cantUndo(first?.handle ?? "", compacted);
    }
    const parts = steps.reduce((n, step) => n + step.parts.length, 0);
    const performed = (kind: "undo" | "revert") => [
      ...new Set(stepEntries.filter((entry) => entry.kind === kind).map((entry) => entry.handle)),
    ];
    return {
      status: "planned",
      steps,
      answer: (committed) => ({
        status: "success",
        updates: committed.updates,
        ...(command.command === "revert" ? { writeId: committed.handles[0] } : {}),
        message: [
          command.command === "revert"
            ? `reverted: ${stepEntries[0]?.handle} (${parts} of ${selected + skipped.length} parts)${skipped.map((reason) => `\nnot reverted: ${reason}`).join("")}`
            : [
                ...(performed("undo").length ? [`undone: ${performed("undo").join(", ")}`] : []),
                ...(performed("revert").length
                  ? [`reverted: ${performed("revert").join(", ")}`]
                  : []),
              ].join("\n") +
              (partial.length || parts < selected
                ? ` (${parts} of ${selected + partial.length} parts)`
                : ""),
          ...partial.map((reason) => `not undone: ${reason}`),
          ...(committed.inManuscript
            ? [
                "The manuscript still has the text: it was applied before this. The draft now differs from it there, and Review changes shows that as a change.",
              ]
            : []),
        ].join("\n"),
      }),
    };
  }
  function listEdits(
    document: InverseDocument,
    query: ModelInverseQuery,
    before: string | undefined,
  ): DocumentEditResult {
    const policy = createReversalPlanner(document, query);
    const own = policy.own,
      topEntry = policy.actions.top;
    if (before && !own.some((entry) => entry.handle === before))
      return {
        status: "invalid_write",
        message: `Unknown edit ${before} in ${document.uri}. The handles are listed by format: "edits" without before.`,
      };
    const older = own.filter(
        (entry) => !before || Number(entry.handle.slice(1)) < Number(before.slice(1)),
      ),
      page = older.slice(0, 20);
    const index = policy.actions.actions;
    const rows = page.map((entry) => {
      const undos = index.actions.filter((action) =>
        entry.parts.some((part) => action.targets.has(key(part))),
      );
      const popped = index.byPart;
      const fullyUndone = entry.parts.every((part) => popped.has(key(part)));
      const state = fullyUndone
        ? undos.some((undo) =>
            undo.parts.some((part) => part.actor !== "agent" || part.threadId !== query.threadId),
          )
          ? "undone by the user"
          : "undone"
        : entry.parts.some((part) => policy.unavailable(part) === "compacted")
          ? "too old to undo"
          : "live";
      const revertPlan = policy.textPlan(entry, "revert");
      const revert = "failure" in revertPlan ? 0 : revertPlan.selection.length;
      const command = revert
        ? revert === entry.parts.length
          ? "revert"
          : `revert ${revert} of ${entry.parts.length}`
        : "none";
      const excerpt = deltaExcerpt(entry.parts[0].delta);
      const summary =
        excerpt.before && excerpt.after
          ? `${JSON.stringify(excerpt.before)} → ${JSON.stringify(excerpt.after)}`
          : excerpt.after
            ? `+ ${JSON.stringify(excerpt.after)}`
            : `− ${JSON.stringify(excerpt.before)}`;
      return {
        entry,
        text: `${entry.handle}  ${entry.parts[0].turnId === query.turnId ? "this turn" : "earlier turn"}  ${state}  ${summary}${entry.parts.length > 1 ? ` and ${entry.parts.length - 1} more` : ""}`,
        command,
      };
    });
    // Last: a preview takes the top entry back on the read's copies, which the rows read above.
    const undoable =
      topEntry &&
      plan(document, query, {
        command: "undo",
        file: document.uri,
        documentId: document.documentId,
      }).status === "planned";
    const lines = rows.map(
      ({ entry, text, command }) =>
        `${text}  ${undoable && entry.id === topEntry?.id ? "undo" : command}`,
    );
    return {
      status: "success",
      message: [
        `your edits to ${document.uri}, newest first (version: ${versionOf(document)})`,
        ...lines,
        ...(older.length > 20 ? [`more: before ${page.at(-1)?.handle}`] : []),
      ].join("\n"),
    };
  }
  return {
    /**
     * The write ordinals of the model's text edits Undo would take, newest first: what a tree
     * receipt of the same document is ordered against.
     */
    async modelStack(documentId: DocumentId, threadId: string) {
      const history = await store.readHistory(documentId, threadId);
      const inspection = inspectionActions(history, entries(history, threadId));
      const ordinal = (handle: string) => Number(handle.slice(1));
      return {
        undo: inspection.stack.map((entry) => ordinal(entry.handle)),
      };
    },
    async modelInverse(
      query: ModelInverseQuery,
      command: ModelInverseCommand,
    ): Promise<DocumentEditResult> {
      try {
        const { value, committed } = await store.run(
          { query, kind: command.command },
          async (documents) => {
            const planned = plan(documents[0], query, command);
            return {
              steps:
                planned.status === "planned"
                  ? planned.steps.map((step) => ({ document: documents[0], step }))
                  : [],
              value: planned,
            };
          },
        );
        if (value.status !== "planned") return value;
        if (!committed) throw new Error("A planned inverse committed nothing");
        return value.answer(committed);
      } catch (cause) {
        if (cause instanceof FileEditRefusedError)
          return {
            status: "permission_denied",
            message: "This change is no longer editable.",
          };
        throw cause;
      }
    },
    modelEdits(query: ModelInverseQuery, before?: string): Promise<DocumentEditResult> {
      return store.read(query, async (documents) =>
        documents[0]
          ? listEdits(documents[0], query, before)
          : { status: "document_not_found", message: "File not found." },
      );
    },
  };
}

/** An undo that took nothing: an Undo took the edit's parts, or the room cut their history. */
const cantUndo = (handle: string, compacted: number): DocumentEditResult =>
  compacted > 0
    ? {
        status: "expired",
        message: `Can't undo ${handle}: the document no longer keeps history that old, so it stays as it is. Nothing was changed.`,
      }
    : {
        status: "nothing_to_undo",
        message: `${handle} is already undone. Nothing was changed.`,
      };

/** The version the chat writes this document in, as the model names it. */
const versionOf = (document: InverseDocument) =>
  document.room.kind === "fork" ? ("draft" as const) : ("live" as const);
