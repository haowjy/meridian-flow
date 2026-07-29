/**
 * A picture the clipboard only pointed at.
 *
 * The paste has already landed a link to the address, so the manuscript never
 * holds a `src` the project does not own (`image-workflow.ts`). This is the
 * attempt to do better than that link: read the bytes, put them through the same
 * upload a dropped file takes, and replace the link with the picture. A site
 * that refuses leaves the link exactly where it is, which is the honest end
 * state — so nothing here has anything to undo.
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";

import { type AnchorRange, anchorRange } from "../anchors";
import type { UploadedImage } from "./image-ingress-ports";
import {
  type ImageIngressMessage,
  imageIngressPluginKey,
  imageIngressStorage,
  ingressState,
  nextIngressId,
  sendIngressMessage,
} from "./image-ingress-runtime";
import {
  imageAltFromFilename,
  imageFilenameFromUrl,
  type PastedImageImport,
  pastedImageLinkRange,
} from "./image-workflow";
import { resolvePendingImage } from "./pending-images";

/** Start one import, against the link the paste left where the picture was. */
export function startImageImport(
  editor: Editor,
  pending: PastedImageImport,
  at: AnchorRange,
): void {
  const storage = imageIngressStorage(editor);
  if (!storage?.host) return;
  const link = pastedImageLinkRange(editor.state.doc, at, pending.url);
  if (!link) return;

  const controller = new AbortController();
  const id = nextIngressId("image-import");
  const filename = imageFilenameFromUrl(pending.url);
  sendIngressMessage(editor, {
    set: {
      kind: "import",
      id,
      hold: anchorRange(editor.state, link),
      url: pending.url,
      filename,
      abort: () => controller.abort(),
    },
  });

  const host = storage.host;
  void (async () => {
    try {
      const file = await host.fetchBytes({ url: pending.url, filename, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!file) {
        storage.status.refuse(t`${filename} could not be read from that site. It stayed a link.`);
        sendIngressMessage(editor, { drop: id });
        return;
      }
      const uploaded = await host.upload({
        file,
        alt: pending.alt ?? imageAltFromFilename(filename),
        signal: controller.signal,
        onProgress: () => {},
      });
      if (controller.signal.aborted) return;
      landImport(editor, id, uploaded);
    } catch (error) {
      if (controller.signal.aborted) return;
      storage.status.refuse(
        error instanceof Error ? error.message : t`${filename} did not import. It stayed a link.`,
      );
      sendIngressMessage(editor, { drop: id });
    }
  })();
}

function landImport(editor: Editor, id: string, uploaded: UploadedImage): void {
  const storage = imageIngressStorage(editor);
  if (!editor || editor.isDestroyed || !storage) return;
  const entry = ingressState(editor).pending.get(id);
  if (entry?.kind !== "import") return;
  const link = resolvePendingImage(editor.state, entry);
  const imageType = editor.state.schema.nodes.image;
  if (!link || !imageType || !editor.isEditable) {
    if (!link) storage.status.refuse(t`${entry.filename} imported, but its link had moved on.`);
    sendIngressMessage(editor, { drop: id });
    return;
  }
  storage.assetIndex.remember(uploaded.assetDocumentId, uploaded.assetPath);
  const transaction = editor.state.tr.replaceWith(
    link.from,
    link.to,
    imageType.create({ src: uploaded.src, alt: uploaded.alt, title: null }),
  );
  transaction.setMeta(imageIngressPluginKey, { drop: id } satisfies ImageIngressMessage);
  editor.view.dispatch(transaction);
}
