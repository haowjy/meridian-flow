import { randomUUID } from "node:crypto";
import type { DocumentEditResult, ModelInverseCommand } from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts";
import { FileEditRefusedError } from "../../file-policy/index.js";
import { deltaExcerpt } from "./edit-excerpt.js";
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
        message: "File not found.",
      };
    const policy = createCapturedReversalPlanner(document, query);
    try {
      return await planWith(document, policy, query, command, preview);
    } finally {
      policy.free();
    }
  }
  async function planWith(
    document: InverseDocument,
    policy: ReturnType<typeof createCapturedReversalPlanner>,
    query: ModelInverseQuery,
    command: ModelInverseCommand,
    preview: boolean,
  ): Promise<DocumentEditResult | ModelPlanPreview> {
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
    const stepAction = (kind: "undo" | "revert") =>
      kind === "undo" && steps.length ? randomUUID() : actionId;
    const apply = (entry: Entry, selection: StoredInversePart[], kind: "undo" | "revert") => {
      stepEntries.push({ kind, handle: entry.handle });
      steps.push({
        actionId: stepAction(kind),
        actionKind: kind,
        at: Math.max(...entry.parts.map((part) => part.id)),
        parts: selection,
      });
      policy.planTakeOut(selection);
    };
    const modelTextPlan = (entry: Entry, direction: "undo" | "revert") => {
      const planned = policy.textPlan(entry, direction);
      if (planned.failure) return textPlanRefusal(document.uri, planned.failure);
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
        : cantUndo(first?.handle ?? "", committed.compacted?.get(document.documentId) ?? 0);
    }
    const performed = (kind: "undo" | "revert") => [
      ...new Set(took.filter((entry) => entry.kind === kind).map((entry) => entry.handle)),
    ];
    return {
      status: "success",
      actionId,
      room: null,
      updates: committed.updates,
      destination: versionOf(document),
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
        ...(committed.inManuscript
          ? [
              "The manuscript still has the text: it was applied before this. The draft now differs from it there, and Review changes shows that as a change.",
            ]
          : []),
      ].join("\n"),
    };
  }
  async function listEdits(
    document: InverseDocument,
    policy: ReturnType<typeof createCapturedReversalPlanner>,
    query: ModelInverseQuery,
    before: string | undefined,
  ): Promise<DocumentEditResult> {
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
    const undo = topEntry
      ? await plan(
          document,
          query,
          { command: "undo", file: document.uri, documentId: document.documentId },
          true,
        )
      : null;
    const index = policy.actions.actions;
    const lines = await Promise.all(
      page.map(async (entry) => {
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
        let command = "none";
        const revertPlan = policy.textPlan(entry, "revert");
        const revert = "failure" in revertPlan ? 0 : revertPlan.selection.length;
        if (revert)
          command =
            revert === entry.parts.length ? "revert" : `revert ${revert} of ${entry.parts.length}`;
        if (entry.id === topEntry?.id && undo?.status === "planned") command = "undo";
        const excerpt = deltaExcerpt(entry.parts[0].delta);
        const summary =
          excerpt.before && excerpt.after
            ? `${JSON.stringify(excerpt.before)} → ${JSON.stringify(excerpt.after)}`
            : excerpt.after
              ? `+ ${JSON.stringify(excerpt.after)}`
              : `− ${JSON.stringify(excerpt.before)}`;
        return `${entry.handle}  ${entry.parts[0].turnId === query.turnId ? "this turn" : "earlier turn"}  ${state}  ${summary}${entry.parts.length > 1 ? ` and ${entry.parts.length - 1} more` : ""}  ${command}`;
      }),
    );
    return {
      status: "success",
      actionId: randomUUID(),
      room: null,
      message: [
        `your edits to ${document.uri}, newest first (version: ${versionOf(document)})`,
        ...lines,
        ...(older.length > 20 ? [`more: before ${page.at(-1)?.handle}`] : []),
      ].join("\n"),
    };
  }
  return {
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
            message: "File not found.",
          };
        const policy = createCapturedReversalPlanner(document, query);
        try {
          return await listEdits(document, policy, query, before);
        } finally {
          policy.free();
        }
      });
    },
  };
}

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

const versionOf = (document: InverseDocument) =>
  document.room.kind === "fork" ? ("draft" as const) : ("live" as const);
