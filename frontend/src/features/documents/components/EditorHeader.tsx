import { ArrowLeft, Eye, Pencil } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { cn } from '@/lib/utils'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useCollapsiblePanel } from '@/shared/components/layout/CollapsiblePanelContext'
import { closeEditor } from '@/core/lib/panelHelpers'
import { buildBreadcrumbs, formatBreadcrumbs } from '@/core/lib/breadcrumbBuilder'
import type { Document } from '@/features/documents/types/document'
import * as SwitchPrimitive from '@radix-ui/react-switch'

interface EditorHeaderProps {
  document: Document
}

/**
 * Compact editor header with navigation and folder breadcrumbs.
 * Layout: [Back] | [Folder Breadcrumbs] | [Read/Edit Toggle] | [Close]
 * Note: Document name now shown separately in EditorTitle component
 */
export function EditorHeader({ document }: EditorHeaderProps) {
  const folders = useTreeStore((state) => state.folders)
  const editorReadOnly = useUIStore((state) => state.editorReadOnly)
  const toggleEditorReadOnly = useUIStore((state) => state.toggleEditorReadOnly)
  const setEditorReadOnly = useUIStore((state) => state.setEditorReadOnly)
  const { CollapseButton } = useCollapsiblePanel()

  // Build folder breadcrumbs (document name shown separately now)
  const breadcrumbSegments = buildBreadcrumbs(document.folderId, folders, 3)
  const breadcrumbPath = formatBreadcrumbs(breadcrumbSegments) || 'Project Root'

  const handleBack = () => {
    closeEditor()
  }

  const handleToggle = () => {
    toggleEditorReadOnly()
  }

  return (
    <div className={cn(
      "flex items-center gap-2 border-b px-2 py-2",
      editorReadOnly && "bg-muted/20"
    )}>
      {/* Back button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={handleBack}
        aria-label="Back to document tree"
        className="h-8 w-8 flex-shrink-0"
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>

      {/* Folder breadcrumbs only (document name shown separately below) */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-muted-foreground" title={breadcrumbPath}>
          {breadcrumbPath}
        </p>
      </div>

      {/* Read/Edit switch with icons and divider (square style) */}
      <SwitchPrimitive.Root
        checked={!editorReadOnly}
        onCheckedChange={(checked: boolean) => setEditorReadOnly(!checked)}
        aria-label={editorReadOnly ? 'Switch to edit mode' : 'Switch to read-only mode'}
        title={editorReadOnly ? 'Read-only' : 'Edit'}
        className={cn(
          'group relative inline-flex h-8 w-16 flex-shrink-0 items-center rounded-md border border-input',
          'outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] transition-colors',
          // Darker background when read-only (unchecked), lighter when editing (checked)
          'data-[state=unchecked]:bg-muted/70 data-[state=checked]:bg-muted/30'
        )}
      >
        {/* Divider */}
        <span className="pointer-events-none absolute inset-y-1 left-1/2 w-px -translate-x-1/2 bg-border/70" />

        {/* Icons */}
        <span className="pointer-events-none absolute left-0 top-0 z-10 flex h-full w-1/2 items-center justify-center text-muted-foreground group-data-[state=unchecked]:text-foreground">
          <Eye className="h-4 w-4" />
        </span>
        <span className="pointer-events-none absolute right-0 top-0 z-10 flex h-full w-1/2 items-center justify-center pl-1 text-muted-foreground group-data-[state=checked]:text-foreground">
          <Pencil className="h-4 w-4" />
        </span>

        {/* Thumb */}
        <SwitchPrimitive.Thumb
          className={cn(
            'pointer-events-none absolute left-1 top-1 z-0 size-6 rounded-[6px] bg-background shadow-sm transition-transform',
            'data-[state=unchecked]:translate-x-0 data-[state=checked]:translate-x-8'
          )}
        />
      </SwitchPrimitive.Root>

      {/* Collapse button from panel context */}
      <CollapseButton />
    </div>
  )
}
