// Per-document model stacks over immutable edits, with all-or-nothing action planning.

import { randomUUID } from "node:crypto";
import {
  type DocumentEditResult,
  editHandle,
  type InverseSelection,
  type ModelInverseCommand,
  type PreparedEditRoots,
  prepareEditRoots,
  removedFile,
} from "@meridian/agent-edit/integration";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { effectiveActionIndex, partKey as key } from "./inverse-actions.js";
import { type InverseStep, simulateInverse } from "./inverse-stream.js";
import { draftRoom } from "./observation-rooms.js";
import { ReversalConflictError } from "./reversal-conflict.js";
import {
  isTransitionEntry,
  latestTransition,
  type PlannedTreeInverse,
  planTreeInverse,
  type StoredTreeEntry,
  settlementOf,
  type TransitionEntry,
  TreeInverseRefused,
  treeChangedCause,
  treeEntrySummary,
  treeFaultReason,
  treeInverseFact,
  treeKey,
} from "./tree-inverse.js";
import type {
  InverseDocument,
  StoredInversePart,
  TurnInverseQuery,
  TurnInverseStore,
} from "./turn-inverse-service.js";

type Query = TurnInverseQuery & { model: true; draftId: string | null };
/** One own edit on the stack: text parts, or one tree entry (a move or delete) with none. */
type Entry = { id: string; handle: string; parts: StoredInversePart[]; tree?: TransitionEntry };
const entryKeys = (entry: Entry) =>
  entry.tree ? [treeKey(entry.tree.editId)] : entry.parts.map(key);
const entryRows = (entry: Entry): { id: number; key: string }[] =>
  entry.tree
    ? [{ id: entry.tree.id, key: treeKey(entry.tree.editId) }]
    : entry.parts.map((part) => ({ id: part.id, key: key(part) }));
function entries(document: InverseDocument, threadId: string): Entry[] {
  const map = new Map<string, Entry>();
  for (const row of document.tree)
    if (
      isTransitionEntry(row) &&
      row.threadId === threadId &&
      row.actor === "agent" &&
      row.wId !== null &&
      (row.kind === "write" || row.kind === "revert")
    )
      map.set(row.editId, { id: row.editId, handle: editHandle(row.wId), parts: [], tree: row });
  for (const part of document.history) {
    if (
      part.threadId !== threadId ||
      part.actor !== "agent" ||
      part.wId === null ||
      (part.kind !== "write" && part.kind !== "revert") ||
      (!part.effect.inserted.length && !part.effect.deleted.length)
    )
      continue;
    const entry = map.get(part.editId) ?? {
      id: part.editId,
      handle: editHandle(part.wId),
      parts: [],
    };
    entry.parts.push(part);
    map.set(part.editId, entry);
  }
  return [...map.values()].sort((a, b) => Number(b.handle.slice(1)) - Number(a.handle.slice(1)));
}
function inspectionActions(
  history: StoredInversePart[],
  tree: readonly StoredTreeEntry[],
  own: Entry[],
) {
  const actions = effectiveActionIndex<StoredInversePart | StoredTreeEntry>(
    [...history, ...tree],
    new Set(own.flatMap(entryKeys)),
  );
  const rolledBack = (part: StoredInversePart) => actions.rolledBack.has(key(part));
  return {
    actions,
    rolledBack,
    top: own.find(
      (entry) => !entryKeys(entry).every((k) => actions.byPart.has(k) || actions.rolledBack.has(k)),
    ),
    candidate: actions.actions.find(
      (action) =>
        !own.some((entry) =>
          entryRows(entry).some(
            (row) => row.id > action.newest && !actions.rolledBack.has(row.key),
          ),
        ),
    ),
  };
}
/** Facts belong to one immutable view. Advancing a scratch plan replaces this context. */
function inspectionContext(
  index: PreparedEditRoots,
  actions: ReturnType<typeof inspectionActions>,
) {
  const classifications = new Map<string, ReturnType<PreparedEditRoots["classify"]>[number]>();
  return {
    index,
    ...actions,
    states(parts: StoredInversePart[]) {
      const missing = parts.filter((part) => !classifications.has(key(part)));
      if (missing.length)
        for (const state of index.classify(missing)) classifications.set(key(state.part), state);
      return parts.map((part) => {
        const state = classifications.get(key(part));
        if (!state) throw new Error("Missing inverse classification");
        return state;
      });
    },
  };
}
type Inspection = ReturnType<typeof inspectionContext>;

/** A tree inverse the destination refused under the locks: nothing of the command ran. */
function treeRefusal(cause: TreeInverseRefused): DocumentEditResult {
  const verb = cause.planned.direction === "invert" ? "undo" : "redo";
  const what =
    cause.fault === "location_taken"
      ? `${cause.at ?? "its location"} is already taken. Use \`ls\` to check what is there. If it is a document, move or rename it before retrying. Otherwise, tell the user the location is blocked.`
      : cause.fault === "folder_missing"
        ? "the document's original folder is gone. Tell the user it can't be restored here."
        : `${treeFaultReason(cause.fault)}. Tell the user it can't be restored here.`;
  return {
    status: `cant_${verb}_changed`,
    message: `Can't ${verb} ${cause.planned.entry.tree.shownAt ?? "this change"}: ${what}`,
  };
}

export function createModelInversePolicy(store: TurnInverseStore) {
  function planner(document: InverseDocument, query: Query) {
    const liveIndex = prepareEditRoots(document.live, document.history);
    const draft = query.draftId ? document.drafts.get(query.draftId) : undefined;
    const view = draft?.doc ?? document.live;
    const own = entries(document, query.threadId);
    const actions = inspectionActions(document.history, document.tree, own);
    const inspections = new Map<Y.Doc, Inspection>();
    inspections.set(document.live, inspectionContext(liveIndex, actions));
    for (const documentDraft of document.drafts.values()) {
      const index = liveIndex.forView(documentDraft.doc);
      inspections.set(documentDraft.doc, inspectionContext(index, actions));
    }
    const inspect = (current = view) => {
      const inspection = inspections.get(current);
      if (!inspection) throw new Error("Missing immutable-view inspection");
      return inspection;
    };
    const version = (draftId: string | null) =>
      draftId ? `draft (${document.drafts.get(draftId)?.name ?? "unavailable"})` : "live";
    function refusal(
      part: StoredInversePart,
      handle: string,
      direction: "undo" | "redo",
      inspection: Inspection,
    ): Exclude<DocumentEditResult, { status: "success" }> | null {
      const follow = `Use revert on ${document.uri}, or read it and make a new replace.`;
      const discarded = {
        status: `cant_${direction}_discarded` as const,
        message: `The user discarded ${handle}; it is already gone. ${follow}`,
      };
      if (draft?.frozen)
        return {
          status: "work_archived",
          message: `This draft is archived. Write to an active draft or live version of ${document.uri}.`,
        };
      if (part.origin.kind === "pending" && part.disposition === "applied")
        return {
          status: `cant_${direction}_applied`,
          message: `The user applied ${handle} to the manuscript. ${follow}`,
        };
      if (part.origin.kind === "pending" && !document.drafts.has(part.origin.draftId))
        return discarded;
      const draftId = part.origin.kind === "pending" ? part.origin.draftId : null;
      if (draftId !== query.draftId)
        return {
          status: `cant_${direction}_elsewhere`,
          message: `${handle} is in another version (${version(draftId)}). You can ${direction} only in the version you write to. ${follow}`,
        };
      // Restoring the review base can hide an effective Undo from review membership.
      const state = inspection.states([part])[0];
      if (state.state !== (direction === "undo" ? "active" : "undone")) {
        if (part.disposition === "discarded") return discarded;
        const excerpt = store.describePart(document, part);
        return {
          status: `cant_${direction}_changed`,
          message: `${handle} was edited after you wrote it (${JSON.stringify(excerpt.before)} → ${JSON.stringify(excerpt.after)}). ${follow}`,
        };
      }
      return null;
    }
    /** The branch a draft-mode write lands in, for comparing a drafted tree entry's. */
    const branchId = draft?.documentDraft.branchId ?? null;
    /**
     * Whether `entry` can be reversed in `direction` from the states `states` hold, judged by
     * state (D76): the planned transition, or the refusal.
     */
    function treePlan(
      entry: Entry & { tree: TransitionEntry },
      direction: "undo" | "redo" | "revert",
      tree: readonly StoredTreeEntry[],
      states: InverseDocument["treeStates"],
      rolledBack: ReadonlySet<string>,
      step: () => number,
    ): PlannedTreeInverse | Exclude<DocumentEditResult, { status: "success" }> {
      const verb = direction === "revert" ? "undo" : direction;
      const follow = "Check where it is with `ls`, then make a new move or delete if needed.";
      const row = entry.tree;
      const destination = row.tree.destination;
      if (draft?.frozen)
        return {
          status: "work_archived",
          message: `This draft is archived. Write to an active draft or live version of ${document.uri}.`,
        };
      const settled = settlementOf(row, tree);
      if (settled === "applied")
        return {
          status: `cant_${verb}_applied`,
          message: `The user applied ${entry.handle} to the manuscript. ${follow}`,
        };
      if (settled === "discarded")
        return {
          status: `cant_${verb}_discarded`,
          message: `The user discarded ${entry.handle}; it is already gone. ${follow}`,
        };
      const here = destination.kind === "live" ? null : destination.branchId;
      if (here !== branchId)
        return {
          status: `cant_${verb}_elsewhere`,
          message: `${entry.handle} is in another version (${here ? "draft" : "live"}). You can ${verb} only in the version you write to. ${follow}`,
        };
      const latest = latestTransition(row, tree, rolledBack);
      const planned =
        latest.stands === (direction !== "redo")
          ? planTreeInverse(
              row,
              direction === "redo" ? "reapply" : "invert",
              latest.row,
              states,
              step(),
            )
          : null;
      if (planned) return planned;
      return {
        status: `cant_${verb}_changed`,
        message: `${entry.handle} can't be ${verb === "undo" ? "undone" : "redone"}: the document was ${treeChangedCause(states, destination).replace("_", " ")} you ${verb === "undo" ? "made" : "undid"} it. ${follow}`,
      };
    }
    function revertSelection(entry: Entry, inspection = inspect()) {
      const skipped: string[] = [],
        selection: InverseSelection[] = [];
      const states = inspection.states(entry.parts);
      for (const [i, part] of entry.parts.entries()) {
        const state = states[i];
        const originDraft = part.origin.kind === "pending" ? part.origin.draftId : null;
        const kernelReason =
          state.state === "undone"
            ? "already removed"
            : state.reasons.includes("inaccessible ancestor")
              ? "paragraph replaced or removed"
              : state.state !== "active"
                ? "edited since"
                : null;
        const reason =
          (query.draftId && !draft) || (originDraft && !document.drafts.has(originDraft))
            ? "discarded"
            : originDraft && originDraft !== query.draftId
              ? "in another draft"
              : inspection.rolledBack(part)
                ? "rolled back"
                : kernelReason && part.disposition === "discarded"
                  ? "discarded"
                  : kernelReason;
        if (reason) skipped.push(`part ${part.ordinal + 1}: ${reason}`);
        else selection.push({ part, direction: "invert" });
      }
      return { selection, skipped };
    }
    return { view, draft, own, inspect, refusal, treePlan, revertSelection, version };
  }
  async function plan(
    document: InverseDocument | undefined,
    query: Query,
    command: ModelInverseCommand,
    preview = false,
    preparedPolicy?: ReturnType<typeof planner>,
  ): Promise<DocumentEditResult> {
    if (!document)
      return {
        status: "document_not_found",
        message: "File not found. Read the project to find the right path.",
      };
    const policy = preparedPolicy ?? planner(document, query),
      own = policy.own,
      actionId = randomUUID();
    if (policy.draft?.frozen)
      return {
        status: "work_archived",
        message: `This draft is archived. Write to an active draft or live version of ${document.uri}.`,
      };
    const scratch = new Y.Doc({ gc: false }),
      history = [...document.history],
      simulation = simulateInverse(document, {
        identity: {
          threadId: query.threadId,
          turnId: query.turnId ?? null,
          responseId: query.responseIdentity?.providerResponseId ?? null,
          editScopeId: query.responseIdentity?.editScopeId ?? null,
          actor: "agent",
        },
      }),
      steps: InverseStep[] = [],
      consumes: string[] = [],
      handles: string[] = [],
      skipped: string[] = [],
      treeFacts: string[] = [];
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(policy.view));
    // Until its first advance, scratch is identical to the locked view.
    let inspection: Inspection | undefined = policy.inspect();
    const currentInspection = () => {
      if (!inspection)
        inspection = inspectionContext(
          prepareEditRoots(scratch, history),
          inspectionActions(history, simulation.tree, own),
        );
      return inspection;
    };
    // A draft that outlived the document's live delete still takes its own inverse (D79); live
    // text meets the removal unless an earlier step of this command restores the document.
    const removedText = () =>
      !policy.draft && simulation.liveRemoved() ? removedFile(document.removal) : null;
    try {
      /**
       * One step per original edit, in the order the command takes them: an undo's each its own
       * action, so each can be redone separately; a redo's and a revert's the command's.
       */
      const stepAction = (kind: "undo" | "redo" | "revert") =>
        kind === "undo" && steps.length ? randomUUID() : actionId;
      const apply = (
        entry: Entry,
        selection: InverseSelection[],
        kind: "undo" | "redo" | "revert",
        consumed: string[],
      ) => {
        const stepActionId = stepAction(kind);
        const result = currentInspection().index.compute(selection, {
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
            draftId: query.draftId,
            actionId: stepActionId,
            at,
          });
          const id = randomUUID();
          for (const [ordinal, part] of edit.parts.entries()) {
            Y.applyUpdate(scratch, part.update);
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
              actor: "agent",
              wId: null,
              origin: query.draftId
                ? {
                    kind: "pending",
                    draftId: query.draftId,
                    rowId: 0,
                  }
                : { kind: "live", seq: 0 },
              disposition: "pending",
            });
          }
        }
        // Neither lineage visibility nor action state survives a scratch advance.
        inspection = undefined;
      };
      const applyTree = (
        planned: PlannedTreeInverse,
        handle: string,
        kind: "undo" | "redo" | "revert",
        consumed: string[],
      ) => {
        const stepActionId = stepAction(kind);
        steps.push({ kind: "tree", planned, actionId: stepActionId, at: planned.entry.id });
        treeFacts.push(`${handle}: ${treeInverseFact(planned)}`);
        simulation.recordTree(planned, { kind, actionId: stepActionId, consumes: consumed });
        inspection = undefined;
      };
      const treePlan = (
        entry: Entry & { tree: TransitionEntry },
        direction: "undo" | "redo" | "revert",
      ) =>
        policy.treePlan(
          entry,
          direction,
          simulation.tree,
          simulation.states,
          currentInspection().actions.rolledBack,
          simulation.nextStep,
        );
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
          const removed = removedText();
          if (removed) return removed;
          const selection = policy.revertSelection(entry);
          skipped.push(...selection.skipped);
          handles.push(entry.handle);
          if (!selection.selection.length)
            return {
              status: "nothing_to_revert",
              message: `reverted: ${entry.handle} (0 of ${skipped.length} parts)\nnot reverted: ${skipped.join("\nnot reverted: ")}\nRead ${document.uri} for current text.`,
            };
          apply(entry, selection.selection, "revert", []);
        }
      } else
        for (let n = 0; n < (command.count ?? 1); n++) {
          if (command.command === "undo") {
            const entry = currentInspection().top;
            if (!entry && n > 0)
              return {
                status: "insufficient_undo",
                message: `Only ${n} ${n === 1 ? "edit" : "edits"} to undo in ${document.uri}; requested ${command.count}. Nothing was changed.`,
              };
            if (!entry)
              return {
                status: "nothing_to_undo",
                message: `You have no edits to undo in ${document.uri}. Read it and make a new replace if needed.`,
              };
            if (entry.tree) {
              const planned = treePlan({ ...entry, tree: entry.tree }, "undo");
              if ("status" in planned) return planned;
              handles.push(entry.handle);
              applyTree(planned, entry.handle, "undo", []);
              continue;
            }
            const removed = removedText();
            if (removed) return removed;
            const current = currentInspection();
            current.states(entry.parts);
            for (const part of entry.parts) {
              const refused = policy.refusal(part, entry.handle, "undo", current);
              if (refused) return refused;
            }
            handles.push(entry.handle);
            apply(
              entry,
              [...entry.parts]
                .sort((a, b) => b.id - a.id)
                .map((part) => ({ part, direction: "invert" })),
              "undo",
              [],
            );
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
                continue;
              }
              const removed = removedText();
              if (removed) return removed;
              const current = currentInspection();
              current.states(entry.parts);
              for (const original of entry.parts) {
                const inverse = action.parts.find(
                  (part): part is StoredInversePart =>
                    !("tree" in part) && part.targets.some((t) => key(t) === key(original)),
                );
                if (!inverse) throw new Error("Undo action has no inverse for its target");
                const refused = policy.refusal(
                  { ...original, origin: inverse.origin, disposition: inverse.disposition },
                  entry.handle,
                  "redo",
                  current,
                );
                if (refused) return refused;
              }
              apply(
                entry,
                entry.parts.map((part) => ({ part, direction: "reapply" })),
                "redo",
                [action.id],
              );
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
      const cuts = text.length
        ? { before: Y.encodeStateAsUpdate(policy.view), after: Y.encodeStateAsUpdate(scratch) }
        : {};
      const plan = { document, steps, consumes, skips: [] };
      const committed = preview
        ? { handles: [], updates: [] }
        : await store.commit({
            query,
            kind: command.command,
            plans: [plan],
            sequence: steps.map((step) => ({ plan, step })),
          });
      const parts = text.reduce((n, edit) => n + edit.parts.length, 0);
      return {
        status: "success",
        actionId,
        room: query.draftId ? draftRoom(query.draftId) : document.liveRoom,
        ...cuts,
        updates: committed.updates,
        ...(command.command === "revert" ? { writeId: committed.handles[0] } : {}),
        message: [
          command.command === "revert" && !reversesTree
            ? `reverted: ${handles[0]} (${parts} of ${parts + skipped.length} parts)${skipped.map((reason) => `\nnot reverted: ${reason}`).join("")}`
            : `${command.command === "undo" ? "undone" : command.command === "redo" ? "redone" : "reverted"}: ${handles.join(", ")}`,
          ...treeFacts,
        ].join("\n"),
      };
    } finally {
      scratch.destroy();
    }
  }
  return {
    async modelInverse(query: Query, command: ModelInverseCommand): Promise<DocumentEditResult> {
      try {
        return await store.withCapturedDocuments(query, (documents) =>
          plan(documents[0], query, command),
        );
      } catch (cause) {
        // Every attempt missed while the edit still applied: retryable, not a refusal.
        if (cause instanceof ReversalConflictError)
          return { status: "internal_error", message: cause.message };
        if (cause instanceof TreeInverseRefused) return treeRefusal(cause);
        throw cause;
      }
    },
    async modelEdits(query: Query, before?: string): Promise<DocumentEditResult> {
      return store.withCapturedDocuments(query, async (documents) => {
        const document = documents[0];
        if (!document)
          return {
            status: "document_not_found",
            message: "File not found. Check the path with ls.",
          };
        const policy = planner(document, query),
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
        const displayInspection = (part: StoredInversePart) =>
          policy.inspect(
            part.origin.kind === "pending"
              ? (document.drafts.get(part.origin.draftId)?.doc ?? policy.view)
              : document.live,
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
        // Revert and Undo are evaluated in the current destination, not the historical view.
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
          let command = "status" in reversal("revert") ? "none" : "revert";
          if (entry.id === topEntry?.id) {
            const undo = reversal("undo");
            command =
              "status" in undo
                ? `undo: no (${undo.status.replace("cant_undo_", "")})${command === "revert" ? "; revert" : ""}`
                : "undo";
          } else if (
            action?.targets.has(k) &&
            action.parts.every(
              (part) => part.actor === "agent" && part.threadId === query.threadId,
            ) &&
            redo?.status === "success"
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
          const revert = policy.revertSelection(entry).selection.length;
          if (revert)
            command =
              revert === entry.parts.length
                ? "revert"
                : `revert ${revert} of ${entry.parts.length}`;
          if (entry.id === topEntry?.id) {
            const blocked = entry.parts
              .map((part) => policy.refusal(part, entry.handle, "undo", inspection))
              .find(Boolean);
            command = blocked
              ? `undo: no (${blocked.status.replace("cant_undo_", "")})${revert ? `; ${command}` : ""}`
              : "undo";
          } else if (
            action &&
            entry.parts.some((part) => action.targets.has(key(part))) &&
            action.parts.every((part) => part.actor === "agent" && part.threadId === query.threadId)
          ) {
            if (redo?.status === "success") command = "redo";
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
        return {
          status: "success",
          actionId: randomUUID(),
          room: null,
          message: [
            `your edits to ${document.uri}, newest first (version: ${policy.version(query.draftId)})`,
            ...lines,
            ...(older.length > 20 ? [`more: before ${page.at(-1)?.handle}`] : []),
          ].join("\n"),
        };
      });
    },
  };
}
