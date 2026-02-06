import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { TreeItemInfoContent } from "./TreeItemInfoContent";
import type { Folder } from "@/features/folders/types/folder";
import type { Document } from "@/features/documents/types/document";

interface FolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: Folder;
  type: "folder";
  documentCount?: number;
  folderCount?: number;
}

interface DocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: Document;
  type: "document";
}

type TreeItemInfoDialogProps = FolderDialogProps | DocumentDialogProps;

/**
 * Dialog wrapper for menu-triggered info display.
 * Provides the same content as HoverCard but accessible via click.
 */
export function TreeItemInfoDialog(props: TreeItemInfoDialogProps) {
  const { open, onOpenChange, type } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>
            {type === "folder" ? "Folder Details" : "Document Details"}
          </DialogTitle>
        </DialogHeader>
        {type === "folder" ? (
          <TreeItemInfoContent
            variant="dialog"
            type="folder"
            item={props.item}
            documentCount={props.documentCount}
            folderCount={props.folderCount}
          />
        ) : (
          <TreeItemInfoContent
            variant="dialog"
            type="document"
            item={props.item}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
