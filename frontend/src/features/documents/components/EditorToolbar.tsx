"use client"

import { useRef } from 'react'
import type { Editor as TiptapEditor } from '@tiptap/react'
import { motion, AnimatePresence } from 'framer-motion'
import { Bold, Italic, Heading1, Heading2, List, ListOrdered, MoreHorizontal, Eye, Pencil } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ToolbarIconButton } from './ToolbarIconButton'
import { ToolbarButtonGroup } from './ToolbarButtonGroup'
import { ToolbarDivider } from './ToolbarDivider'
import { EditorStatusInfo } from './EditorStatusInfo'
import { useThumbFollow } from '../hooks/useThumbFollow'
import type { SaveStatus } from '@/shared/components/ui/StatusBadge'

// Toolbar button group definitions - centralized configuration
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
  readOnly: boolean
  onModeChange: (readOnly: boolean) => void
  status: SaveStatus
  lastSaved: Date | null
}

export function EditorToolbar({ editor, disabled: disabledProp = false, readOnly, onModeChange, status, lastSaved }: EditorToolbarProps) {
  const disabled = !editor || disabledProp
  const wordCount = editor?.storage.characterCount?.words() ?? 0

  // Refs for thumb positioning
  const containerRef = useRef<HTMLDivElement>(null)
  const eyeRef = useRef<HTMLButtonElement>(null)
  const pencilCellRef = useRef<HTMLDivElement>(null)

  // Calculate thumb position based on current mode
  // In read-only: tracks Eye button; In edit mode: tracks entire Pencil cell
  const thumbRect = useThumbFollow(
    containerRef,
    (readOnly ? eyeRef : pencilCellRef) as React.RefObject<HTMLElement | null>
  )

  return (
    <div className="tiptap-toolbar flex w-full">
      <div
        ref={containerRef}
        className={cn('tiptap-toolbar__pill')}
        role="toolbar"
        aria-label="Editor toolbar"
        aria-orientation="horizontal"
        data-readonly={readOnly}
        data-editing={!readOnly}
      >
        {/* Moving thumb highlight */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 -z-10 rounded-lg bg-card ring-1 ring-border/60 shadow-xs transition-[transform,width] duration-200 ease-out"
          style={{
            transform: `translateX(${thumbRect?.x ?? 0}px)`,
            width: thumbRect?.w ?? 0,
          }}
        />

        {/* Gray background wrapper - foundation layer, extends full width in edit mode */}
        <div className={cn(
          "flex items-center rounded-lg group overflow-hidden",
          readOnly ? "bg-muted/30" : "bg-muted",
          readOnly ? "ring-1 ring-border/60" : "ring-1 ring-border/30",
          !readOnly && "flex-1"
        )}>
          {/* Eye button - read-only mode toggle */}
          <ToolbarIconButton
            ref={eyeRef}
            icon={<Eye className="h-4.5 w-4.5" />}
            aria-label="Read-only mode"
            aria-pressed={readOnly}
            isActive={readOnly}
            variant="toggleReadOnly"
            onClick={() => onModeChange(!readOnly)}
            className={cn(
              "rounded-r-none border-r-0",
              !readOnly && "hover:border-r"
            )}
          />

          {/* Pencil cell - wraps edit mode button and controls
              In edit mode: gets white bg (floats above gray), expands to fill width */}
          <div
            ref={pencilCellRef}
            className={cn(
              "flex items-center gap-0.5 rounded-l-none overflow-hidden transition-all duration-200",
              !readOnly && "flex-1 bg-card ring-1 ring-border/60 rounded-lg group-hover:ring-border"
            )}
          >
            {/* Pencil button - edit mode toggle */}
            <ToolbarIconButton
              icon={<Pencil className="h-4.5 w-4.5" />}
              aria-label="Edit mode"
              aria-pressed={!readOnly}
              isActive={!readOnly}
              variant="toggleEdit"
              onClick={() => onModeChange(!readOnly)}
              className={cn(
                readOnly ? "rounded-l-none rounded-r-lg" : "rounded-l-lg"
              )}
            />

            {/* Edit controls - only visible in edit mode */}
            <AnimatePresence>
              {!readOnly && (
                <motion.div
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: "auto" }}
                  exit={{ opacity: 0, width: 0 }}
                  transition={{ type: "tween", duration: 0.2 }}
                  className="flex items-center gap-0.5 overflow-hidden flex-1"
                >
                  <ToolbarDivider />

                {/* Bold / Italic group */}
                <ToolbarButtonGroup gap="tight">
                  {FORMAT_BUTTONS.map(({ icon: Icon, label, format }) => (
                    <ToolbarIconButton
                      key={format}
                      icon={<Icon className="h-4 w-4" />}
                      aria-label={label}
                      disabled={disabled}
                      isActive={editor?.isActive(format) ?? false}
                      onClick={() => editor?.chain().focus().toggleMark(format).run()}
                    />
                  ))}
                </ToolbarButtonGroup>

                <ToolbarDivider />

                {/* Heading group */}
                <ToolbarButtonGroup gap="tight">
                  {HEADING_BUTTONS.map(({ icon: Icon, label, level }) => (
                    <ToolbarIconButton
                      key={`heading-${level}`}
                      icon={<Icon className="h-4 w-4" />}
                      aria-label={label}
                      disabled={disabled}
                      isActive={editor?.isActive('heading', { level }) ?? false}
                      onClick={() => editor?.chain().focus().toggleHeading({ level }).run()}
                    />
                  ))}
                </ToolbarButtonGroup>

                <ToolbarDivider />

                {/* List group */}
                <ToolbarButtonGroup gap="tight">
                  {LIST_BUTTONS.map(({ icon: Icon, label, listType }) => (
                    <ToolbarIconButton
                      key={listType}
                      icon={<Icon className="h-4 w-4" />}
                      aria-label={label}
                      disabled={disabled}
                      isActive={editor?.isActive(listType) ?? false}
                      onClick={() => editor?.chain().focus()[listType === 'bulletList' ? 'toggleBulletList' : 'toggleOrderedList']().run()}
                    />
                  ))}
                </ToolbarButtonGroup>

                {/* Auto-margin divider pushes More button to the right */}
                <ToolbarDivider auto />

                {/* More button - right-aligned */}
                <ToolbarButtonGroup gap="normal">
                  <ToolbarIconButton
                    icon={<MoreHorizontal className="h-4 w-4" />}
                    aria-label="More"
                    disabled={disabled}
                  />
                </ToolbarButtonGroup>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Status info - floats right, outside toolbar pill in read-only mode */}
      {readOnly && (
        <EditorStatusInfo
          wordCount={wordCount}
          status={status}
          lastSaved={lastSaved}
          className="ml-auto"
        />
      )}
    </div>
  )
}
