/** Immutable authority binding and retirement for live document handles. */
import type * as Y from "yjs";
import type { CheckpointAuthority } from "./ports/checkpoint-authority.js";

export class RetiredDocumentHandleError extends Error {
  constructor() {
    super("Document handle belongs to a retired authority generation");
  }
}

const handles = new WeakMap<
  Y.Doc,
  { authority: Readonly<CheckpointAuthority>; retired: boolean }
>();

export function bindDocumentAuthority(doc: Y.Doc, authority: CheckpointAuthority): void {
  const existing = handles.get(doc);
  if (existing) {
    if (
      existing.authority.authorityId !== authority.authorityId ||
      existing.authority.generation !== authority.generation
    ) {
      throw new RetiredDocumentHandleError();
    }
    return;
  }
  handles.set(doc, { authority: Object.freeze({ ...authority }), retired: false });
}

export function documentAuthority(doc: Y.Doc): Readonly<CheckpointAuthority> {
  const handle = handles.get(doc);
  if (!handle) throw new Error("Document handle has no authority binding");
  if (handle.retired) throw new RetiredDocumentHandleError();
  return handle.authority;
}

export function retireDocumentHandle(doc: Y.Doc): void {
  const handle = handles.get(doc);
  if (handle) handle.retired = true;
}

export function isDocumentHandleRetired(doc: Y.Doc): boolean {
  return handles.get(doc)?.retired ?? false;
}
