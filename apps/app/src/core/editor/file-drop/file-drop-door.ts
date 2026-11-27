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
import { type ContextUriScheme, canonicalContextUri } from "@meridian/contracts/context-uri";
import { ASSETS_FOLDER, MAX_UPLOAD_BYTES } from "@meridian/contracts/protocol";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { UploadRefusedError } from "@/client/api/direct-upload";

import { type UploadRun, uploads } from "@/core/uploads/upload-store";
import { fileTooLargeMessage } from "@/lib/upload-limit";

import { anchorRange, type EditorAnchor, resolveAnchorIn } from "../anchors";
import { documentReferenceNode } from "../extensions/at-reference/document-link-insertion";
import { placeNodes } from "../extensions/reference-drop";
import { imageIngressStorage } from "../images/image-ingress-runtime";
import { insertImageFile } from "../images/image-uploads";
import { acceptsInlineImage, isImageFile } from "../images/image-workflow";
import type { DropDoor } from "../landing/drop-plan";
import { snapOutOfUnits } from "../landing/inline-snap";
import type { Landing } from "../landing/point-landing";
import { type FileDropHost, fileDropHost } from "./FileDropExtension";

type FileLike = Pick<File, "type" | "name">;

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
    if (dropped?.length === 0) return null;
    const listed: FileLike[] =
      dropped ??
      Array.from(transfer?.items ?? [])
        .filter((item) => item.kind === "file")
        .map((item) => ({ type: item.type, name: "" }));
    if (landing.kind === "source") return { kind: "refuse", hint: t`Can’t put a file inside code` };

    const picturesOnly =
      listed.length > 0 && listed.every((file) => !isUnread(file) && isImageFile(file));
    const at: Exclude<Landing, { kind: "source" }> =
      landing.kind === "inline"
        ? { kind: "inline", pos: snapOutOfUnits(editor.state.doc, landing.pos) }
        : landing;
    if (picturesOnly) {
      if (at.kind === "inline" && !acceptsInlineImage(editor.state.doc, at.pos))
        return { kind: "refuse", hint: t`Can’t drop here` };
      return {
        kind: "accept",
        pos: at.pos,
        commit: () => void dropFiles(editor, dropped ?? [], at),
      };
    }

    const probe = chipFor(editor, "file", crypto.randomUUID(), "unfiled");
    const placed = probe && placeNodes(editor.view, at, [probe]);
    if (!placed) return { kind: "refuse", hint: t`Can’t drop here` };
    return {
      kind: "accept",
      pos: placed.pos,
      commit: () => void dropFiles(editor, dropped ?? [], at),
    };
  },
};

function chipFor(
  editor: Editor,
  name: string,
  documentId: string,
  scheme: ContextUriScheme,
): PMNode | null {
  let uri: string;
  try {
    uri = canonicalContextUri(scheme, `${ASSETS_FOLDER}/${name}`);
  } catch {
    return null;
  }
  return documentReferenceNode(editor.state.schema, { label: name, documentId, uri });
}

type Reserved = { ok: true; name: string } | { ok: false; reason: unknown };

function sendRun(host: FileDropHost, documentId: string, file: File): UploadRun {
  return async (signal, onProgress) => {
    await host.send({ documentId, file, signal, onProgress });
  };
}

/**
 * Each file in the order the drop lists them: pictures through their lane, the rest as chips.
 *
 * A chip is inserted only after the server holds its upload (`host.reserve`): a second tab that
 * learns of the chip through the document must find the file already reserved, or it would be
 * told the file does not exist. The reserve also names the chip: the name the file takes now. The drop point is carried through whatever the writer types
 * meanwhile.
 */
async function dropFiles(editor: Editor, files: readonly File[], landing: Landing): Promise<void> {
  const status = imageIngressStorage(editor)?.status;
  const host = fileDropHost(editor);
  if (!editor.isEditable || landing.kind === "source") return;

  // The drop point is pinned in the shared document, which survives a peer's update; ProseMirror's
  // own mapping moves a point inside the range the update replaces to that range's edge.
  let kind = landing.kind;
  let pin: EditorAnchor = anchorRange(editor.state, { from: landing.pos, to: landing.pos });
  const pinAt = (pos: number) => {
    pin = anchorRange(editor.state, { from: pos, to: pos });
    kind = "inline";
  };
  const here = (): Exclude<Landing, { kind: "source" }> | null => {
    const found = resolveAnchorIn(editor.state, pin);
    return found && { kind, pos: found.from };
  };

  let run: Array<{ file: File; documentId: string; reserved: Promise<Reserved> }> = [];

  const flush = async () => {
    const entries = run;
    run = [];
    if (entries.length === 0 || !host) return;
    const outcomes = await Promise.all(entries.map(({ reserved }) => reserved));
    if (editor.isDestroyed) return;
    const ready: Array<{ node: PMNode; documentId: string; file: File }> = [];
    outcomes.forEach((outcome, index) => {
      const entry = entries[index];
      if (!entry) return;
      if (!outcome.ok) {
        console.warn("[file-drop] upload refused", outcome.reason);
        status?.refuse(
          outcome.reason instanceof UploadRefusedError
            ? outcome.reason.message
            : t`Couldn't upload`,
        );
        return;
      }
      const node = chipFor(editor, outcome.name, entry.documentId, host.scheme);
      if (node) ready.push({ node, documentId: entry.documentId, file: entry.file });
    });
    if (ready.length === 0) return;
    const at = here();
    const placed =
      at &&
      placeNodes(
        editor.view,
        at,
        ready.map(({ node }) => node),
      );
    if (!placed) {
      status?.refuse(t`Can’t drop here`);
    } else {
      for (const { documentId, file } of ready)
        uploads.begin(documentId, host.hostDocumentId, sendRun(host, documentId, file));
      placed.commit(editor.view);
    }
    pinAt(editor.state.selection.from);
  };

  for (const file of files) {
    if (isImageFile(file)) {
      await flush();
      if (editor.isDestroyed) return;
      const at = here();
      if (!at) {
        status?.refuse(t`Can’t drop here`);
        continue;
      }
      insertImageFile(editor, file, at);
      pinAt(editor.state.selection.from);
      continue;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      status?.refuse(fileTooLargeMessage());
      continue;
    }
    if (!host) {
      status?.refuse(t`Can’t drop here`);
      continue;
    }
    const documentId = crypto.randomUUID();
    const reserved = host.reserve({ documentId, file }).then(
      (name): Reserved => ({ ok: true, name }),
      (reason: unknown): Reserved => ({ ok: false, reason }),
    );
    run.push({ file, documentId, reserved });
  }
  await flush();
}
