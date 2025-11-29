import type { Editor as TiptapEditor } from '@tiptap/react'
import { Bold, Italic, Heading1, Heading2, List, ListOrdered, MoreHorizontal } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { ToolbarDivider } from './ToolbarDivider'
import type { SaveStatus } from '@/shared/components/ui/StatusBadge'
import { SaveStatusIcon } from './SaveStatusIcon'
import { cn } from '@/lib/utils'

// Toolbar button group definitions
type FormatButton = {
  icon: LucideIcon
  label: string
  format: string
}

type HeadingButton = {
  icon: LucideIcon
  label: string
  level: 1 | 2
}

type ListButton = {
  icon: LucideIcon
  label: string
  listType: 'bulletList' | 'orderedList'
}

const FORMAT_BUTTONS: FormatButton[] = [
  { icon: Bold, label: 'Bold', format: 'bold' },
  { icon: Italic, label: 'Italic', format: 'italic' },
]

const HEADING_BUTTONS: HeadingButton[] = [
  { icon: Heading1, label: 'Heading 1', level: 1 },
  { icon: Heading2, label: 'Heading 2', level: 2 },
]

const LIST_BUTTONS: ListButton[] = [
  { icon: List, label: 'Bulleted list', listType: 'bulletList' },
  { icon: ListOrdered, label: 'Numbered list', listType: 'orderedList' },
]

interface EditorToolbarProps {
  editor: TiptapEditor | null
  disabled?: boolean
  status: SaveStatus
  lastSaved: Date | null
}

export function EditorToolbar({ editor, disabled: disabledProp = false, status, lastSaved }: EditorToolbarProps) {
  const disabled = !editor || disabledProp
  const wordCount = editor?.storage.characterCount?.words() ?? 0

  const renderButton = (Icon: LucideIcon, label: string, isActive: boolean, onClick: () => void) => (
    <Button
      variant="ghost"
      size="icon"
      className={cn("size-8", isActive && "bg-muted text-foreground")}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <Icon className="size-3" />
    </Button>
  )

  return (
    <div className="flex w-full items-center gap-0.5 px-4 py-2">
      {/* Bold / Italic group */}
      <div className="flex items-center gap-0.5">
        {FORMAT_BUTTONS.map(({ icon, label, format }) => (
          <div key={format}>
            {renderButton(
              icon,
              label,
              editor?.isActive(format) ?? false,
              () => editor?.chain().focus().toggleMark(format).run()
            )}
          </div>
        ))}
      </div>

      <ToolbarDivider className="h-5" />

      {/* Heading group */}
      <div className="flex items-center gap-0.5">
        {HEADING_BUTTONS.map(({ icon, label, level }) => (
          <div key={`heading-${level}`}>
            {renderButton(
              icon,
              label,
              editor?.isActive('heading', { level }) ?? false,
              () => editor?.chain().focus().toggleHeading({ level }).run()
            )}
          </div>
        ))}
      </div>

      <ToolbarDivider className="h-5" />

      {/* List group */}
      <div className="flex items-center gap-0.5">
        {LIST_BUTTONS.map(({ icon, label, listType }) => (
          <div key={listType}>
            {renderButton(
              icon,
              label,
              editor?.isActive(listType) ?? false,
              () => editor?.chain().focus()[listType === 'bulletList' ? 'toggleBulletList' : 'toggleOrderedList']().run()
            )}
          </div>
        ))}
      </div>

      {/* Auto-margin divider pushes More button and Metadata to the right */}
      <div className="ml-auto flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          disabled={disabled}
          aria-label="More"
        >
          <MoreHorizontal className="size-3" />
        </Button>

        <ToolbarDivider className="h-5 mx-0" />

        {/* Metadata: Word Count, Save Status & Last Saved */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground select-none">
          <span>
            {wordCount} {wordCount === 1 ? 'word' : 'words'}
          </span>
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground/80">
            <SaveStatusIcon status={status} className="size-3.5" />
            {lastSaved && (
              <span aria-label="Last saved timestamp">
                {lastSaved.toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
