/**
 * Content Apply as a merge (contract §2, spec-content-rebase §6): the pure planning half.
 *
 * The writer applies changes he saw. `Y.snapshot` of the draft room at that projection lets the server
 * rebuild exactly the base and draft he looked at (branch docs keep full history), recompute the same
 * changes, compose the chosen ones, and merge the result into live's current text with the rebase's own
 * `rebase` in whole-document context. The Apply wins a same-word conflict and the live text it replaced
 * is reported. Nothing here touches the database or a lock; staging and settlement call it under theirs.
 *
 * Two things come out: the live update, written into live's own doc by `writeBlocks` (fresh live items;
 * no draft bytes ever cross), and the blocks the draft's `review_base` moves to, the same merge computed
 * against the base the draft was last rebased to, so the next rebase keeps every draft change (A3).
 * The base is returned as blocks, never bytes: `settlement` writes it against the branch state it CASes
 * onto, because a stored server-client delta replayed later collides on struct ids (contract §2.3).
 */

import {
  applySpanPatches,
  blocksEqual,
  composeGroups,
  diffBlocks,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  rebase,
  type Tok,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import type { DraftOverride } from "@meridian/contracts/drafts";
import {
  buildDocumentSchema,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import * as Y from "yjs";
import { z } from "zod";

const schema = buildDocumentSchema();

/** What the writer asked for (route body), before staging freezes it into a `ContentMemberInput`. */
export type ContentApplyRequest =
  | { scope: "item"; snapshot?: string }
  | { scope: "changes"; changeIds: string[]; snapshot: string };

/** The durable input of one content member, frozen at staging: `push_lineage.apply_payload`. */
export type ContentMemberInput =
  | { scope: "item"; snapshot: string }
  | { scope: "changes"; changeIds: string[]; snapshot: string };

const ContentMemberInputSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("item"), snapshot: z.string() }).strict(),
  z
    .object({
      scope: z.literal("changes"),
      changeIds: z.array(z.string()).min(1),
      snapshot: z.string(),
    })
    .strict(),
]);

/** The stored input of a lineage row; throws on anything else, since a member can't replan without it. */
export function parseContentMemberInput(raw: unknown): ContentMemberInput {
  return ContentMemberInputSchema.parse(raw);
}

export type ContentApplyPlan = {
  /** Applied to live's doc inside the completion fence. */
  pushUpdate: Uint8Array;
  /** The blocks `review_base` becomes: the same merge, against the base the draft was last rebased to. */
  baseBlocks: PMNode[];
  /** The merged base equals the merged live text, so `base_revision` advances with this Apply. */
  baseIsLive: boolean;
  /** Live text the merge replaced. */
  overrode: DraftOverride[];
  /** The merged live text, for the trail. */
  merged: PMNode[];
};

export type ContentApplyPlanResult =
  | { status: "plan"; plan: ContentApplyPlan }
  /** Live already reads the merge. The base still absorbs the change, so the review empties at once. */
  | { status: "already_live"; baseBlocks: PMNode[]; baseIsLive: boolean }
  | { status: "not_found" };

/**
 * What the writer saw: the draft room as of the snapshot. Null when the server lacks something the
 * snapshot names (a lost sync) or the snapshot is malformed.
 */
export function rebuildSeen(
  branch: Y.Doc,
  snapshot: string,
): { base: PMNode[]; draft: PMNode[] } | null {
  let seen: Y.Doc | null = null;
  try {
    const decoded = Y.decodeSnapshot(Buffer.from(snapshot, "base64"));
    const have = Y.decodeStateVector(Y.encodeStateVector(branch));
    for (const [client, clock] of decoded.sv) if ((have.get(client) ?? 0) < clock) return null;
    seen = Y.createDocFromSnapshot(branch, decoded, createCollabYDoc({ gc: false }));
    return {
      base: readBlocks(seen.getXmlFragment(REVIEW_BASE_FRAGMENT), schema),
      draft: readBlocks(seen.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema),
    };
  } catch {
    return null;
  } finally {
    seen?.destroy();
  }
}

/** The frozen input of a request: its own snapshot, else the draft as it stands now. */
export function freezeContentInput(request: ContentApplyRequest, branchState: Uint8Array) {
  if (request.snapshot !== undefined) return request as ContentMemberInput;
  const branch = createCollabYDoc({ gc: false });
  try {
    Y.applyUpdate(branch, branchState);
    const snapshot = Buffer.from(Y.encodeSnapshot(Y.snapshot(branch))).toString("base64");
    return { scope: "item", snapshot } satisfies ContentMemberInput;
  } finally {
    branch.destroy();
  }
}

/** The text to merge into live: `baseSeen` with the chosen changes applied, or the whole draft. */
function selectPatched(
  seen: { base: PMNode[]; draft: PMNode[] },
  input: ContentMemberInput,
): PMNode[] | null {
  if (input.scope === "item") return seen.draft;
  const projection = projectReview(diffBlocks(seen.base, seen.draft));
  const known = new Set(projection.groups.map((group) => group.id));
  if (input.changeIds.some((id) => !known.has(id))) return null;
  return applySpanPatches(
    seen.base,
    composeGroups(schema, projection, input.changeIds, "apply"),
    "base",
  );
}

function tokText(toks: readonly Tok[]): string {
  let text = "";
  for (const tok of toks) {
    if (tok.kind === "text") text += tok.ws + tok.core;
    else if (tok.kind === "block") text += "\n";
  }
  return text.trim();
}

/** Writes `blocks` into `fragmentName` of a copy of `state` and returns the update since `state`. */
function writtenUpdate(
  state: Uint8Array,
  fragmentName: string,
  blocks: readonly PMNode[],
): Uint8Array {
  const doc = createCollabYDoc({ gc: false });
  try {
    Y.applyUpdate(doc, state);
    const before = Y.encodeStateVector(doc);
    doc.transact(() => writeBlocks(doc.getXmlFragment(fragmentName), schema, blocks), "apply");
    return Y.encodeStateAsUpdate(doc, before);
  } finally {
    doc.destroy();
  }
}

/**
 * Steps 3 and 4 of §2.2. `branchState` is the draft after the catch-up rebase; `liveState` is live's
 * state at the lock cut (staging) or the final pre-push (settlement), stable under the document lock.
 */
export function planContentApply(input: {
  input: ContentMemberInput;
  branchState: Uint8Array;
  liveState: Uint8Array;
}): ContentApplyPlanResult {
  const branch = createCollabYDoc({ gc: false });
  const live = createCollabYDoc({ gc: false });
  try {
    Y.applyUpdate(branch, input.branchState);
    Y.applyUpdate(live, input.liveState);
    const baseNow = readBlocks(branch.getXmlFragment(REVIEW_BASE_FRAGMENT), schema);
    const liveNow = readBlocks(live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
    const seen = rebuildSeen(branch, input.input.snapshot);
    if (!seen) return { status: "not_found" };
    const patched = selectPatched(seen, input.input);
    if (!patched) return { status: "not_found" };

    const intoLive = rebase(schema, seen.base, liveNow, patched);
    const baseIsLive = blocksEqual(baseNow, liveNow);
    const intoBase = baseIsLive ? intoLive : rebase(schema, seen.base, baseNow, patched);
    if (blocksEqual(intoLive.blocks, liveNow)) {
      return {
        status: "already_live",
        baseBlocks: intoBase.blocks,
        baseIsLive: blocksEqual(intoBase.blocks, liveNow),
      };
    }
    return {
      status: "plan",
      plan: {
        pushUpdate: writtenUpdate(input.liveState, PROSEMIRROR_FRAGMENT_NAME, intoLive.blocks),
        baseBlocks: intoBase.blocks,
        baseIsLive,
        overrode: intoLive.conflicts.map((conflict) => ({
          live: tokText(conflict.live),
          applied: tokText(conflict.draft),
        })),
        merged: intoLive.blocks,
      },
    };
  } finally {
    branch.destroy();
    live.destroy();
  }
}
