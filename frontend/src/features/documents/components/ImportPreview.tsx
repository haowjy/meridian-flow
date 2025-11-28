import { useState } from 'react'
import { FileText, Folder, Archive, ChevronRight, AlertTriangle, EyeOff } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { DialogFooter } from '@/shared/components/ui/dialog'
import { Checkbox } from '@/shared/components/ui/checkbox'
import { Label } from '@/shared/components/ui/label'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/shared/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { formatFileSize } from '../utils/fileValidation'
import { buildFolderTree, getSelectionSize, getValidFileCount } from '../utils/importProcessing'
import type { ImportSelection, FolderTreeNode } from '../types/import'

interface ImportPreviewProps {
  selection: ImportSelection
  onConfirm: () => void
  onCancel: () => void
  overwrite: boolean
  onOverwriteChange: (overwrite: boolean) => void
  isProcessing?: boolean
}

export function ImportPreview({
  selection,
  onConfirm,
  onCancel,
  overwrite,
  onOverwriteChange,
  isProcessing = false,
}: ImportPreviewProps) {
  const [skippedOpen, setSkippedOpen] = useState(false)
  const [filteredOpen, setFilteredOpen] = useState(false)

  const totalSize = getSelectionSize(selection)
  const validCount = getValidFileCount(selection)
  const folderTree = buildFolderTree(selection.folderFiles)

  const hasValidFiles = validCount > 0

  return (
    <>
      <div className="space-y-3">
        {/* Preview header */}
        <p className="text-sm text-muted-foreground">
          {validCount} file{validCount !== 1 ? 's' : ''} to import ({formatFileSize(totalSize)})
        </p>

        {/* Preview list */}
        <div className="border rounded-md max-h-64 overflow-y-auto">
          <div className="p-2 space-y-1">
            {/* Individual files at root */}
            {selection.individualFiles.map((file, index) => (
              <FileItem
                key={`file-${index}`}
                name={file.name}
                size={file.size}
                icon={<FileText className="size-4 text-muted-foreground" />}
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
                icon={<Archive className="size-4 text-muted-foreground" />}
                suffix="(archive)"
              />
            ))}

            {/* Empty state */}
            {!hasValidFiles && (
              <p className="text-sm text-muted-foreground text-center py-4">
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
                  {selection.skippedFiles.length !== 1 ? 's' : ''} will be skipped
                </span>
                <ChevronRight
                  className={cn(
                    'size-4 transition-transform',
                    skippedOpen && 'rotate-90'
                  )}
                />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-2 text-xs text-muted-foreground space-y-0.5 max-h-24 overflow-y-auto pl-6">
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
              <button className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
                <EyeOff className="size-4" />
                <span>
                  {selection.filteredSystemFiles.length} system{' '}
                  {selection.filteredSystemFiles.length !== 1 ? 'items' : 'item'} excluded
                </span>
                <ChevronRight
                  className={cn(
                    'size-4 transition-transform',
                    filteredOpen && 'rotate-90'
                  )}
                />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-2 text-xs text-muted-foreground space-y-0.5 max-h-24 overflow-y-auto pl-6">
                {selection.filteredSystemFiles.map((item, index) => (
                  <li key={index} className="truncate">
                    <span className="font-medium">{item.name}</span>
                    <span className="text-muted-foreground/60"> — {item.reason}</span>
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
          <Label htmlFor="overwrite-preview" className="text-sm font-normal cursor-pointer">
            Overwrite existing documents
          </Label>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={isProcessing}>
          Cancel
        </Button>
        <Button onClick={onConfirm} disabled={!hasValidFiles || isProcessing}>
          {isProcessing ? 'Processing...' : 'Import'}
        </Button>
      </DialogFooter>
    </>
  )
}

/** Single file item in the preview list */
function FileItem({
  name,
  size,
  icon,
  suffix,
  indent = 0,
}: {
  name: string
  size: number
  icon: React.ReactNode
  suffix?: string
  indent?: number
}) {
  return (
    <div
      className="flex items-center gap-2 text-sm py-0.5"
      style={{ paddingLeft: `${indent * 16}px` }}
    >
      {icon}
      <span className="truncate flex-1">{name}</span>
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {formatFileSize(size)}
      </span>
      {suffix && (
        <span className="text-xs text-muted-foreground/60 whitespace-nowrap">
          {suffix}
        </span>
      )}
    </div>
  )
}

/** Recursive folder tree view */
function FolderTreeView({ node, depth = 0 }: { node: FolderTreeNode; depth?: number }) {
  const [open, setOpen] = useState(true)

  if (node.type === 'file') {
    return (
      <FileItem
        name={node.name}
        size={node.size || 0}
        icon={<FileText className="size-4 text-muted-foreground" />}
        indent={depth}
      />
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          className="flex items-center gap-1 text-sm py-0.5 hover:bg-muted/50 rounded w-full text-left"
          style={{ paddingLeft: `${depth * 16}px` }}
        >
          <ChevronRight
            className={cn('size-4 transition-transform', open && 'rotate-90')}
          />
          <Folder className="size-4 text-muted-foreground" />
          <span className="truncate">{node.name}/</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {node.children?.map((child, index) => (
          <FolderTreeView key={index} node={child} depth={depth + 1} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}
