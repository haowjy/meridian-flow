/** Decode and form-check a frozen Apply click before any command is claimed. */
import {
  applySpanPatches,
  diffBlocks,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  validateSpanPatches,
} from "@meridian/agent-edit/diff";
import type { ApplyClick, ApplyClickRefusalReason } from "@meridian/contracts/branches";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Schema } from "prosemirror-model";
import * as Y from "yjs";

export function checkApplyClick(
  room: Y.Doc,
  request: ApplyClick,
  schema: Schema,
): ApplyClickRefusalReason | null {
  let snapshot: Y.Snapshot;
  try {
    const bytes = Buffer.from(request.snapshot, "base64");
    if (bytes.toString("base64") !== request.snapshot) return "malformed";
    snapshot = Y.decodeSnapshotV2(bytes);
  } catch {
    return "malformed";
  }
  const committed = Y.snapshot(room);
  for (const [client, clock] of snapshot.sv)
    if (clock > (committed.sv.get(client) ?? 0)) return "unsynced";
  for (const [client, ranges] of snapshot.ds.clients) {
    const held = committed.ds.clients.get(client) ?? [];
    for (const range of ranges) {
      let cursor = range.clock;
      for (const tombstone of held) {
        if (tombstone.clock > cursor) break;
        cursor = Math.max(cursor, tombstone.clock + tombstone.len);
        if (cursor >= range.clock + range.len) break;
      }
      if (cursor < range.clock + range.len) return "unsynced";
    }
  }
  const view = new Y.Doc({ gc: false });
  try {
    Y.createDocFromSnapshot(room, snapshot, view);
    const base = readBlocks(view.getXmlFragment(REVIEW_BASE_FRAGMENT), schema);
    const patches = request.baseViewDelta.map((patch) => ({
      ...patch,
      blocks: patch.blocks.map((block) => schema.nodeFromJSON(block)),
    }));
    if (validateSpanPatches(schema, base, patches)) return "malformed";
    const optimistic = applySpanPatches(base, patches, "base");
    const draft = readBlocks(view.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
    const projection = projectReview(diffBlocks(optimistic, draft));
    const ids = new Set(projection.groups.map((group) => group.id));
    if (request.groupIds.some((id) => !ids.has(id))) return "malformed";
    return null;
  } catch {
    return "malformed";
  } finally {
    view.destroy();
  }
}
