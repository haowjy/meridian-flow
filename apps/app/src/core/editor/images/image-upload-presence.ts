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
 * So this extension is a transport adapter and nothing more. Outward: the tokens
 * this client owns, published as one awareness field. Inward: the union of every
 * other client's tokens, written into the ingress plugin state, where the
 * decoration that says "uploading elsewhere" is built from it
 * (`pending-images.ts`). No bytes and no percent cross: a peer learns THAT a
 * picture is arriving, never how far along it is.
 *
 * It mounts with collaboration rather than beside the ingress door, because a
 * document with no shared room has no elsewhere. Absent, every slot is either
 * this client's or ownerless, which is exactly right.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Awareness } from "y-protocols/awareness";

import { ingressState, sendIngressMessage, uploadTokensOwnedHere } from "./image-ingress-runtime";

export const IMAGE_UPLOAD_PRESENCE_NAME = "meridianImageUploadPresence";

/** The awareness field carrying one client's in-flight upload tokens. */
export const IMAGE_UPLOAD_PRESENCE_FIELD = "imageUploads";

export type ImageUploadPresenceOptions = {
  /** Null on an editor with no shared room, which mounts no presence at all. */
  awareness: Awareness | null;
};

const presencePluginKey = new PluginKey(IMAGE_UPLOAD_PRESENCE_NAME);

/** Every token some OTHER client says it is uploading right now. */
function ownersElsewhere(awareness: Awareness): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === awareness.clientID) continue;
    const owned = (state as { imageUploads?: unknown } | null)?.imageUploads;
    if (!Array.isArray(owned)) continue;
    for (const token of owned) if (typeof token === "string") tokens.add(token);
  }
  return tokens;
}

function sameTokens(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function sameOwners(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const token of left) if (!right.has(token)) return false;
  return true;
}

export const ImageUploadPresenceExtension = Extension.create<ImageUploadPresenceOptions>({
  name: IMAGE_UPLOAD_PRESENCE_NAME,

  addOptions() {
    return { awareness: null };
  },

  addProseMirrorPlugins() {
    const { editor } = this;
    const { awareness } = this.options;
    if (!awareness) return [];

    return [
      new Plugin({
        key: presencePluginKey,

        /**
         * Published from the plugin's own view update, which runs synchronously
         * inside the dispatch that opened the entry. That is what puts the
         * announcement on the wire before the document update carrying the
         * token's slot: a peer never sees a slot in flight with no owner.
         */
        view: () => {
          let published: readonly string[] = [];

          const publish = () => {
            if (editor.isDestroyed) return;
            const owned = uploadTokensOwnedHere(editor);
            if (sameTokens(published, owned)) return;
            published = owned;
            awareness.setLocalStateField(IMAGE_UPLOAD_PRESENCE_FIELD, owned);
          };

          const receive = () => {
            if (editor.isDestroyed) return;
            const owners = ownersElsewhere(awareness);
            if (sameOwners(ingressState(editor).elsewhere, owners)) return;
            sendIngressMessage(editor, { elsewhere: owners });
          };

          awareness.on("change", receive);
          receive();

          return {
            update: publish,
            destroy: () => {
              awareness.off("change", receive);
              // The release. A destroyed awareness has already dropped its whole
              // local state, and writing to it would resurrect one.
              if (published.length > 0 && awareness.getLocalState() !== null) {
                awareness.setLocalStateField(IMAGE_UPLOAD_PRESENCE_FIELD, []);
              }
            },
          };
        },
      }),
    ];
  },
});
