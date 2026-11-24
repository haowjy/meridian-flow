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
import { makeFolders, type TreeActions } from "@/core/project-tree/tree-actions";
import { useTreeVersion } from "@/core/project-tree/tree-version";
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
  create(target: LinkCreationTarget): { node: string; path: string } | null;
  failed: boolean;
};

export function useCreateLinkedDocument(projectId: string | null): CreateLinkedDocument {
  const trees = useProjectTreeViews(projectId ?? "", CREATABLE_LINK_SCHEMES, {
    enabled: projectId !== null,
    version: useTreeVersion(),
  });
  const projectActions = useTreeActions({ kind: "project", projectId });
  const accountActions = useTreeActions({ kind: "account" });
  const [failed, setFailed] = useState(false);

  const create = useCallback(
    (target: LinkCreationTarget) => {
      const tree = trees[target.scheme].tree;
      const actions = target.scheme === "user" ? accountActions : projectActions;
      const made = tree && createAt(tree, actions, target);
      setFailed(made === null);
      return made;
    },
    [accountActions, projectActions, trees],
  );

  return { create, failed };
}

function createAt(
  tree: TreeView,
  actions: TreeActions,
  target: LinkCreationTarget,
): { node: string; path: string } | null {
  const parentId = makeFolders(tree, actions, target.folderPath);
  const { node, path } = actions.create({ parentId, name: target.name, kind: "document" });
  return path ? { node, path } : null;
}
