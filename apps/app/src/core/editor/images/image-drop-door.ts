/**
 * The image door: what dropping files on the manuscript does.
 *
 * `DropLandingExtension` owns the caret, the hint and the event; this decides
 * what a file at a landing means. A browser hides a dragged file's name until
 * the drop, so the drag decides from the types it can read, and the drop
 * decides again from the files.
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import type { FilesDoor } from "../landing/DropLandingExtension";
import type { DropPlan } from "../landing/drop-plan";
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

/** A drag that lists no file at all (Safari hides the list until the drop) is unread too. */
function takesDrag(files: readonly FileLike[]): boolean {
  return files.length === 0 || files.some(takesFile);
}

function plan(editor: Editor, files: readonly FileLike[], landing: Landing): DropPlan {
  if (!takesDrag(files)) return { kind: "refuse", hint: t`Only pictures can be dropped here` };
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
      const file = files.find(
        (candidate): candidate is File => candidate instanceof File && takesFile(candidate),
      );
      if (file) insertImageFile(editor, file, at);
    },
  };
}

export const imageDropDoor: FilesDoor = {
  active(editor, on) {
    imageIngressStorage(editor)?.status.setDropActive(on);
  },
  plan,
  drop(editor, files, landing) {
    const dropped = plan(editor, files, landing);
    if (dropped.kind === "accept") dropped.commit(editor.view);
    // The drag could not read the file's type, so it promised a landing; the
    // drop is where a file that is not a picture is named.
    else if (!takesDrag(files)) {
      imageIngressStorage(editor)?.status.refuse(
        t`${files[0].name} is not an image. Drop a PNG, JPEG, GIF, WEBP, AVIF, or SVG.`,
      );
    }
  },
};
