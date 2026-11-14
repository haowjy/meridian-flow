/**
 * Creating the document a link addresses, from a follow that found nothing
 * there.
 *
 * The document goes at exactly the link's address: its scheme, its folders,
 * and its stored name (`Chapter 13`, whether or not the link wrote `.md`). Only
 * manuscript, kb, and user documents are conjured by a link. Scratch notes are
 * made from a Work's Files tab or by the AI, and Uploads are files a writer
 * brings, so neither is creatable here.
 *
 * The records go into the list's copy at once: the missing folders, then the document in the
 * deepest one that exists. The document is there to open before the server has seen it. A sync
 * failure lands on the document itself. Nothing about the link changes on creation: the project
 * now holds a document at that address, which is a new tree revision, and every resolution
 * scope keyed on it asks again.
 */

import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import { parseContextUri } from "@meridian/contracts/context-uri";
import { useCallback, useState } from "react";
import { useProjectTreeViews } from "@/client/query/useProjectTree";
import { useTreeActions } from "@/client/query/useTreeActions";
import {
  type CreatableLinkScheme,
  isCreatableLinkScheme,
  linkedDocumentName,
} from "@/core/editor/links";
import type { TreeActions } from "@/core/project-tree/tree-actions";
import type { TreeView } from "@/core/project-tree/tree-view";

const CREATABLE_LINK_SCHEMES = [
  "manuscript",
  "kb",
  "user",
] as const satisfies readonly CreatableLinkScheme[];

export type LinkCreationTarget = {
  scheme: CreatableLinkScheme;
  folderPath: string;
  name: string;
};

/** Where Create puts the document for this address, or null when it cannot. */
export function linkCreationTarget(address: string | null): LinkCreationTarget | null {
  if (!address) return null;
  const parsed = parseContextUri(address);
  if (!parsed.ok) return null;
  const { scheme, path } = parsed.value;
  if (!isCreatableLinkScheme(scheme)) return null;
  const folders = path.split("/");
  const leaf = folders.pop();
  if (!leaf) return null;
  const name = linkedDocumentName(leaf);
  if (!name) return null;
  if (![...folders, name].every((segment) => validateContextEntryName(segment).ok)) return null;
  return { scheme, folderPath: folders.join("/"), name };
}

export type CreateLinkedDocument = {
  /** The new document's id, or null when it could not be created. */
  create(target: LinkCreationTarget): string | null;
  failed: boolean;
};

export function useCreateLinkedDocument(projectId: string | null): CreateLinkedDocument {
  const trees = useProjectTreeViews(projectId ?? "", CREATABLE_LINK_SCHEMES, {
    enabled: projectId !== null,
  });
  const projectActions = useTreeActions({ kind: "project", projectId });
  const accountActions = useTreeActions({ kind: "account" });
  const [failed, setFailed] = useState(false);

  const create = useCallback(
    (target: LinkCreationTarget) => {
      const tree = trees[target.scheme].tree;
      const actions = target.scheme === "user" ? accountActions : projectActions;
      const documentId = tree ? createAt(tree, actions, target) : null;
      setFailed(documentId === null);
      return documentId;
    },
    [accountActions, projectActions, trees],
  );

  return { create, failed };
}

/** The deepest folder of the address that exists holds the missing ones, then the document. */
function createAt(tree: TreeView, actions: TreeActions, target: LinkCreationTarget): string | null {
  const folders = target.folderPath.split("/").filter(Boolean);
  const missing: string[] = [];
  let parentId = tree.root.entryId;
  while (folders.length) {
    const found = tree.findPath(`/${folders.join("/")}`);
    if (found?.kind === "dir") {
      parentId = found.entryId;
      break;
    }
    missing.unshift(folders.pop() as string);
  }
  for (const name of missing) {
    const made = actions.create({ parentId, name, kind: "folder" });
    if (!made.ok) return null;
    parentId = made.node;
  }
  const made = actions.create({ parentId, name: target.name, kind: "document" });
  return made.ok ? made.node : null;
}
