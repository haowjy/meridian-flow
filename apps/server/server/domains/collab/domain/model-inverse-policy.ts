// Per-document model stacks over immutable edits, with all-or-nothing action planning.

import { randomUUID } from "node:crypto";
import {
  type DocumentEditResult,
  type ModelInverseCommand,
  storedPendingTurns,
  writeVerdict,
} from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { FileEditRefusedError } from "../../file-policy/index.js";
import { partKey as key } from "./inverse-actions.js";
import type { InverseStep } from "./inverse-stream.js";
import { textOmission, textPlanRefusal } from "./model-inverse-presentation.js";
import { type Entry, entries, inspectionActions } from "./model-inverse-selection.js";
import { createCapturedReversalPlanner, type ModelInverseQuery } from "./model-reversal-planner.js";
import type {
  InverseDocument,
  StoredInversePart,
  TurnInverseStore,
} from "./turn-inverse-service.js";

const schema = buildDocumentSchema();

export function createModelInversePolicy(store: TurnInverseStore) {
  type ModelPlanPreview = { status: "planned" };
  async function plan(
    document: InverseDocument | undefined,
    query: ModelInverseQuery,
    command: ModelInverseCommand,
    preview = false,
  ): Promise<DocumentEditResult | ModelPlanPreview> {
    if (!document)
      return {
        status: "document_not_found",
        message: "File not found. Read the project to find the right path.",
      };
    const policy = createCapturedReversalPlanner(document, query);
    const own = policy.own,
      actionId = randomUUID();
    const steps: InverseStep[] = [],
      stepEntries: { kind: "undo" | "revert"; handle: string }[] = [],
      skipped: string[] = [],
      partial: string[] = [];
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
      stepEntries.push({ kind, handle: entry.handle });
      steps.push({
        destination: document.destination,
        actionId: stepAction(kind),
        actionKind: kind,
        at: Math.max(...entry.parts.map((part) => part.id)),
        parts: selection,
      });
      policy.planTakeOut(selection);
    };
    const modelTextPlan = (entry: Entry, direction: "undo" | "revert") => {
      const planned = policy.textPlan(entry, direction);
      if (planned.failure) return textPlanRefusal(document.uri, entry.handle, planned.failure);
      return {
        selection: planned.selection,
        actionKind: planned.actionKind as "undo" | "revert",
        omissions: planned.omissions.map((omission) =>
          textOmission(entry.handle, direction, omission),
        ),
      };
    };
    if (command.command === "revert") {
      const entry = own.find((entry) => entry.handle === command.edit);
      if (!entry)
        return {
          status: "invalid_write",
          message: `Unknown edit ${command.edit} in ${document.uri}. Read with format: "edits" for a valid handle.`,
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
        if (!textPlan.selection.length)
          return {
            status: "cant_undo_changed",
            message: `Can't undo ${entry.handle}: none of that edit remains unchanged. Nothing was changed.`,
          };
        apply(entry, textPlan.selection, textPlan.actionKind);
      }
    if (!steps.length)
      return {
        status: "nothing_to_revert",
        message: `Nothing is left to reverse in ${document.uri}. Nothing was changed.`,
      };
    const inversePlan = { document, steps };
    if (preview) return { status: "planned" };
    const committed = await store.commit({
      query,
      kind: command.command,
      plans: [inversePlan],
      sequence: steps.map((step) => ({ plan: inversePlan, step })),
    });
    // The answer is what the commit took: it plans again under the locks, and a write since the
    // capture can leave a step less, or nothing, to take.
    const planned = steps.reduce((n, step) => n + step.parts.length, 0);
    const took = stepEntries.filter((_, i) => (committed.taken[i] ?? 0) > 0);
    const parts = committed.taken.reduce((n, taken) => n + taken, 0);
    if (!took.length) {
      const [first] = stepEntries;
      return command.command === "revert"
        ? {
            status: "nothing_to_revert",
            message: `Nothing was reverted: none of ${first?.handle} remains to revert in ${document.uri}.${skipped.map((reason) => `\nnot reverted: ${reason}`).join("")}`,
          }
        : {
            status: "cant_undo_changed",
            message: `Can't undo ${first?.handle}: none of that edit remains unchanged. Nothing was changed.`,
          };
    }
    const performed = (kind: "undo" | "revert") => [
      ...new Set(took.filter((entry) => entry.kind === kind).map((entry) => entry.handle)),
    ];
    return {
      status: "success",
      actionId,
      room: document.liveRoom,
      ...(committed.cut ?? {}),
      updates: committed.updates,
      destination: "live" as const,
      ...(command.command === "revert" ? { writeId: committed.handles[0] } : {}),
      message: [
        command.command === "revert"
          ? `reverted: ${took[0]?.handle} (${parts} of ${planned + skipped.length} parts)${skipped.map((reason) => `\nnot reverted: ${reason}`).join("")}`
          : [
              ...(performed("undo").length ? [`undone: ${performed("undo").join(", ")}`] : []),
              ...(performed("revert").length
                ? [`reverted: ${performed("revert").join(", ")}`]
                : []),
            ].join("\n") +
            (partial.length || parts < planned
              ? ` (${parts} of ${planned + partial.length} parts)`
              : ""),
        ...partial.map((reason) => `not undone: ${reason}`),
      ].join("\n"),
    };
  }
  return {
    /**
     * The write ordinals of the model's text edits Undo would take, newest first: what a tree
     * receipt of the same document is ordered against.
     */
    async modelStack(documentId: DocumentId, threadId: string) {
      const history = await store.readHistory(documentId);
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
        return await store.withCapturedDocuments(query, async (documents) => {
          const result = await plan(documents[0], query, command);
          if (result.status === "planned") throw new Error("Execution returned a plan preview");
          return result;
        });
      } catch (cause) {
        if (cause instanceof FileEditRefusedError)
          return {
            status: "permission_denied",
            message: "This change is no longer editable.",
          };
        throw cause;
      }
    },
    async modelEdits(query: ModelInverseQuery, before?: string): Promise<DocumentEditResult> {
      return store.withCapturedDocuments(query, async (documents) => {
        const document = documents[0];
        if (!document)
          return {
            status: "document_not_found",
            message: "File not found. Check the path with ls.",
          };
        const policy = createCapturedReversalPlanner(document, query),
          own = policy.own,
          topEntry = policy.actions.top;
        if (before && !own.some((entry) => entry.handle === before))
          return {
            status: "invalid_write",
            message: `Unknown edit ${before} in ${document.uri}. Read with format: "edits" without before for valid handles.`,
          };
        const older = own.filter(
            (entry) => !before || Number(entry.handle.slice(1)) < Number(before.slice(1)),
          ),
          page = older.slice(0, 20);
        const undo = topEntry
          ? await plan(
              document,
              query,
              { command: "undo", file: document.uri, documentId: document.documentId },
              true,
            )
          : null;
        const index = policy.actions.actions;
        // A write whose turn still has suggestions here is pending, not Live.
        const pending = storedPendingTurns(document.live, schema);
        const suggesting = (turnId: string | null | undefined) => !!turnId && pending.has(turnId);
        const lines = await Promise.all(
          page.map(async (entry) => {
            const undos = index.actions.filter((action) =>
              entry.parts.some((part) => action.targets.has(key(part))),
            );
            const popped = index.byPart;
            const fullyUndone = entry.parts.every((part) => popped.has(key(part)));
            // What the writer did with the suggestions each part left: the model reads Apply and
            // Discard apart from an edit of its text.
            const verdicts = entry.parts.map((part) =>
              writeVerdict(document.live, part.effect.inserted),
            );
            const applied = verdicts.filter((verdict) => verdict === "applied").length;
            const state = fullyUndone
              ? undos.some((undo) =>
                  undo.parts.some(
                    (part) => part.actor !== "agent" || part.threadId !== query.threadId,
                  ),
                )
                ? "undone by the user"
                : "undone"
              : applied
                ? applied === entry.parts.length
                  ? "applied"
                  : `partly applied (${applied} of ${entry.parts.length})`
                : verdicts.every((verdict) => verdict === "discarded")
                  ? "discarded"
                  : entry.parts.some((part) => policy.changed(part))
                    ? "changed"
                    : entry.parts.some((part) => suggesting(part.turnId))
                      ? "pending"
                      : "live";
            let command = "none";
            const revertPlan = policy.textPlan(entry, "revert");
            const revert = "failure" in revertPlan ? 0 : revertPlan.selection.length;
            if (revert)
              command =
                revert === entry.parts.length
                  ? "revert"
                  : `revert ${revert} of ${entry.parts.length}`;
            if (entry.id === topEntry?.id && undo?.status === "planned") command = "undo";
            const excerpt = await store.describePart(document, entry.parts[0]);
            const summary =
              excerpt.before && excerpt.after
                ? `${JSON.stringify(excerpt.before)} → ${JSON.stringify(excerpt.after)}`
                : excerpt.after
                  ? `+ ${JSON.stringify(excerpt.after)}`
                  : `− ${JSON.stringify(excerpt.before)}`;
            return `${entry.handle}  ${entry.parts[0].turnId === query.turnId ? "this turn" : "earlier turn"}  ${state}  ${summary}${entry.parts.length > 1 ? ` and ${entry.parts.length - 1} more` : ""}  ${command}`;
          }),
        );
        const shownVersion = suggesting(topEntry?.parts[0]?.turnId) ? "draft" : "live";
        return {
          status: "success",
          actionId: randomUUID(),
          room: null,
          message: [
            `your edits to ${document.uri}, newest first (version: ${shownVersion})`,
            ...lines,
            ...(older.length > 20 ? [`more: before ${page.at(-1)?.handle}`] : []),
          ].join("\n"),
        };
      });
    },
  };
}
