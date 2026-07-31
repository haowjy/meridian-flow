/**
 * Who is filling a slot right now, on the one channel that forgets.
 *
 * A slot in flight is a document fact (its `uploadToken`), but the browser
 * filling it is not: the answer stops being true the moment a tab closes, and a
 * fact stored in the document would outlive its own truth and be undoable
 * besides. Awareness is where a fact like that belongs — the same channel the
 * collaborator carets ride, ephemeral by construction and never in anyone's
 * history.
 *
 * So this extension is a transport adapter and nothing more. Outward: what this
 * client is filling, as one field written through the session's presence port
 * (`core/editor/local-presence.ts`) — never onto `Awareness` by hand, because
 * whether this client is visible at all belongs to the session and a raw write
 * during suspension is a silent no-op. Inward: every other client's, into the
 * ingress plugin state, where the decoration that says "uploading elsewhere" is
 * built from it (`pending-images.ts`).
 *
 * Two facts per upload, and no more. The token, because that is the join. The
 * picture's measured shape, because §5.6's promise is that the manuscript does
 * not move when bytes land, and a peer holding an unshaped box would take the
 * reflow the owner was spared. Not the percent and not the bytes: those never
 * leave the browser that has them, and a peer could do nothing with either.
 *
 * It mounts with collaboration rather than beside the ingress door, because a
 * document with no shared room has no elsewhere. Absent, every slot is either
 * this client's or ownerless, which is exactly right.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { LocalPresenceFields, PeerAwareness } from "../local-presence";
import { ingressState, sendIngressMessage, uploadsOwnedHere } from "./image-ingress-runtime";
import type { PendingImageFrame, UploadOwnersElsewhere } from "./pending-images";

export const IMAGE_UPLOAD_PRESENCE_NAME = "meridianImageUploadPresence";

/** The awareness field carrying what one client is filling right now. */
export const IMAGE_UPLOAD_PRESENCE_FIELD = "imageUploads";

/** One in-flight slot as it travels: the join, and the shape to reserve. */
export type AnnouncedUpload = {
  token: string;
  /** Null until the browser has decoded enough of the local file to say. */
  frame: PendingImageFrame | null;
};

export type ImageUploadPresenceOptions = {
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

const presencePluginKey = new PluginKey(IMAGE_UPLOAD_PRESENCE_NAME);

function readFrame(value: unknown): PendingImageFrame | null {
  const frame = value as { width?: unknown; height?: unknown } | null | undefined;
  return typeof frame?.width === "number" && typeof frame.height === "number"
    ? { width: frame.width, height: frame.height }
    : null;
}

/** Every slot some OTHER client says it is filling right now. */
function ownersElsewhere(peers: PeerAwareness): UploadOwnersElsewhere {
  const owners = new Map<string, PendingImageFrame | null>();
  for (const [clientId, state] of peers.getStates()) {
    if (clientId === peers.clientID) continue;
    const announced = (state as { imageUploads?: unknown } | null)?.imageUploads;
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

function sameFrame(left: PendingImageFrame | null, right: PendingImageFrame | null): boolean {
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

function sameOwners(left: UploadOwnersElsewhere, right: UploadOwnersElsewhere): boolean {
  if (left.size !== right.size) return false;
  for (const [token, frame] of left) {
    if (!right.has(token) || !sameFrame(frame, right.get(token) ?? null)) return false;
  }
  return true;
}

export const ImageUploadPresenceExtension = Extension.create<ImageUploadPresenceOptions>({
  name: IMAGE_UPLOAD_PRESENCE_NAME,

  addOptions() {
    return { presence: null };
  },

  addProseMirrorPlugins() {
    const { editor } = this;
    const { presence } = this.options;
    if (!presence) return [];
    const { peers } = presence;

    return [
      new Plugin({
        key: presencePluginKey,

        /**
         * Published from the plugin's own view update, which runs synchronously
         * inside the dispatch that opened the entry. That is what puts the
         * announcement on the wire before the document update carrying the
         * token's slot: a peer never sees a slot in flight with no owner.
         *
         * `published` is what this client has SAID, and the port is what makes
         * that record true: it accepts a write whether or not presence is on
         * the wire right now, so the cache can never hold an announcement that
         * never left.
         */
        view: () => {
          let published: readonly AnnouncedUpload[] = [];

          const publish = () => {
            if (editor.isDestroyed) return;
            const owned = uploadsOwnedHere(editor);
            if (sameAnnouncement(published, owned)) return;
            published = owned;
            presence.setField(IMAGE_UPLOAD_PRESENCE_FIELD, owned);
          };

          const receive = () => {
            if (editor.isDestroyed) return;
            const owners = ownersElsewhere(peers);
            if (sameOwners(ingressState(editor).elsewhere, owners)) return;
            sendIngressMessage(editor, { elsewhere: owners });
          };

          peers.on("change", receive);
          receive();

          return {
            update: publish,
            destroy: () => {
              peers.off("change", receive);
              // The release, through the port for the same reason: a tab closed
              // from inside inline review must not come back as an owner when
              // the next surface resumes presence.
              if (published.length > 0) presence.setField(IMAGE_UPLOAD_PRESENCE_FIELD, []);
            },
          };
        },
      }),
    ];
  },
});
