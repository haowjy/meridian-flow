/** Current-id birth and deletion witnesses for model reads, independent of review roles and restoration links. */
import type * as Y from "yjs";
import type { Author, Provenance } from "./attribution.js";
import { DRAFT_SERVER_CLIENT_ID } from "./draft-base.js";
import { indexRanges } from "./id-index.js";

export type ItemAuthor = Author | { kind: "server" } | { kind: "unknown" };
const indexes = new WeakMap<
  Provenance,
  {
    inserted: ReturnType<typeof indexRanges>;
    deleted: ReturnType<typeof indexRanges>;
    writerInserted: ReturnType<typeof indexRanges>;
    writerDeleted: ReturnType<typeof indexRanges>;
  }
>();
function evidence(provenance: Provenance) {
  let index = indexes.get(provenance);
  if (!index) {
    index = {
      inserted: indexRanges(provenance.parts.map((part) => part.inserted)),
      deleted: indexRanges(provenance.parts.map((part) => part.deleted)),
      writerInserted: indexRanges((provenance.writers ?? []).map((writer) => writer.inserted)),
      writerDeleted: indexRanges((provenance.writers ?? []).map((writer) => writer.deleted)),
    };
    indexes.set(provenance, index);
  }
  return index;
}
function author(provenance: Provenance, part: number, writer: number): ItemAuthor | null {
  if (part >= 0) {
    const { threadId, turnId, toolCallId } = provenance.parts[part];
    return threadId && turnId
      ? { kind: "thread", threadId, turnId, ...(toolCallId ? { toolCallId } : {}) }
      : { kind: "unknown" };
  }
  const receipt = writer >= 0 ? provenance.writers?.[writer] : undefined;
  return receipt ? { kind: "user", userId: receipt.userId } : null;
}
/** Evidence is immutable for the lifetime of its snapshot; indexes are shared by every item read. */
export function originOf(id: Pick<Y.ID, "client" | "clock">, provenance: Provenance): ItemAuthor {
  const index = evidence(provenance);
  return (
    author(
      provenance,
      index.inserted.get(id.client, id.clock),
      index.writerInserted.get(id.client, id.clock),
    ) ??
    (id.client === DRAFT_SERVER_CLIENT_ID
      ? { kind: "server" }
      : { kind: "user", userId: provenance.userId })
  );
}
/** Call for a tombstone at the captured cut. A restored item's ancestor supplies no deletion evidence. */
export function deleterOf(id: Pick<Y.ID, "client" | "clock">, provenance: Provenance): ItemAuthor {
  const index = evidence(provenance);
  return (
    author(
      provenance,
      index.deleted.get(id.client, id.clock),
      index.writerDeleted.get(id.client, id.clock),
    ) ?? { kind: "user", userId: provenance.userId }
  );
}
