import type { Folder } from "@/features/folders/types/folder";
import type { Document } from "@/features/documents/types/document";
import {
  type TreeFolderDto,
  type TreeDocumentDto,
  fromTreeDocumentDto,
} from "@/types/api";

/**
 * Hierarchical tree node for rendering folder/document structure.
 * Skills are rendered separately in CollapsibleSkillsSection, NOT in the tree.
 * Folders have children (recursive), documents are leaf nodes.
 *
 * This is a discriminated union - TypeScript can narrow the type based on the `type` field:
 * - if (node.type === 'folder') -> node.data is Folder, node.children exists
 * - if (node.type === 'document') -> node.data is Document, node.children is undefined
 */
export type TreeNode =
  | {
      type: "folder";
      id: string;
      name: string;
      children?: TreeNode[];
      data: Folder;
    }
  | {
      type: "document";
      id: string;
      name: string;
      data: Document;
    };

/**
 * Converts nested backend structure to TreeNode format.
 * Backend returns folders with nested folders/documents already built.
 *
 * @param foldersDto - Nested folders from backend /tree endpoint
 * @param documentsDto - Documents at this level
 * @returns TreeNode array ready for rendering
 */
export function convertNestedToTreeNodes(
  foldersDto: TreeFolderDto[],
  documentsDto: TreeDocumentDto[],
): TreeNode[] {
  const nodes: TreeNode[] = [];

  // Convert folders (with their nested children)
  for (const folderDto of foldersDto) {
    const folder: Folder = {
      id: folderDto.id,
      projectId: folderDto.projectId,
      parentId: folderDto.folderId,
      name: folderDto.name,
      createdAt: new Date(folderDto.createdAt),
    };

    // Recursively convert nested children
    const children = convertNestedToTreeNodes(
      folderDto.folders || [],
      folderDto.documents || [],
    );

    nodes.push({
      type: "folder",
      id: folder.id,
      name: folder.name,
      data: folder,
      children: children.length > 0 ? children : undefined,
    });
  }

  // Convert documents at this level
  for (const docDto of documentsDto) {
    const document: Document = fromTreeDocumentDto(docDto);

    nodes.push({
      type: "document",
      id: document.id,
      name: document.filename, // Display full filename with extension
      data: document,
    });
  }

  // Sort: folders first, then documents, alphabetically within each type
  return nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/**
 * Builds hierarchical tree structure from flat folder/document arrays.
 *
 * NOTE: Skills are NOT included in the tree - they are rendered separately
 * in CollapsibleSkillsSection.
 *
 * Algorithm:
 * 1. Start with root items (parentId/folderId === null)
 * 2. Recursively find children for each folder
 * 3. Attach documents to their folders
 * 4. Sort: folders before documents, then alphabetically
 *
 * Performance: O(n) for typical flat structures
 *
 * @param folders - Flat array of folders from backend
 * @param documents - Flat array of documents from backend
 * @returns Nested tree structure ready for rendering
 */
export function buildTree(
  folders: Folder[],
  documents: Document[],
): TreeNode[] {
  /**
   * Recursively find and build children for a given parent.
   * @param parentId - Folder ID to find children for, or null for root
   */
  function findChildren(parentId: string | null): TreeNode[] {
    // Find child folders
    const childFolders = folders
      .filter((folder) => folder.parentId === parentId)
      .map((folder) => ({
        type: "folder" as const,
        id: folder.id,
        name: folder.name,
        data: folder,
        children: findChildren(folder.id), // Recursive call
      }));

    // Find documents in this folder
    const childDocuments = documents
      .filter((doc) => doc.folderId === parentId)
      .map((doc) => ({
        type: "document" as const,
        id: doc.id,
        name: doc.filename, // Display full filename with extension
        data: doc,
      }));

    // Combine and sort: folders -> documents, alphabetically within each type
    // Note: Skills are handled separately in CollapsibleSkillsSection
    const combined = [...childFolders, ...childDocuments];

    return combined.sort((a, b) => {
      // Type-based sorting: folder < document
      if (a.type !== b.type) {
        const typeOrder = { folder: 0, document: 1 };
        return typeOrder[a.type] - typeOrder[b.type];
      }
      // Alphabetical by name within same type
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }

  // Start at root level (parentId/folderId === null)
  return findChildren(null);
}

/**
 * Filters tree nodes by search query (case-insensitive name matching).
 * Folders are included if they contain matching documents or subfolders.
 *
 * @param tree - Tree structure to filter
 * @param query - Search query string
 * @returns Filtered tree (empty if no matches)
 */
export function filterTree(tree: TreeNode[], query: string): TreeNode[] {
  if (!query.trim()) {
    return tree;
  }

  const lowerQuery = query.toLowerCase();

  function filterNode(node: TreeNode): TreeNode | null {
    // Leaf nodes (documents): match by name
    if (node.type === "document") {
      return node.name.toLowerCase().includes(lowerQuery) ? node : null;
    }

    // Folders: match if name matches OR has matching children
    const filteredChildren = node.children
      ? node.children.map(filterNode).filter((n): n is TreeNode => n !== null)
      : [];

    const nameMatches = node.name.toLowerCase().includes(lowerQuery);

    // Include folder if name matches OR has matching children
    if (nameMatches || filteredChildren.length > 0) {
      return {
        ...node,
        children: filteredChildren,
      };
    }

    return null;
  }

  return tree.map(filterNode).filter((n): n is TreeNode => n !== null);
}

/**
 * Generate unique name by appending suffix: "Name", "Name (2)", "Name (3)", etc.
 * Used for auto-generating names for new documents/folders.
 */
export function generateUniqueName(
  baseName: string,
  existingNames: string[],
): string {
  if (!existingNames.includes(baseName)) return baseName;
  let counter = 2;
  while (existingNames.includes(`${baseName} (${counter})`)) counter++;
  return `${baseName} (${counter})`;
}

/**
 * Get all names from tree nodes (both folders and documents).
 * Useful for duplicate checking at a given level.
 */
export function getNodeNames(nodes: TreeNode[]): string[] {
  return nodes.map((n) => n.data.name);
}

/**
 * Find folder node by ID and return its children's names.
 * Used to check for duplicates when creating items inside a folder.
 */
export function getFolderChildNames(
  nodes: TreeNode[],
  folderId: string,
): string[] {
  for (const node of nodes) {
    if (node.type === "folder") {
      if (node.id === folderId) {
        return node.children ? getNodeNames(node.children) : [];
      }
      if (node.children) {
        const found = getFolderChildNames(node.children, folderId);
        if (
          found.length > 0 ||
          node.children.some((c) => c.type === "folder" && c.id === folderId)
        ) {
          return found;
        }
      }
    }
  }
  return [];
}
