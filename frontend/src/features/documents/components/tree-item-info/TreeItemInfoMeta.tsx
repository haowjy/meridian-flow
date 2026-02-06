import { formatWordCount, formatRelativeTime } from "@/core/lib/formatters";
import type { Folder } from "@/features/folders/types/folder";
import type { Document } from "@/features/documents/types/document";

interface FolderMetaProps {
  type: "folder";
  item: Folder;
  documentCount?: number;
  folderCount?: number;
}

interface DocumentMetaProps {
  type: "document";
  item: Document;
}

type TreeItemInfoMetaProps = FolderMetaProps | DocumentMetaProps;

/**
 * Metadata section for tree item info.
 * Shows counts for folders, word count and last modified for documents.
 */
export function TreeItemInfoMeta(props: TreeItemInfoMetaProps) {
  if (props.type === "folder") {
    const { documentCount, folderCount } = props;
    const hasContent = (documentCount ?? 0) > 0 || (folderCount ?? 0) > 0;

    if (!hasContent) {
      return <div className="text-muted-foreground text-xs">Empty folder</div>;
    }

    return (
      <div className="text-muted-foreground space-y-1 text-xs">
        {documentCount !== undefined && documentCount > 0 && (
          <div>
            {documentCount} {documentCount === 1 ? "document" : "documents"}
          </div>
        )}
        {folderCount !== undefined && folderCount > 0 && (
          <div>
            {folderCount} {folderCount === 1 ? "folder" : "folders"}
          </div>
        )}
      </div>
    );
  }

  // Document metadata
  const { item } = props;
  const hasMetadata = item.wordCount !== undefined || item.updatedAt;

  if (!hasMetadata) return null;

  return (
    <div className="text-muted-foreground space-y-1 text-xs">
      {item.wordCount !== undefined && item.wordCount > 0 && (
        <div>{formatWordCount(item.wordCount)}</div>
      )}
      {item.updatedAt && (
        <div>Modified {formatRelativeTime(item.updatedAt)}</div>
      )}
    </div>
  );
}
