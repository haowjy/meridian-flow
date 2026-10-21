// Per-document model stacks over immutable edits, with all-or-nothing action planning.

import { randomUUID } from "node:crypto";
import {
  type ComputedInverse,
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
import { prepareHolds } from "./inverse-holds.js";
import { draftRoom } from "./observation-rooms.js";
import { ReversalConflictError } from "./reversal-conflict.js";
import type {
  InverseDocument,
  StoredInversePart,
  TurnInverseQuery,
  TurnInverseStore,
} from "./turn-inverse-service.js";

type Query = TurnInverseQuery & { model: true; draftId: string | null };
type Entry = { id: string; handle: string; parts: StoredInversePart[] };
const eligible = (part: StoredInversePart) =>
  part.placement.kind === "live" || part.placement.kind === "pending";
function entries(document: InverseDocument, threadId: string): Entry[] {
  const map = new Map<string, Entry>();
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
function inspectionActions(history: StoredInversePart[], own: Entry[]) {
  const actions = effectiveActionIndex(
    history,
    new Set(own.flatMap((entry) => entry.parts.map(key))),
  );
  const rolledBack = (part: StoredInversePart) => actions.rolledBack.has(key(part));
  return {
    actions,
    rolledBack,
    top: own.find(
      (entry) => !entry.parts.every((part) => actions.byPart.has(key(part)) || rolledBack(part)),
    ),
    candidate: actions.actions.find(
      (action) =>
        !own.some((entry) =>
          entry.parts.some((part) => part.id > action.newest && !rolledBack(part)),
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

export function createModelInversePolicy(store: TurnInverseStore) {
  function planner(document: InverseDocument, query: Query) {
    const context = prepareHolds([document]).get(document.documentId);
    if (!context) throw new Error("Missing inverse hold context");
    const draft = query.draftId ? document.drafts.get(query.draftId) : undefined;
    const view = draft?.doc ?? document.live;
    const own = entries(document, query.threadId);
    const actions = inspectionActions(document.history, own);
    const inspections = new Map<Y.Doc, Inspection>();
    inspections.set(document.live, inspectionContext(context.liveIndex, actions));
    for (const [id, documentDraft] of document.drafts) {
      const index = context.views.get(id);
      if (!index) throw new Error("Missing inverse draft index");
      inspections.set(documentDraft.doc, inspectionContext(index, actions));
    }
    const inspect = (current = view) => {
      const inspection = inspections.get(current);
      if (!inspection) throw new Error("Missing immutable-view inspection");
      return inspection;
    };
    const blocking = new Set<string>();
    const holder = (part: StoredInversePart) =>
      context.liveIndex
        .roots(part.effect)
        .flatMap((root) => [...(context.holds.get(root) ?? [])])
        .find((id) => id !== query.draftId);
    const version = (draftId: string | null) =>
      draftId ? `draft (${document.drafts.get(draftId)?.name ?? "unavailable"})` : "live";
    function refusal(
      part: StoredInversePart,
      handle: string,
      direction: "undo" | "redo",
      inspection: Inspection,
    ): Exclude<DocumentEditResult, { status: "success" }> | null {
      const follow = `Use revert on ${document.uri}, or read it and make a new replace.`;
      if (draft?.frozen)
        return {
          status: "work_archived",
          message: `This draft is archived. Write to an active draft or live version of ${document.uri}.`,
        };
      if (part.origin.kind === "pending" && part.placement.kind === "live")
        return {
          status: `cant_${direction}_applied`,
          message: `The user applied ${handle} to the manuscript. ${follow}`,
        };
      if (!eligible(part))
        return {
          status: `cant_${direction}_discarded`,
          message: `The user ${part.placement.kind === "discarded" ? "discarded" : "settled"} ${handle}; it is already gone. ${follow}`,
        };
      const draftId = part.placement.kind === "pending" ? part.placement.draftId : null;
      if (
        draftId !== query.draftId ||
        (part.placement.kind === "pending" &&
          part.placement.generation !== draft?.documentDraft.generation)
      )
        return {
          status: `cant_${direction}_elsewhere`,
          message: `${handle} is in another version (${version(draftId)}). You can ${direction} only in the version you write to. ${follow}`,
        };
      const held = holder(part);
      if (held) {
        blocking.add(held);
        return {
          status: `cant_${direction}_held`,
          message: `Another draft (${document.drafts.get(held)?.name ?? "unavailable"}) holds a restored copy of ${handle}'s text. The user can apply or discard that draft. ${follow}`,
        };
      }
      const state = inspection.states([part])[0];
      if (state.state !== (direction === "undo" ? "active" : "undone")) {
        const excerpt = store.describePart(document, part);
        return {
          status: `cant_${direction}_changed`,
          message: `${handle} was edited after you wrote it (${JSON.stringify(excerpt.before)} → ${JSON.stringify(excerpt.after)}). ${follow}`,
        };
      }
      return null;
    }
    function revertSelection(entry: Entry, inspection = inspect()) {
      const skipped: string[] = [],
        selection: InverseSelection[] = [];
      const states = inspection.states(entry.parts);
      for (const [i, part] of entry.parts.entries()) {
        const held = holder(part),
          state = states[i];
        if (held) blocking.add(held);
        const reason = !eligible(part)
          ? "already removed"
          : held
            ? `held by the draft in ${document.drafts.get(held)?.name ?? "unavailable"}`
            : inspection.rolledBack(part)
              ? "rolled back"
              : state.state === "undone"
                ? "already removed"
                : state.reasons.includes("inaccessible ancestor")
                  ? "its paragraph was removed"
                  : state.state !== "active"
                    ? "edited since"
                    : null;
        if (reason) {
          const excerpt = store.describePart(document, part);
          skipped.push(
            `${JSON.stringify(excerpt.before)} → ${JSON.stringify(excerpt.after)}: ${reason}`,
          );
        } else selection.push({ part, direction: "invert" });
      }
      return { selection, skipped };
    }
    return { view, draft, own, inspect, refusal, revertSelection, version, blocking };
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
    if (document.removal) return removedFile(document.removal);
    const policy = preparedPolicy ?? planner(document, query),
      own = policy.own,
      actionId = randomUUID();
    if (query.draftId && !policy.draft)
      return {
        status: "cant_undo_elsewhere",
        message: `The draft is unavailable. Read ${document.uri} and make a new replace in your current destination.`,
      };
    if (policy.draft?.frozen)
      return {
        status: "work_archived",
        message: `This draft is archived. Write to an active draft or live version of ${document.uri}.`,
      };
    const scratch = new Y.Doc({ gc: false }),
      history = [...document.history],
      computed: ComputedInverse = { actionId, edits: [], skipped: [] },
      consumes: string[] = [],
      handles: string[] = [],
      skipped: string[] = [];
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(policy.view));
    // Until its first advance, scratch is identical to the locked view.
    let inspection: Inspection | undefined = policy.inspect();
    const currentInspection = () => {
      if (!inspection)
        inspection = inspectionContext(
          prepareEditRoots(scratch, history),
          inspectionActions(history, own),
        );
      return inspection;
    };
    try {
      const apply = (
        selection: InverseSelection[],
        kind: "undo" | "redo" | "revert",
        consumed: string[],
      ) => {
        const stepActionId = kind === "undo" && computed.edits.length ? randomUUID() : actionId;
        const result = currentInspection().index.compute(selection, {
          actionId: stepActionId,
          allocateClient: allocateDocumentClient,
        });
        if (result.skipped.length)
          throw new Error("Inverse classification changed within the scratch plan");
        for (const edit of result.edits) {
          computed.edits.push({ ...edit, actionId: stepActionId });
          const id = randomUUID();
          for (const [ordinal, part] of edit.parts.entries()) {
            Y.applyUpdate(scratch, part.update);
            history.push({
              ...part,
              id: Math.max(0, ...history.map((p) => p.id)) + 1,
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
                    generation: policy.draft?.documentDraft.generation ?? 0,
                    rowId: 0,
                  }
                : { kind: "live", seq: 0 },
              placement: query.draftId
                ? {
                    kind: "pending",
                    draftId: query.draftId,
                    generation: policy.draft?.documentDraft.generation ?? 0,
                    rowId: 0,
                  }
                : { kind: "live", seq: 0 },
            });
          }
        }
        // Neither lineage visibility nor action state survives a scratch advance.
        inspection = undefined;
      };
      if (command.command === "revert") {
        const entry = own.find((entry) => entry.handle === command.edit);
        if (!entry)
          return {
            status: "invalid_write",
            message: `Unknown edit ${command.edit} in ${document.uri}. Read with format: "edits" for a valid handle.`,
          };
        const selection = policy.revertSelection(entry);
        skipped.push(...selection.skipped);
        handles.push(entry.handle);
        if (!selection.selection.length)
          return {
            status: "nothing_to_revert",
            message: `Nothing of ${entry.handle} is left as you wrote it. ${skipped.join("\n")} Read ${document.uri} and make a new replace.`,
          };
        apply(selection.selection, "revert", []);
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
            const current = currentInspection();
            current.states(entry.parts);
            for (const part of entry.parts) {
              const refused = policy.refusal(part, entry.handle, "undo", current);
              if (refused) return refused;
            }
            handles.push(entry.handle);
            apply(
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
              entry.parts
                .filter((part) => action.targets.has(key(part)))
                .map((part) => ({ part, handle: entry.handle })),
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
              .filter((entry) => entry.parts.length)
              .sort(
                (a, b) =>
                  Math.min(...a.parts.map((part) => part.id)) -
                  Math.min(...b.parts.map((part) => part.id)),
              );
            for (const entry of restoring) {
              const current = currentInspection();
              current.states(entry.parts);
              for (const original of entry.parts) {
                const inverse = action.parts.find((part) =>
                  part.targets.some((t) => key(t) === key(original)),
                );
                if (!inverse) throw new Error("Undo action has no inverse for its target");
                const refused = policy.refusal(
                  { ...original, origin: inverse.origin, placement: inverse.placement },
                  entry.handle,
                  "redo",
                  current,
                );
                if (refused) return refused;
              }
              apply(
                entry.parts.map((part) => ({ part, direction: "reapply" })),
                "redo",
                [action.id],
              );
            }
            handles.push(...[...new Set(targets.map((target) => target.handle))]);
            consumes.push(action.id);
          }
        }
      if (!computed.edits.length)
        return {
          status: "nothing_to_revert",
          message: `Nothing is left to reverse in ${document.uri}. Read it and make a new replace.`,
        };
      const before = Y.encodeStateAsUpdate(policy.view),
        after = Y.encodeStateAsUpdate(scratch);
      const committed = preview
        ? { handles: [], updates: [] }
        : await store.commit({
            query,
            kind: command.command,
            plans: [
              {
                document,
                draftId: query.draftId,
                computed,
                consumes,
                skips: [],
                heldDraftIds: [],
              },
            ],
          });
      const parts = computed.edits.reduce((n, edit) => n + edit.parts.length, 0);
      return {
        status: "success",
        actionId,
        room: query.draftId ? draftRoom(query.draftId) : document.liveRoom,
        before,
        after,
        updates: committed.updates,
        ...(command.command === "revert" ? { writeId: committed.handles[0] } : {}),
        message:
          command.command === "revert"
            ? `reverted: ${handles[0]} (${parts} of ${parts + skipped.length} parts)${skipped.map((reason) => `\nnot reverted: ${reason}`).join("")}`
            : `${command.command === "undo" ? "undone" : "redone"}: ${handles.join(", ")}`,
      };
    } finally {
      try {
        if (!preview) await store.markBlocking([...policy.blocking]);
      } finally {
        scratch.destroy();
      }
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
            part.placement.kind === "pending"
              ? (document.drafts.get(part.placement.draftId)?.doc ?? policy.view)
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
        // Revert and Undo are evaluated in the current destination, not the displayed placement.
        inspection.states(page.flatMap((entry) => entry.parts));
        const index = inspection.actions;
        const lines = page.map((entry) => {
          const undos = index.actions.filter((action) =>
            entry.parts.some((part) => action.targets.has(key(part))),
          );
          const popped = index.byPart;
          const fullyUndone = entry.parts.every((part) => popped.has(key(part)));

          const states = entry.parts.map((part) => displayInspection(part).states([part])[0]),
            applied = entry.parts.filter(
              (part) => part.origin.kind === "pending" && part.placement.kind === "live",
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
                : entry.parts.every((part) => !eligible(part))
                  ? "discarded"
                  : states.every((state) => state.state === "undone")
                    ? "undone"
                    : states.some((state) => state.state === "changed")
                      ? "changed"
                      : entry.parts.some((part) => part.placement.kind === "pending")
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
