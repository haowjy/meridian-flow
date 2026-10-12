// Per-document model stacks over immutable edits, with all-or-nothing action planning.
import { randomUUID } from "node:crypto";
import {
  type ComputedInverse,
  classifyEditParts,
  computeInverse,
  type DocumentEditResult,
  type InverseSelection,
  type ModelInverseCommand,
} from "@meridian/agent-edit/integration";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { prepareHolds } from "./inverse-holds.js";
import type {
  InverseDocument,
  StoredInversePart,
  TurnInverseQuery,
  TurnInverseStore,
} from "./turn-inverse-service.js";

type Query = TurnInverseQuery & { model: true; branchId: string | null };
type Entry = { id: string; handle: string; parts: StoredInversePart[] };
const key = (part: { editId: string; ordinal: number }) => `${part.editId}:${part.ordinal}`;
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
    const entry = map.get(part.editId) ?? { id: part.editId, handle: `w${part.wId}`, parts: [] };
    entry.parts.push(part);
    map.set(part.editId, entry);
  }
  return [...map.values()].sort((a, b) => Number(b.handle.slice(1)) - Number(a.handle.slice(1)));
}
function actions(history: StoredInversePart[], own: Entry[]) {
  const keys = new Set(own.flatMap((entry) => entry.parts.map(key)));
  const grouped = new Map<string, StoredInversePart[]>();
  for (const part of history) {
    if (
      part.kind !== "undo" ||
      rolledBack(history, part) ||
      !part.actionId ||
      !part.targets.some((target) => keys.has(key(target)))
    )
      continue;
    const parts = grouped.get(part.actionId) ?? [];
    parts.push(part);
    grouped.set(part.actionId, parts);
  }
  return [...grouped]
    .map(([id, parts]) => {
      const consumed = new Set(
        history
          .filter(
            (part) =>
              part.kind === "redo" && !rolledBack(history, part) && part.consumes.includes(id),
          )
          .flatMap((part) => part.targets.map(key)),
      );
      const targets = new Set(
        parts.flatMap((part) =>
          part.targets
            .filter((target) => keys.has(key(target)) && !consumed.has(key(target)))
            .map(key),
        ),
      );
      return { id, parts, targets, newest: Math.max(...parts.map((part) => part.id)) };
    })
    .filter((action) => action.targets.size)
    .sort((a, b) => b.newest - a.newest);
}
function rolledBack(history: StoredInversePart[], part: StoredInversePart) {
  return history.some(
    (transition) =>
      transition.kind === "rollback" &&
      transition.targets.some((target) => key(target) === key(part)),
  );
}
function top(history: StoredInversePart[], own: Entry[]) {
  const popped = new Set(actions(history, own).flatMap((action) => [...action.targets]));
  return own.find(
    (entry) =>
      !entry.parts.some((part) => popped.has(key(part))) &&
      !entry.parts.every((part) => rolledBack(history, part)),
  );
}
function candidate(history: StoredInversePart[], own: Entry[]) {
  return actions(history, own).find(
    (action) =>
      !own.some((entry) =>
        entry.parts.some((part) => part.id > action.newest && !rolledBack(history, part)),
      ),
  );
}

export function createModelInversePolicy(store: TurnInverseStore) {
  function planner(document: InverseDocument, query: Query) {
    const context = prepareHolds([document]).get(document.documentId);
    if (!context) throw new Error("Missing inverse hold context");
    const draft = query.branchId ? document.drafts.get(query.branchId) : undefined;
    const view = draft?.doc ?? document.live;
    const blocking = new Set<string>();
    const holder = (part: StoredInversePart) =>
      context.liveIndex
        .roots(part.effect)
        .flatMap((root) => [...(context.holds.get(root) ?? [])])
        .find((id) => id !== query.branchId);
    const version = (branchId: string | null) =>
      branchId ? `draft (${document.drafts.get(branchId)?.name ?? "unavailable"})` : "live";
    function refusal(
      part: StoredInversePart,
      handle: string,
      direction: "undo" | "redo",
      current: Y.Doc,
      history: StoredInversePart[],
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
      const branchId = part.placement.kind === "pending" ? part.placement.branchId : null;
      if (
        branchId !== query.branchId ||
        (part.placement.kind === "pending" &&
          part.placement.generation !== draft?.branch.generation)
      )
        return {
          status: `cant_${direction}_elsewhere`,
          message: `${handle} is in another version (${version(branchId)}). You can ${direction} only in the version you write to. ${follow}`,
        };
      const held = holder(part);
      if (held) {
        blocking.add(held);
        return {
          status: `cant_${direction}_held`,
          message: `Another draft (${document.drafts.get(held)?.name ?? "unavailable"}) holds a restored copy of ${handle}'s text. The user can apply or discard that draft. ${follow}`,
        };
      }
      const state = classifyEditParts(current, history, [part])[0];
      if (state.state !== (direction === "undo" ? "active" : "undone")) {
        const excerpt = store.describePart(document, part);
        return {
          status: `cant_${direction}_changed`,
          message: `${handle} was edited after you wrote it (${JSON.stringify(excerpt.before)} → ${JSON.stringify(excerpt.after)}). ${follow}`,
        };
      }
      return null;
    }
    function revertSelection(entry: Entry, current = view, history = document.history) {
      const skipped: string[] = [],
        selection: InverseSelection[] = [];
      for (const part of entry.parts) {
        const held = holder(part),
          state = classifyEditParts(current, history, [part])[0];
        if (held) blocking.add(held);
        const reason = !eligible(part)
          ? "already removed"
          : held
            ? `held by the draft in ${document.drafts.get(held)?.name ?? "unavailable"}`
            : rolledBack(history, part)
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
    return { view, draft, refusal, revertSelection, version, blocking };
  }
  async function plan(
    document: InverseDocument | undefined,
    query: Query,
    command: ModelInverseCommand,
    preview = false,
  ): Promise<DocumentEditResult> {
    if (!document)
      return {
        status: "document_not_found",
        message: "File not found. Read the project to find the right path.",
      };
    const policy = planner(document, query),
      own = entries(document, query.threadId),
      actionId = randomUUID();
    if (query.branchId && !policy.draft)
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
    try {
      const apply = (
        selection: InverseSelection[],
        kind: "undo" | "redo" | "revert",
        consumed: string[],
      ) => {
        const result = computeInverse(scratch, history, selection, {
          actionId,
          allocateClient: allocateDocumentClient,
        });
        if (result.skipped.length)
          throw new Error("Inverse classification changed within the scratch plan");
        for (const edit of result.edits) {
          computed.edits.push(edit);
          const id = randomUUID();
          for (const [ordinal, part] of edit.parts.entries()) {
            Y.applyUpdate(scratch, part.update);
            history.push({
              ...part,
              id: Math.max(0, ...history.map((p) => p.id)) + 1,
              editId: id,
              ordinal,
              kind,
              actionId,
              consumes: consumed,
              documentId: document.documentId,
              threadId: query.threadId,
              turnId: query.turnId ?? null,
              responseId: query.responseIdentity?.providerResponseId ?? null,
              editScopeId: query.responseIdentity?.editScopeId ?? null,
              actor: "agent",
              wId: null,
              origin: query.branchId
                ? {
                    kind: "pending",
                    branchId: query.branchId,
                    generation: policy.draft?.branch.generation ?? 0,
                    rowId: 0,
                  }
                : { kind: "live", seq: 0 },
              placement: query.branchId
                ? {
                    kind: "pending",
                    branchId: query.branchId,
                    generation: policy.draft?.branch.generation ?? 0,
                    rowId: 0,
                  }
                : { kind: "live", seq: 0 },
            });
          }
        }
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
            const entry = top(history, own);
            if (!entry)
              return {
                status: "nothing_to_undo",
                message: `You have no edits to undo in ${document.uri}. Read it and make a new replace if needed.`,
              };
            for (const part of entry.parts) {
              const refused = policy.refusal(part, entry.handle, "undo", scratch, history);
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
            const action = candidate(history, own);
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
            // A grouped undo is redone oldest edit first. Later originals
            // only become undone again after the earlier ones are restored.
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
              for (const original of entry.parts) {
                const inverse = action.parts.find((part) =>
                  part.targets.some((t) => key(t) === key(original)),
                );
                if (!inverse) throw new Error("Undo action has no inverse for its target");
                const refused = policy.refusal(
                  { ...original, origin: inverse.origin, placement: inverse.placement },
                  entry.handle,
                  "redo",
                  scratch,
                  history,
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
      const writeHandles = preview
        ? []
        : await store.commit({
            query,
            kind: command.command,
            plans: [
              {
                document,
                branchId: query.branchId,
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
        before,
        after,
        ...(command.command === "revert" ? { writeId: writeHandles[0] } : {}),
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
    modelInverse(query: Query, command: ModelInverseCommand): Promise<DocumentEditResult> {
      return store.withLockedDocuments(query, (documents) => plan(documents[0], query, command));
    },
    async modelEdits(query: Query, before?: string): Promise<DocumentEditResult> {
      return store.withLockedDocuments(query, async (documents) => {
        const document = documents[0];
        if (!document)
          return {
            status: "document_not_found",
            message: "File not found. Check the path with ls.",
          };
        const policy = planner(document, query),
          own = entries(document, query.threadId),
          action = candidate(document.history, own),
          topEntry = top(document.history, own);
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
            )
          : null;
        const lines = page.map((entry) => {
          const undo = actions(document.history, own).find((action) =>
            entry.parts.some((part) => action.targets.has(key(part))),
          );
          const states = entry.parts.map(
              (part) =>
                classifyEditParts(
                  part.placement.kind === "pending"
                    ? (document.drafts.get(part.placement.branchId)?.doc ?? policy.view)
                    : document.live,
                  document.history,
                  [part],
                )[0],
            ),
            applied = entry.parts.filter(
              (part) => part.origin.kind === "pending" && part.placement.kind === "live",
            ).length;
          const state = entry.parts.every((part) => rolledBack(document.history, part))
            ? "rolled back"
            : undo
              ? undo.parts.some(
                  (part) => part.actor !== "agent" || part.threadId !== query.threadId,
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
              .map((part) =>
                policy.refusal(part, entry.handle, "undo", policy.view, document.history),
              )
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
          message: [
            `your edits to ${document.uri}, newest first (version: ${policy.version(query.branchId)})`,
            ...lines,
            ...(older.length > 20 ? [`more: before ${page.at(-1)?.handle}`] : []),
          ].join("\n"),
        };
      });
    },
  };
}
