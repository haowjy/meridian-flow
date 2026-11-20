/**
 * What a session's document holds that a server which admitted it read-only lacks, and which of it
 * the writer wrote (`.context/CONTEXT.md`, "Undeliverable edits").
 *
 * A handshake's difference (`core/transport/handshake-difference.ts`) says what the server lacks.
 * Two things in it are not the writer's and are never counted:
 *
 * - Display writes: what the editor binding writes while drawing (it deletes a node the schema
 *   can't build). A binding write is told from a writer transaction by the sync plugin's own
 *   `addToHistory` meta, which every writer transaction carries and a repair does not. The binding
 *   runs observers with no transaction open, so a repair is never merged into a writer's. This
 *   sorts by where the binding runs: a repair made inside another origin's transaction takes that
 *   origin, and `readRepairedRoot` opens one with no origin, so a new client that reads through it
 *   on a read-only room would be counted.
 * - Everything the document got from the server.
 *
 * A display write travels to other sessions by the peer channel and the copy, so a session that
 * never made the repair still knows it (`noteDisplayUpdate`, `saveDisplayRecord`).
 */
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";

import type { HandshakeDifference } from "./document-session";
import {
  addList,
  addRange,
  type DeleteSet,
  hasMoreThan,
  listOf,
  type RangeList,
  type Ranges,
  rangesOf,
  within,
  without,
} from "./item-ranges";

type DisplayRecord = { inserted: RangeList; deleted: RangeList };

const RECORD_PREFIX = `meridian:display-writes:${collabSchemaKeyTag()}:`;

export class UnsentEdits {
  /** What this session wrote through an editor or the document's Undo and Redo, by client id. */
  private readonly ledgerInserted: Ranges = new Map();
  /** Every client id this document has had: Yjs can reassign it. */
  private readonly ownClients = new Set<number>();
  /** Display writes made here, relayed by a peer tab or read from the copy. */
  private readonly displayInserted: Ranges = new Map();
  private readonly displayDeleted: Ranges = new Map();
  /** Origin of a peer tab's display write applied here: still a display write. */
  readonly relayedOrigin: object = Object.freeze({ display: "relayed" });

  constructor(
    private readonly document: Y.Doc,
    /** The session's local copy, once it is open. Display records live in its `custom` store. */
    private readonly copy: () => IDBDatabase | null,
  ) {
    this.ownClients.add(document.clientID);
    document.on("afterTransaction", this.observe);
  }

  destroy(): void {
    this.document.off("afterTransaction", this.observe);
  }

  /** What the editor binding wrote on its own while drawing, as opposed to a writer transaction. */
  isDisplayWrite(transaction: Y.Transaction): boolean {
    return (
      transaction.origin === this.relayedOrigin ||
      (transaction.origin === ySyncPluginKey && !transaction.meta.has("addToHistory"))
    );
  }

  private readonly observe = (transaction: Y.Transaction): void => {
    const client = this.document.clientID;
    this.ownClients.add(client);
    const display = this.isDisplayWrite(transaction);
    // Every local write that is not the binding's own: typing, Undo and Redo, a Discard. What the
    // transport, the copy and peer tabs apply is not local. An origin-less local write is left out as a repair: the one such write known is `readRepairedRoot`'s, and a writer's transaction always carries an origin.
    const writer = !display && transaction.local && transaction.origin !== null;
    if (!display && !writer) return;
    const inserted = display ? this.displayInserted : this.ledgerInserted;
    const from = transaction.beforeState.get(client) ?? 0;
    const to = transaction.afterState.get(client) ?? 0;
    const deletions = listOf(rangesOf(transaction.deleteSet));
    if (to <= from && deletions.length === 0) return;
    addRange(inserted, client, from, to);
    if (display) addList(this.displayDeleted, deletions);
    if (display && transaction.origin !== this.relayedOrigin) this.saveDisplayRecord();
  };

  /** A peer tab relayed a display write: it is known before anything is decided. */
  noteDisplayUpdate(update: Uint8Array): void {
    const { structs, ds } = Y.decodeUpdate(update);
    for (const struct of structs)
      addRange(
        this.displayInserted,
        struct.id.client,
        struct.id.clock,
        struct.id.clock + struct.length,
      );
    addList(this.displayDeleted, listOf(rangesOf(ds)));
  }

  private recordKey(): string {
    return `${RECORD_PREFIX}${this.document.clientID}`;
  }

  /**
   * Written to the copy in the task that made the write: a session that reads the copy's updates
   * and then its records never holds a repair without its record. A record names this build's
   * schema, because it means "this build could not draw it".
   */
  private saveDisplayRecord(): void {
    const database = this.copy();
    if (!database) return;
    const record: DisplayRecord = {
      inserted: listOf(this.displayInserted),
      deleted: listOf(this.displayDeleted),
    };
    const transaction = database.transaction("custom", "readwrite");
    transaction.onabort = () => reportError(transaction.error);
    transaction.objectStore("custom").put(record, this.recordKey());
  }

  /** Reads every display record of this schema from the copy. Read after its updates. */
  readRecords(): Promise<void> {
    const database = this.copy();
    if (!database) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("custom", "readonly");
      const store = transaction.objectStore("custom");
      const request = store.getAll(IDBKeyRange.bound(RECORD_PREFIX, `${RECORD_PREFIX}￿`));
      transaction.oncomplete = () => {
        for (const record of request.result as DisplayRecord[]) {
          addList(this.displayInserted, record.inserted);
          addList(this.displayDeleted, record.deleted);
        }
        resolve();
      };
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Display record read aborted"));
    });
  }

  /** Whether the difference holds an edit the writer's server lacks: anything but display writes. */
  holdsUndeliverable({ lacking, server }: HandshakeDifference): boolean {
    const update = Y.decodeUpdate(lacking);
    for (const struct of update.structs) {
      if (struct instanceof Y.Skip) continue;
      const { client, clock } = struct.id;
      if (without(clock, clock + struct.length, this.displayInserted.get(client)).length > 0)
        return true;
    }
    const serverDeleted = rangesOf(Y.decodeSnapshot(server).ds);
    const lackingDeleted = this.deletionsLacking(update.ds, serverDeleted);
    return hasMoreThan(lackingDeleted, this.displayDeleted);
  }

  private deletionsLacking(deleteSet: DeleteSet, serverDeleted: Ranges): Ranges {
    const lacking: Ranges = new Map();
    for (const [client, list] of rangesOf(deleteSet))
      for (const [from, to] of list)
        for (const [a, b] of without(from, to, serverDeleted.get(client)))
          addRange(lacking, client, a, b);
    return lacking;
  }

  /**
   * The typing in an undeliverable difference, as the items the server lacks that the writer
   * typed. An item of this session's own client ids is typing only inside the ledger; an item of
   * any other client id counts whole, because something the server lacks was written in this
   * browser by another tab, or by a session before a reload, and the copy does not say how.
   */
  undeliverable({ lacking }: HandshakeDifference): Ranges {
    const typing: Ranges = new Map();
    for (const struct of Y.decodeUpdate(lacking).structs) {
      if (!(struct instanceof Y.Item)) continue;
      const { client, clock } = struct.id;
      const kept = this.ownClients.has(client)
        ? within(this.ledgerInserted, client, clock, clock + struct.length)
        : [[clock, clock + struct.length] as [number, number]];
      for (const [from, to] of kept)
        for (const [a, b] of without(from, to, this.displayInserted.get(client)))
          addRange(typing, client, a, b);
    }
    return typing;
  }
}
