/** Same-incarnation local Yjs peers; never server admission or persistence ownership. */
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { IndexeddbPersistence } from "y-indexeddb";
import * as sync from "y-protocols/sync";
import * as Y from "yjs";

type PeerMessage = { kind: "hello" | "sync"; payload: Uint8Array };

/** Read the retained y-indexeddb log without borrowing its private compaction cursor. */
function readPersistedUpdates(database: IDBDatabase): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("updates", "readonly");
    const request = transaction.objectStore("updates").getAll();
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? new Error("Local replay aborted"));
  });
}

export class LocalDocumentPeers {
  private readonly channel: BroadcastChannel;
  private stopped = false;
  private replayRequested = false;
  private replay: Promise<void> | null = null;

  constructor(
    private readonly document: Y.Doc,
    private readonly persistence: IndexeddbPersistence,
  ) {
    this.channel = new BroadcastChannel(
      `meridian:document-peers:v1:${collabSchemaKeyTag()}:${encodeURIComponent(persistence.name)}`,
    );
    this.channel.onmessage = this.receive;
    this.document.on("update", this.sendUpdate);
    window.addEventListener("focus", this.wake);
    window.addEventListener("pageshow", this.wake);
    window.document.addEventListener("visibilitychange", this.onVisibility);
    this.wake();
  }

  private send = (kind: PeerMessage["kind"], encoder: encoding.Encoder): void => {
    if (!this.stopped && encoding.length(encoder) > 0)
      this.channel.postMessage({ kind, payload: encoding.toUint8Array(encoder) });
  };

  private receive = ({ data }: MessageEvent<PeerMessage>): void => {
    if (this.stopped || (data.kind !== "hello" && data.kind !== "sync")) return;
    const decoder = decoding.createDecoder(data.payload);
    const reply = encoding.createEncoder();
    while (decoding.hasContent(decoder)) sync.readSyncMessage(decoder, reply, this.document, this);
    // Ask for the joiner's missing edits too. Only hello adds the reciprocal
    // vector; ordinary sync replies cannot start another handshake loop.
    if (data.kind === "hello") sync.writeSyncStep1(reply, this.document);
    this.send("sync", reply);
  };

  private sendUpdate = (update: Uint8Array, origin: unknown): void => {
    if (this.stopped || origin === this) return;
    const encoder = encoding.createEncoder();
    sync.writeUpdate(encoder, update);
    this.send("sync", encoder);
  };

  private wake = (): void => {
    void this.catchUp().catch(reportError);
  };

  private onVisibility = (): void => {
    if (window.document.visibilityState === "visible") this.wake();
  };

  /** Coalesce lifecycle wakes, but replay again if a wake arrives during a read. */
  catchUp(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.replayRequested = true;
    if (this.replay) return this.replay;
    const attempt = (async () => {
      await this.persistence.whenSynced;
      while (!this.stopped && this.replayRequested) {
        this.replayRequested = false;
        const database = this.persistence.db;
        if (!database) throw new Error("Local document persistence is unavailable");
        const updates = await readPersistedUpdates(database);
        if (this.stopped) return;
        Y.transact(
          this.document,
          () => {
            for (const update of updates) Y.applyUpdate(this.document, update, this);
          },
          this,
          false,
        );
        const encoder = encoding.createEncoder();
        sync.writeSyncStep1(encoder, this.document);
        this.send("hello", encoder);
      }
    })().finally(() => {
      if (this.replay === attempt) this.replay = null;
    });
    this.replay = attempt;
    return attempt;
  }

  /** Fence synchronously. Drain must finish before the persistence provider is destroyed. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.channel.close();
    this.document.off("update", this.sendUpdate);
    window.removeEventListener("focus", this.wake);
    window.removeEventListener("pageshow", this.wake);
    window.document.removeEventListener("visibilitychange", this.onVisibility);
  }

  async drain(): Promise<void> {
    this.stop();
    await this.replay;
  }
}
