// Model `revert` planning and `read(format: "edits")` over immutable edits.
import { randomUUID } from "node:crypto";
import type {
  DocumentEditResult,
  InverseSelection,
  ModelInverseCommand,
  PreparedEditRoots,
} from "@meridian/agent-edit/integration";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { partsInChanges } from "./draft-edit-status.js";
import { partKey as key, rolledBackKeys } from "./inverse-actions.js";
import { prepareHolds } from "./inverse-holds.js";
import type {
  InverseDocument,
  StoredInversePart,
  TurnInverseQuery,
  TurnInverseStore,
} from "./turn-inverse-service.js";

type Query = TurnInverseQuery & { model: true; branchId: string | null };
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
    const entry = map.get(part.editId) ?? { id: part.editId, handle: `w${part.wId}`, parts: [] };
    entry.parts.push(part);
    map.set(part.editId, entry);
  }
  return [...map.values()].sort((a, b) => Number(b.handle.slice(1)) - Number(a.handle.slice(1)));
}
function rolledBackFacts(history: StoredInversePart[]) {
  const keys = rolledBackKeys(history);
  return { rolledBack: (part: StoredInversePart) => keys.has(key(part)) };
}
/** Facts belong to one immutable view. Advancing a scratch plan replaces this context. */
function inspectionContext(index: PreparedEditRoots, facts: ReturnType<typeof rolledBackFacts>) {
  const classifications = new Map<string, ReturnType<PreparedEditRoots["classify"]>[number]>();
  return {
    index,
    ...facts,
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
    const draft = query.branchId ? document.drafts.get(query.branchId) : undefined;
    const view = draft?.doc ?? document.live;
    const own = entries(document, query.threadId);
    const facts = rolledBackFacts(document.history);
    const inspections = new Map<Y.Doc, Inspection>();
    inspections.set(document.live, inspectionContext(context.liveIndex, facts));
    for (const [id, branch] of document.drafts) {
      const index = context.views.get(id);
      if (!index) throw new Error("Missing inverse draft index");
      inspections.set(branch.doc, inspectionContext(index, facts));
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
        .find((id) => id !== query.branchId);
    const version = (branchId: string | null) =>
      branchId ? `draft (${document.drafts.get(branchId)?.name ?? "unavailable"})` : "live";
    function revertSelection(entry: Entry, inspection = inspect()) {
      const skipped: string[] = [],
        selection: InverseSelection[] = [];
      const states = inspection.states(entry.parts);
      let total = 0;
      for (const [i, whole] of entry.parts.entries()) {
        // A part the writer edited in one paragraph still reverts the paragraphs they left alone.
        const blocks =
          eligible(whole) && states[i].state === "changed"
            ? inspection.index.blocks(whole)
            : [whole];
        const blockStates = blocks.length > 1 ? inspection.index.classify(blocks) : [states[i]];
        total += blocks.length;
        for (const [j, part] of blocks.entries()) {
          const held = holder(part),
            state = blockStates[j];
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
          } else selection.push({ part });
        }
      }
      return { selection, skipped, total };
    }
    return { view, draft, own, inspect, revertSelection, version, blocking };
  }
  async function revert(
    document: InverseDocument | undefined,
    query: Query,
    command: ModelInverseCommand,
  ): Promise<DocumentEditResult> {
    if (!document)
      return {
        status: "document_not_found",
        message: "File not found. Read the project to find the right path.",
      };
    const policy = planner(document, query),
      actionId = randomUUID();
    if (query.branchId && !policy.draft)
      return {
        status: "nothing_to_revert",
        message: `The draft is unavailable. Read ${document.uri} and make a new replace in your current destination.`,
      };
    if (policy.draft?.frozen)
      return {
        status: "work_archived",
        message: `This draft is archived. Write to an active draft or live version of ${document.uri}.`,
      };
    const scratch = new Y.Doc({ gc: false });
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(policy.view));
    try {
      const entry = policy.own.find((entry) => entry.handle === command.edit);
      if (!entry)
        return {
          status: "invalid_write",
          message: `Unknown edit ${command.edit} in ${document.uri}. Read with format: "edits" for a valid handle.`,
        };
      const { selection, skipped } = policy.revertSelection(entry);
      if (!selection.length)
        return {
          status: "nothing_to_revert",
          message: `Nothing of ${entry.handle} is left as you wrote it. ${skipped.join("\n")} Read ${document.uri} and make a new replace.`,
        };
      const computed = policy.inspect().index.compute(selection, {
        actionId,
        kind: "revert",
        allocateClient: allocateDocumentClient,
      });
      if (computed.skipped.length)
        throw new Error("Inverse classification changed within the scratch plan");
      if (!computed.edits.length)
        return {
          status: "nothing_to_revert",
          message: `Nothing is left to reverse in ${document.uri}. Read it and make a new replace.`,
        };
      for (const edit of computed.edits)
        for (const part of edit.parts) Y.applyUpdate(scratch, part.update);
      const before = Y.encodeStateAsUpdate(policy.view),
        after = Y.encodeStateAsUpdate(scratch);
      const [writeId] = await store.commit({
        query,
        kind: "revert",
        plans: [{ document, branchId: query.branchId, computed, heldDraftIds: [] }],
      });
      const parts = computed.edits.reduce((n, edit) => n + edit.parts.length, 0);
      return {
        status: "success",
        actionId,
        before,
        after,
        writeId,
        message: `reverted: ${entry.handle} (${parts} of ${parts + skipped.length} parts)${skipped.map((reason) => `\nnot reverted: ${reason}`).join("")}`,
      };
    } finally {
      try {
        await store.markBlocking([...policy.blocking]);
      } finally {
        scratch.destroy();
      }
    }
  }
  return {
    modelInverse(query: Query, command: ModelInverseCommand): Promise<DocumentEditResult> {
      return store.withLockedDocuments(query, (documents) => revert(documents[0], query, command));
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
          own = policy.own,
          inspection = policy.inspect();
        if (before && !own.some((entry) => entry.handle === before))
          return {
            status: "invalid_write",
            message: `Unknown edit ${before} in ${document.uri}. Read with format: "edits" without before for valid handles.`,
          };
        const older = own.filter(
            (entry) => !before || Number(entry.handle.slice(1)) < Number(before.slice(1)),
          ),
          page = older.slice(0, 20);
        const displayInspection = (part: StoredInversePart) =>
          policy.inspect(
            part.placement.kind === "pending"
              ? (document.drafts.get(part.placement.branchId)?.doc ?? policy.view)
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
        // Revert is evaluated in the current destination, not the displayed placement.
        inspection.states(page.flatMap((entry) => entry.parts));
        // D13: a draft part's status is read from the draft's text, once per draft.
        const inChange = new Map<StoredInversePart, boolean>();
        for (const [branchId, draft] of document.drafts) {
          const parts = page
            .flatMap((entry) => entry.parts)
            .filter(
              (part) => part.placement.kind === "pending" && part.placement.branchId === branchId,
            );
          if (!parts.length) continue;
          for (const [i, inside] of partsInChanges(draft.doc, parts).entries())
            inChange.set(parts[i], inside);
        }
        const partStatus = (part: StoredInversePart) => {
          if (part.placement.kind === "discarded") return "discarded";
          if (part.placement.kind === "live") return "live";
          const shown = displayInspection(part).states([part])[0];
          // D13: text gone from the draft reads discarded, whoever removed it, ahead of changed.
          if (shown.state === "undone" || shown.textGone) return "discarded";
          return inChange.get(part) === false ? "applied" : "pending";
        };
        const lines = page.map((entry) => {
          const statuses = entry.parts.map(partStatus),
            states = entry.parts.map((part) => displayInspection(part).states([part])[0]),
            applied = statuses.filter((status) => status === "applied").length;
          const state = entry.parts.every((part) => inspection.rolledBack(part))
            ? "rolled back"
            : statuses.every((status) => status !== "discarded") &&
                states.some((state) => state.state === "changed")
              ? "changed"
              : statuses.every((status) => status === statuses[0])
                ? statuses[0]
                : applied
                  ? `partly applied (${applied} of ${entry.parts.length})`
                  : "pending";
          const { selection, total } = policy.revertSelection(entry);
          const revert = selection.length;
          const command = !revert
            ? "none"
            : revert === total
              ? "revert"
              : `revert ${revert} of ${total}`;
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
