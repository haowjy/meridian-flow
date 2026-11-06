/**
 * The image door: what dropping files on the manuscript does.
 *
 * `LandingExtension` owns the caret, the hint and the event; this decides what
 * a file at a landing means. A browser hides a dragged file's name until the
 * drop, so the drag decides from the types it can read, and the drop decides
 * again from the files.
 */

import { t } from "@lingui/core/macro";
import type { DropDoor } from "../landing/drop-plan";
import { snapOutOfCode } from "../landing/inline-snap";
import type { Landing } from "../landing/point-landing";
import { imageIngressStorage } from "./image-ingress-runtime";
import { insertImageFile } from "./image-uploads";
import { acceptsInlineImage, isImageFile } from "./image-workflow";

type FileLike = Pick<File, "type" | "name">;

/**
 * Does this door take the file? The one place that maps a file to accept or
 * refuse. A dragged file whose type the browser would not read counts as taken
 * (Firefox reports `application/x-moz-file`): the drop looks again with the
 * real file.
 */
function takesFile(file: FileLike): boolean {
  const unread = file.name === "" && (file.type === "" || file.type === "application/x-moz-file");
  return unread || isImageFile(file);
}

export const imageDropDoor: DropDoor = {
  lit(editor, on) {
    imageIngressStorage(editor)?.status.setDropActive(on);
  },

  plan(editor, landing, event, phase) {
    const transfer = event.dataTransfer;
    const dropped = phase === "drop" ? Array.from(transfer?.files ?? []) : null;
    // A files drag that carries none at the drop is not ours to name.
    if (dropped?.length === 0) return null;
    const listed: FileLike[] =
      dropped ??
      Array.from(transfer?.items ?? [])
        .filter((item) => item.kind === "file")
        .map((item) => ({ type: item.type, name: "" }));

    // A drag that lists no file at all (Safari hides the list until the drop) is unread too.
    if (listed.length > 0 && !listed.some(takesFile))
      return {
        kind: "refuse",
        hint: t`Only pictures can be dropped here`,
        // The drag could not always read the file's type, so it may have promised
        // a landing; the drop is where a file that is not a picture is named.
        atDrop() {
          imageIngressStorage(editor)?.status.refuse(
            t`${listed[0].name} is not an image. Drop a PNG, JPEG, GIF, WEBP, AVIF, or SVG.`,
          );
        },
      };
    if (landing.kind === "source")
      return { kind: "refuse", hint: t`Can’t put a picture inside code` };

    const at: Landing =
      landing.kind === "inline"
        ? { kind: "inline", pos: snapOutOfCode(editor.state.doc, landing.pos) }
        : landing;
    if (at.kind === "inline" && !acceptsInlineImage(editor.state.doc, at.pos))
      return { kind: "refuse", hint: t`A picture cannot go there.` };

    return {
      kind: "accept",
      pos: at.pos,
      commit() {
        const file = dropped?.find(isImageFile);
        if (file) insertImageFile(editor, file, at);
      },
    };
  },
};
