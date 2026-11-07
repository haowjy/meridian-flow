// Only migration 0098 (frozen by digest) imports these; a new baseline retires this file.
import { canonicalLeaf, renderFilename } from "./document-filename.js";

export function folderDocumentName(filename: string): string {
  return canonicalLeaf(filename);
}

export type NamespaceNameClaim = {
  kind: "document" | "folder";
  filename: string;
};

function namespaceName(claim: NamespaceNameClaim): string {
  return claim.kind === "folder" ? folderDocumentName(claim.filename) : claim.filename;
}

export function sameNamespaceName(left: NamespaceNameClaim, right: NamespaceNameClaim): boolean {
  return left.kind === right.kind
    ? left.filename === right.filename
    : namespaceName(left) === namespaceName(right);
}

type DesiredFilename =
  | { kind: "document"; name: string; extension: string }
  | { kind: "folder"; name: string };

export async function allocateFilename(
  desired: DesiredFilename,
  isTaken: (candidate: NamespaceNameClaim) => boolean | Promise<boolean>,
): Promise<string> {
  for (let suffix = 1; ; suffix += 1) {
    const base = suffix === 1 ? desired.name : `${desired.name} (${suffix})`;
    const filename = desired.kind === "document" ? renderFilename(base, desired.extension) : base;
    if (!(await isTaken({ kind: desired.kind, filename }))) return filename;
  }
}
