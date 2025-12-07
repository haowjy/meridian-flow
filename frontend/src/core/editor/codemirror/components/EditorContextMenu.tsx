/**
 * Editor Context Menu
 *
 * Right-click menu for formatting commands in the CodeMirror editor.
 * Shows keyboard shortcuts inline for discoverability.
 */

import { ReactNode } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/shared/components/ui/context-menu'
import { Bold, Italic, Code, Heading1, Heading2, List, ListOrdered } from 'lucide-react'
import type { CodeMirrorEditorRef } from '../types'

interface EditorContextMenuProps {
  children: ReactNode
  editorRef: CodeMirrorEditorRef | null
}

// Detect OS for shortcut display
const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')
const modSymbol = isMac ? '\u2318' : 'Ctrl+'
const shiftSymbol = isMac ? '\u21E7' : 'Shift+'

export function EditorContextMenu({ children, editorRef }: EditorContextMenuProps) {
  const handleBold = () => {
    editorRef?.toggleBold()
    editorRef?.focus()
  }

  const handleItalic = () => {
    editorRef?.toggleItalic()
    editorRef?.focus()
  }

  const handleCode = () => {
    editorRef?.toggleInlineCode()
    editorRef?.focus()
  }

  const handleHeading1 = () => {
    editorRef?.toggleHeading(1)
    editorRef?.focus()
  }

  const handleHeading2 = () => {
    editorRef?.toggleHeading(2)
    editorRef?.focus()
  }

  const handleBulletList = () => {
    editorRef?.toggleBulletList()
    editorRef?.focus()
  }

  const handleOrderedList = () => {
    editorRef?.toggleOrderedList()
    editorRef?.focus()
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {/* Text formatting */}
        <ContextMenuItem onSelect={handleBold}>
          <Bold className="mr-2 size-4" />
          Bold
          <ContextMenuShortcut>{modSymbol}B</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={handleItalic}>
          <Italic className="mr-2 size-4" />
          Italic
          <ContextMenuShortcut>{modSymbol}I</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={handleCode}>
          <Code className="mr-2 size-4" />
          Code
          <ContextMenuShortcut>{modSymbol}E</ContextMenuShortcut>
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Headings */}
        <ContextMenuItem onSelect={handleHeading1}>
          <Heading1 className="mr-2 size-4" />
          Heading 1
          <ContextMenuShortcut>{modSymbol}1</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={handleHeading2}>
          <Heading2 className="mr-2 size-4" />
          Heading 2
          <ContextMenuShortcut>{modSymbol}2</ContextMenuShortcut>
        </ContextMenuItem>

        <ContextMenuSeparator />

        {/* Lists */}
        <ContextMenuItem onSelect={handleBulletList}>
          <List className="mr-2 size-4" />
          Bullet List
          <ContextMenuShortcut>{modSymbol}{shiftSymbol}8</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={handleOrderedList}>
          <ListOrdered className="mr-2 size-4" />
          Numbered List
          <ContextMenuShortcut>{modSymbol}{shiftSymbol}7</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
