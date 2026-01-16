import { EditableThreadTitle } from './EditableThreadTitle'
import { ThreadTitleEditor } from './ThreadTitleEditor'

interface ProgressiveBreadcrumbProps {
  threadTitle: string | null
  isEditing: boolean
  onStartEdit: () => void
  onSubmitEdit: (title: string) => void
  onCancelEdit: () => void
  onRename?: () => void
  onDelete?: () => void
}

/**
 * Thread title breadcrumb for ThreadHeader.
 *
 * Displays the thread title with optional editing capabilities.
 *
 * Architecture:
 * - Eliminates code duplication between view/edit modes in ThreadHeader
 * - Single source of truth for breadcrumb structure
 * - Same layout whether viewing or editing (isEditing just swaps components)
 */
export function ProgressiveBreadcrumb({
  threadTitle,
  isEditing,
  onStartEdit,
  onSubmitEdit,
  onCancelEdit,
  onRename,
  onDelete,
}: ProgressiveBreadcrumbProps) {
  return (
    <div className="group flex-1 flex items-center gap-2 text-sm min-w-0">
      {/* Thread title */}
      {/* Fixed height prevents layout shift when switching between view/edit modes */}
      <div className="flex-1 min-w-0 h-8 flex items-center">
        {isEditing ? (
          <ThreadTitleEditor
            initialValue={threadTitle ?? 'Untitled Thread'}
            onSubmit={onSubmitEdit}
            onCancel={onCancelEdit}
            widthClass="w-full md:w-3/5"
          />
        ) : (
          <EditableThreadTitle
            threadTitle={threadTitle}
            onEdit={onStartEdit}
            onRename={onRename}
            onDelete={onDelete}
          />
        )}
      </div>
    </div>
  )
}
