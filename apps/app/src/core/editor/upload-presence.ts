import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { type UploadFrame, uploads } from "@/core/uploads/upload-store";

import { fileDropHost } from "./file-drop/FileDropExtension";
import {
  type AnnouncedUpload,
  sendIngressMessage,
  uploadsOwnedHere,
} from "./images/image-ingress-runtime";
import type { LocalPresenceFields, PeerAwareness } from "./local-presence";

const UPLOAD_PRESENCE_NAME = "meridianUploadPresence";

const UPLOAD_PRESENCE_FIELD = "uploads";

type UploadPresenceOptions = {
  /**
   * This client's presence, whose owner decides when it is on the wire
   * (`core/editor/local-presence.ts`). Null on an editor with no shared room,
   * which mounts no presence at all.
   *
   * The port rather than the `Awareness` itself: an announcement written while
   * the writer is inside inline review must still be true when they come out,
   * and a raw field write is silently dropped for exactly that span.
   */
  presence: LocalPresenceFields | null;
};

const presencePluginKey = new PluginKey(UPLOAD_PRESENCE_NAME);

function readFrame(value: unknown): UploadFrame | null {
  const frame = value as { width?: unknown; height?: unknown } | null | undefined;
  return typeof frame?.width === "number" && typeof frame.height === "number"
    ? { width: frame.width, height: frame.height }
    : null;
}

function sentElsewhere(peers: PeerAwareness): Map<string, UploadFrame | null> {
  const owners = new Map<string, UploadFrame | null>();
  for (const [clientId, state] of peers.getStates()) {
    if (clientId === peers.clientID) continue;
    const announced = (state as Record<string, unknown> | null)?.[UPLOAD_PRESENCE_FIELD];
    if (!Array.isArray(announced)) continue;
    for (const entry of announced) {
      const token = (entry as { token?: unknown } | null)?.token;
      if (typeof token === "string" && token.length > 0) {
        owners.set(token, readFrame((entry as { frame?: unknown }).frame));
      }
    }
  }
  return owners;
}

function sameFrame(left: UploadFrame | null, right: UploadFrame | null): boolean {
  if (!left || !right) return left === right;
  return left.width === right.width && left.height === right.height;
}

function sameAnnouncement(
  left: readonly AnnouncedUpload[],
  right: readonly AnnouncedUpload[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (upload, index) =>
        upload.token === right[index]?.token &&
        sameFrame(upload.frame, right[index]?.frame ?? null),
    )
  );
}

function sameOwners(
  left: ReadonlyMap<string, UploadFrame | null>,
  right: ReadonlyMap<string, UploadFrame | null>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [token, frame] of left) {
    if (!right.has(token) || !sameFrame(frame, right.get(token) ?? null)) return false;
  }
  return true;
}

export const UploadPresenceExtension = Extension.create<UploadPresenceOptions>({
  name: UPLOAD_PRESENCE_NAME,

  addOptions() {
    return { presence: null };
  },

  addProseMirrorPlugins() {
    const { editor } = this;
    const { presence } = this.options;
    if (!presence) return [];
    const { peers } = presence;

    const sentHere = (): AnnouncedUpload[] => {
      const host = fileDropHost(editor);
      const files = host ? uploads.sending(host.hostDocumentId) : [];
      return [
        ...uploadsOwnedHere(editor),
        ...files.map((token): AnnouncedUpload => ({ token, frame: null })),
      ];
    };

    return [
      new Plugin({
        key: presencePluginKey,

        /**
         * Published from the plugin's own view update, which runs synchronously
         * inside the dispatch that opened the entry. That is what puts the
         * announcement on the wire before the document update carrying the
         * token's slot: a peer never sees a slot in flight with no owner. A
         * file chip's upload begins just before its chip goes in, and the store
         * publishes it then.
         *
         * `published` is what this client has SAID, and the port is what makes
         * that record true: it accepts a write whether or not presence is on
         * the wire right now, so the cache can never hold an announcement that
         * never left.
         */
        view: () => {
          let published: readonly AnnouncedUpload[] = [];
          let received: ReadonlyMap<string, UploadFrame | null> = new Map();

          const publish = () => {
            if (editor.isDestroyed) return;
            const owned = sentHere();
            if (sameAnnouncement(published, owned)) return;
            published = owned;
            presence.setField(UPLOAD_PRESENCE_FIELD, owned);
          };

          const receive = () => {
            if (editor.isDestroyed) return;
            const owners = sentElsewhere(peers);
            if (sameOwners(received, owners)) return;
            received = owners;
            uploads.reportPeers(editor, owners);
            sendIngressMessage(editor, { redraw: true });
          };

          peers.on("change", receive);
          const unsubscribe = uploads.subscribe(publish);
          receive();

          return {
            update: publish,
            destroy: () => {
              peers.off("change", receive);
              unsubscribe();
              uploads.reportPeers(editor, null);
              // The release, through the port for the same reason: a tab closed
              // from inside inline review must not come back as an owner when
              // the next surface resumes presence.
              if (published.length > 0) presence.setField(UPLOAD_PRESENCE_FIELD, []);
            },
          };
        },
      }),
    ];
  },
});
