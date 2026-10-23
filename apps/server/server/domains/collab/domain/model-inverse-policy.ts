// Per-document model stacks over immutable edits, with all-or-nothing action planning.

import { randomUUID } from "node:crypto";
import {
  type DocumentEditResult,
  type InverseSelection,
  type ModelInverseCommand,
  prepareEditRoots,
} from "@meridian/agent-edit/integration";
import type { BranchId } from "@meridian/contracts";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { FileEditRefusedError } from "../../file-policy/index.js";
import { partKey as key } from "./inverse-actions.js";
import type { InverseDestination } from "./inverse-draft-destination.js";
import { type InverseStep, simulateInverse } from "./inverse-stream.js";
import {
  plannedStepDestination,
  textOmission,
  textPlanRefusal,
  treePlanRefusal,
  treeRefusal,
} from "./model-inverse-presentation.js";
import {
  type Entry,
  entryKeys,
  entryRows,
  type Inspection,
  inspectionActions,
  inspectionContext,
} from "./model-inverse-selection.js";
import { createCapturedReversalPlanner, type ModelInverseQuery } from "./model-reversal-planner.js";
import { draftRoom } from "./observation-rooms.js";
import { ReversalConflictError } from "./reversal-conflict.js";
import {
  latestTransition,
  type PlannedTreeInverse,
  planTreeInverse,
  settlementOf,
  type TransitionEntry,
  TreeInverseRefused,
  treeEntrySummary,
  treeInverseFact,
  treeKey,
} from "./tree-inverse.js";
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
    preparedPolicy?: ReturnType<typeof createCapturedReversalPlanner>,
  ): Promise<DocumentEditResult | ModelPlanPreview> {
    if (!document)
      return {
        status: "document_not_found",
        message: "File not found. Read the project to find the right path.",
      };
    const policy = preparedPolicy ?? createCapturedReversalPlanner(document, query);
    const own = policy.own,
      actionId = randomUUID();
    const history = [...document.history],
      simulation = simulateInverse(document, {
        identity: {
          threadId: query.threadId,
          turnId: query.turnId ?? null,
          responseId: query.responseIdentity?.providerResponseId ?? null,
          editScopeId: query.responseIdentity?.editScopeId ?? null,
          toolCallId: query.toolCallId ?? null,
          actor: "agent",
        },
      }),
      steps: InverseStep[] = [],
      consumes: string[] = [],
      handles: string[] = [],
      performed = { undo: [] as string[], redo: [] as string[], revert: [] as string[] },
      skipped: string[] = [],
      partial: string[] = [],
      treeFacts: { handle: string; fact: string }[] = [];
    const views = new Map<
      InverseDestination,
      { scratch: Y.Doc; before: Uint8Array; inspection?: Inspection }
    >();
    const plannedView = (destination: InverseDestination) => {
      let planned = views.get(destination);
      if (planned) return planned;
      if (destination.kind === "draft" && destination.state === "gone")
        throw new Error("A gone inverse destination has no view");
      const source = destination.view;
      const before = Y.encodeStateAsUpdate(source);
      const scratch = new Y.Doc({ gc: false });
      Y.applyUpdate(scratch, before);
      planned = { scratch, before };
      views.set(destination, planned);
      return planned;
    };
    const currentInspection = (destination = policy.queryDestination) => {
      const planned = plannedView(destination);
      if (!planned.inspection)
        planned.inspection = inspectionContext(
          prepareEditRoots(planned.scratch, history),
          inspectionActions(history, simulation.tree, own),
        );
      return planned.inspection;
    };
    const invalidateInspections = () => {
      for (const planned of views.values()) planned.inspection = undefined;
    };
    const count = command.command === "revert" ? 1 : (command.count ?? 1);
    const undoEntries = command.command === "undo" ? policy.inspect().stack.slice(0, count) : [];
    if (command.command === "undo" && undoEntries.length < count)
      return undoEntries.length
        ? {
            status: "insufficient_undo",
            message: `Only ${undoEntries.length} ${undoEntries.length === 1 ? "edit" : "edits"} to undo in ${document.uri}; requested ${count}. Nothing was changed.`,
          }
        : {
            status: "nothing_to_undo",
            message: `You have no edits to undo in ${document.uri}. Read it and make a new replace if needed.`,
          };
    try {
      /**
       * One step per original edit, in the order the command takes them: an undo's each its own
       * action, so each can be redone separately; a redo's and a revert's the command's.
       */
      const stepAction = (kind: "undo" | "redo" | "revert") =>
        kind === "undo" && steps.length ? randomUUID() : actionId;
      const remember = (kind: "undo" | "redo" | "revert", handle: string) => {
        if (!performed[kind].includes(handle)) performed[kind].push(handle);
      };
      const apply = (
        entry: Entry,
        selection: InverseSelection[],
        kind: "undo" | "redo" | "revert",
        consumed: string[],
        destination = policy.queryDestination,
        groupedActionId?: string,
      ) => {
        if (destination.kind === "draft" && destination.state === "gone")
          throw new Error("Gone destination selected");
        const stepActionId = groupedActionId ?? stepAction(kind);
        remember(kind, entry.handle);
        const view = plannedView(destination);
        const result = currentInspection(destination).index.compute(selection, {
          actionId: stepActionId,
          allocateClient: allocateDocumentClient,
        });
        if (result.skipped.length)
          throw new Error("Inverse classification changed within the scratch plan");
        const at = Math.max(...entry.parts.map((part) => part.id));
        for (const edit of result.edits) {
          steps.push({
            kind: "text",
            edit: { ...edit, actionId: stepActionId },
            destination,
            actionId: stepActionId,
            actionKind: kind,
            at,
          });
          const id = randomUUID();
          for (const [ordinal, part] of edit.parts.entries()) {
            Y.applyUpdate(view.scratch, part.update);
            history.push({
              ...part,
              id: simulation.nextId(),
              editId: id,
              ordinal,
              kind,
              actionId: stepActionId,
              consumes: consumed,
              documentId: document.documentId,
              threadId: query.threadId,
              turnId: query.turnId ?? null,
              responseId: query.responseIdentity?.providerResponseId ?? null,
              editScopeId: query.responseIdentity?.editScopeId ?? null,
              toolCallId: query.toolCallId ?? null,
              actor: "agent",
              wId: null,
              origin:
                destination.kind === "draft"
                  ? {
                      kind: "pending",
                      draftId: destination.draftId,
                      rowId: 0,
                    }
                  : { kind: "live", seq: 0 },
              disposition: "pending",
            });
          }
        }
        // Neither lineage visibility nor action state survives a scratch advance.
        invalidateInspections();
        return result.edits.length > 0;
      };
      const applyTree = (
        planned: PlannedTreeInverse,
        handle: string,
        kind: "undo" | "redo" | "revert",
        consumed: string[],
        groupedActionId?: string,
      ) => {
        const stepActionId = groupedActionId ?? stepAction(kind);
        remember(kind, handle);
        steps.push({
          kind: "tree",
          planned,
          actionId: stepActionId,
          actionKind: kind,
          at: planned.entry.id,
        });
        treeFacts.push({ handle, fact: treeInverseFact(planned) });
        simulation.recordTree(planned, { kind, actionId: stepActionId, consumes: consumed });
        invalidateInspections();
      };
      const treePlan = (
        entry: Entry & { tree: TransitionEntry },
        direction: "undo" | "redo" | "revert",
      ) => {
        const decision = policy.treePlan(
          entry,
          direction,
          simulation.tree,
          simulation.states,
          currentInspection().actions.rolledBack,
          simulation.nextStep,
        );
        if (!("cause" in decision)) return decision;
        return treePlanRefusal(document.uri, entry.handle, direction, decision.cause);
      };
      const modelTextPlan = (
        entry: Entry,
        direction: "undo" | "redo" | "revert",
        options: Parameters<typeof policy.textPlan>[3] = {},
      ) => {
        const planned = policy.textPlan(entry, direction, currentInspection, options);
        if (planned.failure)
          return textPlanRefusal(document.uri, entry.handle, direction, planned.failure);
        return {
          destination: planned.destination,
          selection: planned.selection,
          actionKind: planned.actionKind as "undo" | "redo" | "revert",
          omissions: planned.omissions.map((omission) =>
            textOmission(entry.handle, direction, omission),
          ),
        };
      };
      const undoTextPlan = (entry: Entry) => {
        return modelTextPlan(entry, "undo", {
          liveRemoved: simulation.liveRemoved(),
        });
      };
      if (command.command === "revert") {
        const entry = own.find((entry) => entry.handle === command.edit);
        if (!entry)
          return {
            status: "invalid_write",
            message: `Unknown edit ${command.edit} in ${document.uri}. Read with format: "edits" for a valid handle.`,
          };
        if (entry.tree) {
          const planned = treePlan({ ...entry, tree: entry.tree }, "revert");
          if ("status" in planned)
            return planned.status === "cant_undo_changed"
              ? {
                  status: "nothing_to_revert",
                  message: `reverted: ${entry.handle} (0 of 1 changes)\nnot reverted: ${planned.message}`,
                }
              : planned;
          handles.push(entry.handle);
          applyTree(planned, entry.handle, "revert", []);
        } else {
          const textPlan = modelTextPlan(entry, "revert", {
            liveRemoved: simulation.liveRemoved(),
          });
          if ("status" in textPlan) return textPlan;
          skipped.push(...textPlan.omissions);
          handles.push(entry.handle);
          if (!textPlan.selection.length)
            return {
              status: "nothing_to_revert",
              message: `reverted: ${entry.handle} (0 of ${skipped.length} parts)\nnot reverted: ${skipped.join("\nnot reverted: ")}\nRead ${document.uri} for current text.`,
            };
          if (!apply(entry, textPlan.selection, "revert", [], textPlan.destination))
            return {
              status: "nothing_to_revert",
              message: `Nothing is left to reverse in ${document.uri}. Read it and make a new replace.`,
            };
        }
      } else
        for (let n = 0; n < count; n++) {
          if (command.command === "undo") {
            const entry = undoEntries[n];
            if (!entry) throw new Error("Captured undo selection changed while planning");
            if (entry.tree) {
              if (entry.tree.tree.op === "create" && entry.tree.tree.destination.kind === "draft") {
                const planned = treePlan({ ...entry, tree: entry.tree }, "undo");
                if ("status" in planned) return planned;
                handles.push(entry.handle);
                applyTree(planned, entry.handle, "undo", []);
                continue;
              }
              if (entry.parts.length) {
                const textPlan = undoTextPlan(entry);
                if ("status" in textPlan) return textPlan;
                partial.push(...textPlan.omissions);
                const groupedActionId = stepAction(textPlan.actionKind);
                if (
                  textPlan.selection.length &&
                  !apply(
                    entry,
                    textPlan.selection,
                    textPlan.actionKind,
                    [],
                    textPlan.destination,
                    groupedActionId,
                  )
                )
                  return {
                    status: "cant_undo_changed",
                    message: `Can't undo ${entry.handle}: none of that edit remains unchanged. Read ${document.uri} for current text.`,
                  };
                const planned = treePlan({ ...entry, tree: entry.tree }, "undo");
                if ("status" in planned) return planned;
                handles.push(entry.handle);
                applyTree(planned, entry.handle, "undo", [], groupedActionId);
                continue;
              }
              const planned = treePlan({ ...entry, tree: entry.tree }, "undo");
              if ("status" in planned) return planned;
              handles.push(entry.handle);
              applyTree(planned, entry.handle, "undo", []);
              continue;
            }
            const textPlan = undoTextPlan(entry);
            if ("status" in textPlan) return textPlan;
            partial.push(...textPlan.omissions);
            if (!textPlan.selection.length)
              return {
                status: "cant_undo_changed",
                message: `Can't undo ${entry.handle}: none of that edit remains unchanged. Read ${document.uri} for current text.`,
              };
            handles.push(entry.handle);
            if (!apply(entry, textPlan.selection, textPlan.actionKind, [], textPlan.destination))
              return {
                status: "cant_undo_changed",
                message: `Can't undo ${entry.handle}: none of that edit remains unchanged. Read ${document.uri} for current text.`,
              };
          } else {
            const action = currentInspection().candidate;
            if (!action && n > 0)
              return {
                status: "insufficient_redo",
                message: `Only ${n} ${n === 1 ? "edit" : "edits"} to redo in ${document.uri}; requested ${command.count}. Nothing was changed.`,
              };
            if (!action)
              return {
                status: "nothing_to_redo",
                message: `Nothing of yours to redo in ${document.uri}. A new edit clears redo here. Read it and make a new replace if needed.`,
              };
            const targets = own.flatMap((entry) =>
              entryKeys(entry)
                .filter((k) => action.targets.has(k))
                .map(() => ({ handle: entry.handle })),
            );
            if (
              action.parts.some(
                (part) => part.actor !== "agent" || part.threadId !== query.threadId,
              )
            )
              return {
                status: "cant_redo_users_undo",
                message: `The user undid ${[...new Set(targets.map((target) => target.handle))].join(", ")}. Only they can redo it. Read ${document.uri} and make a new replace if needed.`,
              };
            // Card actions may span edits; model undo actions each target one edit.
            // Restore overlapping originals oldest first within an action.
            const restoring = own
              .map((entry) => ({
                ...entry,
                parts: entry.parts.filter((part) => action.targets.has(key(part))),
              }))
              .filter(
                (entry) =>
                  entry.parts.length ||
                  (entry.tree && action.targets.has(treeKey(entry.tree.editId))),
              )
              .sort(
                (a, b) =>
                  Math.min(...entryRows(a).map((row) => row.id)) -
                  Math.min(...entryRows(b).map((row) => row.id)),
              );
            for (const entry of restoring) {
              if (entry.tree) {
                const planned = treePlan({ ...entry, tree: entry.tree }, "redo");
                if ("status" in planned) return planned;
                applyTree(planned, entry.handle, "redo", [action.id]);
                if (!entry.parts.length) continue;
              }
              const inverseParts = action.parts.filter(
                (part): part is StoredInversePart =>
                  !("tree" in part) &&
                  entry.parts.some((original) =>
                    part.targets.some((target) => key(target) === key(original)),
                  ),
              );
              const textPlan = modelTextPlan(entry, "redo", {
                inverseParts,
                liveRemoved: simulation.liveRemoved(),
              });
              if ("status" in textPlan) return textPlan;
              partial.push(...textPlan.omissions);
              if (!textPlan.selection.length)
                return {
                  status: "cant_redo_changed",
                  message: `Can't redo ${entry.handle}: none of that edit remains unchanged. Read ${document.uri} for current text.`,
                };
              if (!apply(entry, textPlan.selection, "redo", [action.id], textPlan.destination))
                return {
                  status: "cant_redo_changed",
                  message: `Can't redo ${entry.handle}: none of that edit remains unchanged. Read ${document.uri} for current text.`,
                };
            }
            handles.push(...[...new Set(targets.map((target) => target.handle))]);
            consumes.push(action.id);
          }
        }
      if (!steps.length)
        return {
          status: "nothing_to_revert",
          message: `Nothing is left to reverse in ${document.uri}. Read it and make a new replace.`,
        };
      const text = steps.flatMap((step) => (step.kind === "text" ? [step.edit] : []));
      const reversesTree = steps.some((step) => step.kind === "tree");
      // An inverse that changed no text (a move's or delete's) has no text echo. The cuts are
      // taken before the commit, which applies the inverse to the view.
      const textDestinations = new Set(
        steps.flatMap((step) => (step.kind === "text" ? [step.destination] : [])),
      );
      const plannedDestinations = new Map<
        BranchId | "live",
        { branchId: BranchId | null; draftId: string | null; destination: InverseDestination }
      >();
      for (const step of steps) {
        const destination = plannedStepDestination(document, step);
        const branchId = destination.kind === "draft" ? destination.branchId : null;
        const previous = plannedDestinations.get(branchId ?? "live");
        plannedDestinations.set(branchId ?? "live", {
          branchId,
          draftId: policy.draftIdOf(destination) ?? previous?.draftId ?? null,
          destination,
        });
      }
      const [textDestination] = textDestinations;
      const textView =
        textDestinations.size === 1 && textDestination ? plannedView(textDestination) : undefined;
      const cuts = textView
        ? { before: textView.before, after: Y.encodeStateAsUpdate(textView.scratch) }
        : {};
      const inversePlan = { document, steps, consumes, skips: [] };
      if (preview) return { status: "planned" };
      const committed = await store.commit({
        query,
        kind: command.command,
        plans: [inversePlan],
        sequence: steps.map((step) => ({ plan: inversePlan, step })),
      });
      const parts = text.reduce((n, edit) => n + edit.parts.length, 0);
      const destinations = new Map(
        committed.outcomes.map((outcome) => [outcome.branchId ?? "live", outcome]),
      );
      const [destination] = destinations.values();
      const committedDraftIds = new Set(
        committed.outcomes.flatMap((outcome) => (outcome.draftId ? [outcome.draftId] : [])),
      );
      const landedByHandle = new Map(
        committed.landings.map((landing) => [landing.handle, landing.landedAt]),
      );
      return {
        status: "success",
        actionId,
        room:
          textDestinations.size === 1
            ? committedDraftIds.size === 1
              ? draftRoom([...committedDraftIds][0] as string)
              : document.liveRoom
            : null,
        ...cuts,
        updates: committed.updates,
        ...(destinations.size === 1
          ? destination?.branchId
            ? {
                destination: "draft" as const,
                ...(destination.draftId
                  ? {
                      draftWork:
                        plannedDestinations.get(destination.branchId)?.destination.kind === "draft"
                          ? (document.drafts.get(
                              policy.draftIdOf(
                                plannedDestinations.get(destination.branchId)
                                  ?.destination as InverseDestination,
                              ) as string,
                            )?.name ?? "/")
                          : "/",
                    }
                  : {}),
              }
            : { destination: "live" as const }
          : {}),
        ...(command.command === "revert" ? { writeId: committed.handles[0] } : {}),
        message: [
          command.command === "revert" && !reversesTree
            ? `reverted: ${handles[0]} (${parts} of ${parts + skipped.length} parts)${skipped.map((reason) => `\nnot reverted: ${reason}`).join("")}`
            : [
                ...(performed.undo.length ? [`undone: ${performed.undo.join(", ")}`] : []),
                ...(performed.revert.length ? [`reverted: ${performed.revert.join(", ")}`] : []),
                ...(performed.redo.length ? [`redone: ${performed.redo.join(", ")}`] : []),
              ].join("\n") +
              (partial.length ? ` (${parts} of ${parts + partial.length} parts)` : ""),
          ...partial.map(
            (reason) => `not ${command.command === "undo" ? "undone" : "redone"}: ${reason}`,
          ),
          ...(destinations.size > 1
            ? [
                `versions: ${[...destinations.values()]
                  .map((destination) =>
                    destination.draftId
                      ? policy.version(
                          plannedDestinations.get(destination.branchId ?? "live")?.destination ??
                            policy.queryDestination,
                        )
                      : destination.branchId
                        ? "draft"
                        : "live",
                  )
                  .join(", ")}`,
              ]
            : []),
          ...treeFacts.map(({ handle, fact }) => {
            const landedAt = landedByHandle.get(handle);
            return `${handle}: ${fact}${landedAt ? ` as ${landedAt}` : ""}`;
          }),
        ].join("\n"),
      };
    } finally {
      for (const { scratch } of views.values()) scratch.destroy();
    }
  }
  return {
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
        // Every attempt missed while the edit still applied: retryable, not a refusal.
        if (cause instanceof ReversalConflictError)
          return { status: "internal_error", message: cause.message };
        if (cause instanceof FileEditRefusedError)
          return {
            status: "permission_denied",
            message: "This change is no longer editable.",
          };
        if (cause instanceof TreeInverseRefused) return treeRefusal(cause);
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
          inspection = policy.inspect(),
          action = inspection.candidate,
          topEntry = inspection.top;
        if (before && !own.some((entry) => entry.handle === before))
          return {
            status: "invalid_write",
            message: `Unknown edit ${before} in ${document.uri}. Read with format: "edits" without before for valid handles.`,
          };
        const older = own.filter(
            (entry) => !before || Number(entry.handle.slice(1)) < Number(before.slice(1)),
          ),
          page = older.slice(0, 20);
        const redo = action
          ? await plan(
              document,
              query,
              { command: "redo", file: document.uri, documentId: document.documentId },
              true,
              policy,
            )
          : null;
        const undo = topEntry
          ? await plan(
              document,
              query,
              { command: "undo", file: document.uri, documentId: document.documentId },
              true,
              policy,
            )
          : null;
        const displayInspection = (part: StoredInversePart) =>
          policy.inspect(
            (() => {
              const destination = document.destinationOf(part.origin);
              return destination.kind === "draft" && destination.state === "gone"
                ? policy.view
                : destination.view;
            })(),
          );
        const displayParts = new Map<Inspection, StoredInversePart[]>();
        for (const entry of page)
          for (const part of entry.parts) {
            const context = displayInspection(part);
            const parts = displayParts.get(context) ?? [];
            parts.push(part);
            displayParts.set(context, parts);
          }
        for (const [context, parts] of displayParts) context.states(parts);
        // Revert stays current; Undo follows a reachable live/draft origin.
        inspection.states(page.flatMap((entry) => entry.parts));
        const index = inspection.actions;
        const turn = (turnId: string | null) =>
          turnId === query.turnId ? "this turn" : "earlier turn";
        const treeLine = (entry: Entry & { tree: TransitionEntry }) => {
          const k = treeKey(entry.tree.editId);
          const latest = latestTransition(entry.tree, document.tree, index.rolledBack);
          const settled = settlementOf(entry.tree, document.tree);
          const state = index.rolledBack.has(k)
            ? "rolled back"
            : index.byPart.has(k)
              ? "undone"
              : (settled ??
                (!latest.stands
                  ? "undone"
                  : planTreeInverse(entry.tree, "invert", latest.row, document.treeStates, 0)
                    ? entry.tree.tree.destination.kind === "draft"
                      ? "pending"
                      : "live"
                    : "changed"));
          const reversal = (direction: "undo" | "revert") =>
            policy.treePlan(
              entry,
              direction,
              document.tree,
              document.treeStates,
              index.rolledBack,
              () => 0,
            );
          let command = "cause" in reversal("revert") ? "none" : "revert";
          if (entry.id === topEntry?.id && undo?.status === "planned") command = "undo";
          else if (
            action?.targets.has(k) &&
            action.parts.every(
              (part) => part.actor === "agent" && part.threadId === query.threadId,
            ) &&
            redo?.status === "planned"
          )
            command = "redo";
          return `${entry.handle}  ${turn(entry.tree.turnId)}  ${state}  ${treeEntrySummary(entry.tree)}  ${command}`;
        };
        const lines = page.map((entry) => {
          if (entry.tree) return treeLine({ ...entry, tree: entry.tree });
          const undos = index.actions.filter((action) =>
            entry.parts.some((part) => action.targets.has(key(part))),
          );
          const popped = index.byPart;
          const fullyUndone = entry.parts.every((part) => popped.has(key(part)));

          const states = entry.parts.map((part) => displayInspection(part).states([part])[0]),
            applied = entry.parts.filter(
              (part) => part.origin.kind === "pending" && part.disposition === "applied",
            ).length;
          const state = entry.parts.every((part) => inspection.rolledBack(part))
            ? "rolled back"
            : fullyUndone
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
                : entry.parts.every((part) => part.disposition === "discarded")
                  ? "discarded"
                  : states.every((state) => state.state === "undone")
                    ? "undone"
                    : states.some((state) => state.state === "changed")
                      ? "changed"
                      : entry.parts.some((part) => part.origin.kind === "pending")
                        ? "pending"
                        : "live";
          let command = "none";
          const revertPlan = policy.textPlan(entry, "revert", (destination) =>
            destination.kind === "draft" && destination.state === "gone"
              ? displayInspection(entry.parts[0] as StoredInversePart)
              : policy.inspect(destination.view),
          );
          const revert = "failure" in revertPlan ? 0 : revertPlan.selection.length;
          if (revert)
            command =
              revert === entry.parts.length
                ? "revert"
                : `revert ${revert} of ${entry.parts.length}`;
          const appliedOrigin = entry.parts.some(
            (part) => part.origin.kind === "pending" && part.disposition === "applied",
          );
          if (entry.id === topEntry?.id && undo?.status === "planned" && !appliedOrigin)
            command = "undo";
          else if (
            action &&
            entry.parts.some((part) => action.targets.has(key(part))) &&
            action.parts.every((part) => part.actor === "agent" && part.threadId === query.threadId)
          ) {
            if (redo?.status === "planned") command = "redo";
          }
          const excerpt = store.describePart(document, entry.parts[0]);
          const summary =
            excerpt.before && excerpt.after
              ? `${JSON.stringify(excerpt.before)} → ${JSON.stringify(excerpt.after)}`
              : excerpt.after
                ? `+ ${JSON.stringify(excerpt.after)}`
                : `− ${JSON.stringify(excerpt.before)}`;
          return `${entry.handle}  ${entry.parts[0].turnId === query.turnId ? "this turn" : "earlier turn"}  ${state}  ${summary}${entry.parts.length > 1 ? ` and ${entry.parts.length - 1} more` : ""}  ${command}`;
        });
        const shownDestination = topEntry?.parts[0]
          ? document.destinationOf(topEntry.parts[0].origin)
          : topEntry?.tree?.tree.destination.kind === "draft"
            ? document.destinationForBranch(topEntry.tree.tree.destination.branchId)
            : policy.queryDestination;
        return {
          status: "success",
          actionId: randomUUID(),
          room: null,
          message: [
            `your edits to ${document.uri}, newest first (version: ${policy.version(shownDestination)})`,
            ...lines,
            ...(older.length > 20 ? [`more: before ${page.at(-1)?.handle}`] : []),
          ].join("\n"),
        };
      });
    },
  };
}
