import { useState } from "react";
import {
  FileText,
  Folder,
  Archive,
  ChevronRight,
  AlertTriangle,
  EyeOff,
} from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import { DialogFooter } from "@/shared/components/ui/dialog";
import { Checkbox } from "@/shared/components/ui/checkbox";
import { Label } from "@/shared/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { formatFileSize } from "../utils/fileValidation";
import {
  buildFolderTree,
  getSelectionSize,
  getValidFileCount,
} from "../utils/importProcessing";
import type { ImportSelection, FolderTreeNode } from "../types/import";

interface ImportPreviewProps {
  selection: ImportSelection;
  onConfirm: () => void;
  onCancel: () => void;
  overwrite: boolean;
  onOverwriteChange: (overwrite: boolean) => void;
  isProcessing?: boolean;
}

export function ImportPreview({
  selection,
  onConfirm,
  onCancel,
  overwrite,
  onOverwriteChange,
  isProcessing = false,
}: ImportPreviewProps) {
  const [skippedOpen, setSkippedOpen] = useState(false);
  const [filteredOpen, setFilteredOpen] = useState(false);

  const totalSize = getSelectionSize(selection);
  const validCount = getValidFileCount(selection);
  const folderTree = buildFolderTree(selection.folderFiles);

  const hasValidFiles = validCount > 0;

  return (
    <>
      <div className="space-y-3">
        {/* Preview header */}
        <p className="text-muted-foreground text-sm">
          {validCount} file{validCount !== 1 ? "s" : ""} to import (
          {formatFileSize(totalSize)})
        </p>

        {/* Preview list */}
        <div className="max-h-64 overflow-y-auto rounded-md border">
          <div className="space-y-1 p-2">
            {/* Individual files at root */}
            {selection.individualFiles.map((file, index) => (
              <FileItem
                key={`file-${index}`}
                name={file.name}
                size={file.size}
                icon={<FileText className="text-muted-foreground size-4" />}
                suffix="(at root)"
              />
            ))}

            {/* Folder tree */}
            {folderTree && <FolderTreeView node={folderTree} />}

            {/* Zip files */}
            {selection.zipFiles.map((file, index) => (
              <FileItem
                key={`zip-${index}`}
                name={file.name}
                size={file.size}
                icon={<Archive className="text-muted-foreground size-4" />}
                suffix="(archive)"
              />
            ))}

            {/* Empty state */}
            {!hasValidFiles && (
              <p className="text-muted-foreground py-4 text-center text-sm">
                No valid files to import
              </p>
            )}
          </div>
        </div>

        {/* Skipped files warning */}
        {selection.skippedFiles.length > 0 && (
          <Collapsible open={skippedOpen} onOpenChange={setSkippedOpen}>
            <CollapsibleTrigger asChild>
              <button className="flex items-center gap-2 text-sm text-amber-600 hover:text-amber-700">
                <AlertTriangle className="size-4" />
                <span>
                  {selection.skippedFiles.length} unsupported file
                  {selection.skippedFiles.length !== 1 ? "s" : ""} will be
                  skipped
                </span>
                <ChevronRight
                  className={cn(
                    "size-4 transition-transform",
                    skippedOpen && "rotate-90",
                  )}
                />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="text-muted-foreground mt-2 max-h-24 space-y-0.5 overflow-y-auto pl-6 text-xs">
                {selection.skippedFiles.map((name, index) => (
                  <li key={index} className="truncate">
                    {name}
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Filtered system files (expected, not a warning) */}
        {selection.filteredSystemFiles.length > 0 && (
          <Collapsible open={filteredOpen} onOpenChange={setFilteredOpen}>
            <CollapsibleTrigger asChild>
              <button className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-sm">
                <EyeOff className="size-4" />
                <span>
                  {selection.filteredSystemFiles.length} system{" "}
                  {selection.filteredSystemFiles.length !== 1
                    ? "items"
                    : "item"}{" "}
                  excluded
                </span>
                <ChevronRight
                  className={cn(
                    "size-4 transition-transform",
                    filteredOpen && "rotate-90",
                  )}
                />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="text-muted-foreground mt-2 max-h-24 space-y-0.5 overflow-y-auto pl-6 text-xs">
                {selection.filteredSystemFiles.map((item, index) => (
                  <li key={index} className="truncate">
                    <span className="font-medium">{item.name}</span>
                    <span className="text-muted-foreground/60">
                      {" "}
                      — {item.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Overwrite checkbox */}
        <div className="flex items-center space-x-2">
          <Checkbox
            id="overwrite-preview"
            checked={overwrite}
            onCheckedChange={(checked) => onOverwriteChange(checked === true)}
          />
          <Label
            htmlFor="overwrite-preview"
            className="cursor-pointer text-sm font-normal"
          >
            Overwrite existing documents
          </Label>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={isProcessing}>
          Cancel
        </Button>
        <Button onClick={onConfirm} disabled={!hasValidFiles || isProcessing}>
          {isProcessing ? "Processing..." : "Import"}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Single file item in the preview list */
function FileItem({
  name,
  size,
  icon,
  suffix,
  indent = 0,
}: {
  name: string;
  size: number;
  icon: React.ReactNode;
  suffix?: string;
  indent?: number;
}) {
  return (
    <div
      className="flex items-center gap-2 py-0.5 text-sm"
      style={{ paddingLeft: `${indent * 16}px` }}
    >
      {icon}
      <span className="flex-1 truncate">{name}</span>
      <span className="text-muted-foreground text-xs whitespace-nowrap">
        {formatFileSize(size)}
      </span>
      {suffix && (
        <span className="text-muted-foreground/60 text-xs whitespace-nowrap">
          {suffix}
        </span>
      )}
    </div>
  );
}

/** Recursive folder tree view */
function FolderTreeView({
  node,
  depth = 0,
}: {
  node: FolderTreeNode;
  depth?: number;
}) {
  const [open, setOpen] = useState(true);

  if (node.type === "file") {
    return (
      <FileItem
        name={node.name}
        size={node.size || 0}
        icon={<FileText className="text-muted-foreground size-4" />}
        indent={depth}
      />
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          className="hover:bg-muted/50 flex w-full items-center gap-1 rounded py-0.5 text-left text-sm"
          style={{ paddingLeft: `${depth * 16}px` }}
        >
          <ChevronRight
            className={cn("size-4 transition-transform", open && "rotate-90")}
          />
          <Folder className="text-muted-foreground size-4" />
          <span className="truncate">{node.name}/</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {node.children?.map((child, index) => (
          <FolderTreeView key={index} node={child} depth={depth + 1} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
