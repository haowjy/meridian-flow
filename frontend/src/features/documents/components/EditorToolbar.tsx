'use client'

import type { Editor as TiptapEditor } from '@tiptap/react'
import { Bold, Italic, Heading1, Heading2, List, ListOrdered, MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'

interface EditorToolbarProps {
  editor: TiptapEditor | null
  disabled?: boolean
}

export function EditorToolbar({ editor, disabled: disabledProp = false }: EditorToolbarProps) {
  const disabled = !editor || disabledProp

  const buttonClass = (isActive: boolean, extra?: string) =>
    cn(
      'inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors',
      disabled
        ? 'opacity-50 text-muted-foreground'
        : isActive
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent',
      extra
    )

  return (
    <div className="px-4 py-1.5">
      <div className="flex items-center gap-1 rounded-full bg-card/80 px-2.5 py-1 shadow-sm ring-1 ring-border/40">
        <button
          type="button"
          className={buttonClass(editor?.isActive('bold') ?? false)}
          disabled={disabled}
          aria-label="Bold"
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <Bold className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={buttonClass(editor?.isActive('italic') ?? false)}
          disabled={disabled}
          aria-label="Italic"
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <Italic className="h-4 w-4" />
        </button>
        <div className="mx-1 h-4 w-px bg-border/40" />
        <button
          type="button"
          className={buttonClass(editor?.isActive('heading', { level: 1 }) ?? false)}
          disabled={disabled}
          aria-label="Heading 1"
          onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
        >
          <Heading1 className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={buttonClass(editor?.isActive('heading', { level: 2 }) ?? false)}
          disabled={disabled}
          aria-label="Heading 2"
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 className="h-4 w-4" />
        </button>
        <div className="mx-1 h-4 w-px bg-border/40" />
        <button
          type="button"
          className={buttonClass(editor?.isActive('bulletList') ?? false)}
          disabled={disabled}
          aria-label="Bulleted list"
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <List className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={buttonClass(editor?.isActive('orderedList') ?? false)}
          disabled={disabled}
          aria-label="Numbered list"
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered className="h-4 w-4" />
        </button>
        <div className="mx-1 h-4 w-px bg-border/40" />
        <button
          type="button"
          className={buttonClass(false, 'ml-1')}
          disabled={disabled}
          aria-label="More"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
