/**
 * The files door: what dropping files on a document does.
 *
 * `LandingExtension` owns the caret, the hint and the event; this decides what
 * a file at a landing means. A picture goes through the picture lane and keeps
 * its behaviour. Any other file becomes a chip at the caret, a plain Markdown
 * link to a file that is uploading into `assets/` of the document's own
 * source. Files land in the order the drop lists them, each after the one
 * before; a run of chips is one edit, so one undo takes it back.
 *
 * A browser hides a dragged file's name until the drop, so the drag decides
 * from the types it can read, and the drop decides again from the files.
 */

import { t } from "@lingui/core/macro";
import { classifyFiletype, MAX_UPLOAD_BYTES } from "@meridian/contracts/protocol";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

import { fileTooLargeMessage } from "@/lib/upload-limit";

import { documentReferenceNode } from "../extensions/at-reference/document-link-insertion";
import { placeNodes } from "../extensions/reference-drop";
import { imageIngressStorage } from "../images/image-ingress-runtime";
import type { ImageIngressStore } from "../images/image-ingress-store";
import { insertImageFile } from "../images/image-uploads";
import { acceptsInlineImage, isImageFile } from "../images/image-workflow";
import type { DropDoor } from "../landing/drop-plan";
import { snapOutOfCode } from "../landing/inline-snap";
import type { Landing } from "../landing/point-landing";
import { linkUploads, type UploadRun } from "../links/link-uploads";
import { fileDropHost } from "./FileDropExtension";

type FileLike = Pick<File, "type" | "name">;

/** The folder a dropped file lands in, in the document's own source. */
const ASSETS = "assets";

function isUnread(file: FileLike): boolean {
  // Firefox reports `application/x-moz-file` for a dragged file it will not describe.
  return file.name === "" && (file.type === "" || file.type === "application/x-moz-file");
}

export const fileDropDoor: DropDoor = {
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
    if (landing.kind === "source") return { kind: "refuse", hint: t`Can’t put a file inside code` };

    // Only pictures: the picture lane decides where one may stand.
    const picturesOnly =
      listed.length > 0 && listed.every((file) => !isUnread(file) && isImageFile(file));
    const at: Exclude<Landing, { kind: "source" }> =
      landing.kind === "inline"
        ? { kind: "inline", pos: snapOutOfCode(editor.state.doc, landing.pos) }
        : landing;
    if (picturesOnly) {
      if (at.kind === "inline" && !acceptsInlineImage(editor.state.doc, at.pos))
        return { kind: "refuse", hint: t`A picture cannot go there.` };
      return {
        kind: "accept",
        pos: at.pos,
        commit: () => void dropFiles(editor, dropped ?? [], at),
      };
    }

    // A chip's slot is the same wherever it is: probed with a stand-in, committed with the files.
    const probe = chipFor(editor, "file", crypto.randomUUID(), "unfiled");
    const placed = probe && placeNodes(editor.view, at, [probe]);
    if (!placed) return { kind: "refuse", hint: t`A file can’t go there.` };
    return {
      kind: "accept",
      pos: placed.pos,
      commit: () => void dropFiles(editor, dropped ?? [], at),
    };
  },
};

function chipFor(editor: Editor, name: string, documentId: string, scheme: string): PMNode | null {
  return documentReferenceNode(editor.state.schema, {
    label: name,
    documentId,
    uri: `${scheme}://${ASSETS}/${name}`,
  });
}

type Started = { ok: true; send: UploadRun } | { ok: false; reason: unknown };

/**
 * Text up to the text cap becomes an editable document, not a stored file, and the chip links to
 * it. The writer dropped a file and may expect a file: say what it became once the server has read
 * the bytes and decided.
 */
function tellWhenText(
  file: File,
  send: UploadRun,
  status: ImageIngressStore | undefined,
): UploadRun {
  return async (signal, onProgress) => {
    const result = await send(signal, onProgress);
    if (classifyFiletype(result.fileType).kind === "tracked")
      status?.tell(
        t`${file.name} is text, so it was added as a document in assets. The chip links to it.`,
      );
    return result;
  };
}

/**
 * Each file in the order the drop lists them: pictures through their lane, the rest as chips.
 *
 * A chip is inserted only after the server holds its upload (`host.start`): a second tab that
 * learns of the chip through the document must find the file already reserved, or it would be
 * told the file does not exist. The drop point is carried through whatever the writer types
 * meanwhile.
 */
async function dropFiles(editor: Editor, files: readonly File[], landing: Landing): Promise<void> {
  const status = imageIngressStorage(editor)?.status;
  const host = fileDropHost(editor);
  if (!editor.isEditable || landing.kind === "source") return;

  let at: Exclude<Landing, { kind: "source" }> = landing;
  const follow = ({ transaction }: { transaction: Transaction }) => {
    at = { ...at, pos: transaction.mapping.map(at.pos) };
  };
  editor.on("transaction", follow);

  /** Chips waiting for the next picture or the end of the drop, so a run of them is one edit. */
  let run: Array<{ file: File; documentId: string; started: Promise<Started> }> = [];

  const flush = async () => {
    const entries = run;
    run = [];
    if (entries.length === 0 || !host) return;
    const outcomes = await Promise.all(entries.map(({ started }) => started));
    if (editor.isDestroyed) return;
    const ready: Array<{ node: PMNode; documentId: string; send: UploadRun; file: File }> = [];
    outcomes.forEach((outcome, index) => {
      const entry = entries[index];
      if (!entry) return;
      if (!outcome.ok) {
        status?.refuse(
          outcome.reason instanceof Error ? outcome.reason.message : t`The upload didn’t start.`,
        );
        return;
      }
      const node = chipFor(editor, entry.file.name, entry.documentId, host.scheme);
      if (node)
        ready.push({ node, documentId: entry.documentId, send: outcome.send, file: entry.file });
    });
    if (ready.length === 0) return;
    const placed = placeNodes(
      editor.view,
      at,
      ready.map(({ node }) => node),
    );
    if (!placed) {
      status?.refuse(t`A file can’t go there.`);
    } else {
      // The entries exist before the chips do, so no chip ever draws a gap.
      for (const { documentId, send, file } of ready)
        linkUploads.begin(documentId, host.hostDocumentId, tellWhenText(file, send, status));
      placed.commit(editor.view);
    }
    at = { kind: "inline", pos: editor.state.selection.from };
  };

  try {
    for (const file of files) {
      if (isImageFile(file)) {
        await flush();
        if (editor.isDestroyed) return;
        insertImageFile(editor, file, at);
        at = { kind: "inline", pos: editor.state.selection.from };
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        status?.refuse(fileTooLargeMessage(file.name));
        continue;
      }
      if (!host) {
        status?.refuse(t`Files can’t be added to this document.`);
        continue;
      }
      const documentId = crypto.randomUUID();
      // Settled either way, so a refusal that lands while an earlier run is flushing is no
      // unhandled rejection.
      const started = host.start({ documentId, file }).then(
        (send): Started => ({ ok: true, send }),
        (reason: unknown): Started => ({ ok: false, reason }),
      );
      run.push({ file, documentId, started });
    }
    await flush();
  } finally {
    editor.off("transaction", follow);
  }
}
