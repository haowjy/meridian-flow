import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import {
  BookOpenText,
  Copy,
  DotsThree,
  Export,
  FileArrowDown,
  PencilSimple,
  TrashSimple,
} from "@phosphor-icons/react"
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./context-menu"

const meta = {
  title: "UI/ContextMenu",
  component: ContextMenu,
  tags: ["autodocs"],
} satisfies Meta<typeof ContextMenu>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <ContextMenu>
      <ContextMenuTrigger className="flex h-40 w-full max-w-md items-center justify-center rounded-md border border-dashed bg-muted/40 px-6 text-sm text-muted-foreground">
        Right-click this chapter card
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        <ContextMenuLabel>Chapter 18 Actions</ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuItem>
          <PencilSimple className="size-4" />
          Edit Chapter
          <ContextMenuShortcut>Cmd+E</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem>
          <Copy className="size-4" />
          Duplicate Draft
          <ContextMenuShortcut>Cmd+D</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Export className="mr-2 size-4" />
            Export
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem>
              <FileArrowDown className="size-4" />
              Markdown
            </ContextMenuItem>
            <ContextMenuItem>PDF</ContextMenuItem>
            <ContextMenuItem>EPUB</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-destructive">
          <TrashSimple className="size-4" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  ),
}

export const WithSettings: Story = {
  render: function WithSettingsRender() {
    const [showWordCount, setShowWordCount] = useState(true)
    const [showComments, setShowComments] = useState(true)
    const [font, setFont] = useState("editor")

    return (
      <ContextMenu>
        <ContextMenuTrigger className="flex h-40 w-full max-w-md items-center justify-center rounded-md border border-dashed bg-muted/40 px-6 text-sm text-muted-foreground">
          Right-click editor surface
        </ContextMenuTrigger>
        <ContextMenuContent className="w-64">
          <ContextMenuLabel className="flex items-center gap-2">
            <BookOpenText className="size-4" />
            Editor View
          </ContextMenuLabel>
          <ContextMenuSeparator />
          <ContextMenuCheckboxItem
            checked={showWordCount}
            onCheckedChange={setShowWordCount}
          >
            Show Word Count
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={showComments}
            onCheckedChange={setShowComments}
          >
            Show Inline Comments
          </ContextMenuCheckboxItem>
          <ContextMenuSeparator />
          <ContextMenuLabel className="text-xs text-muted-foreground">
            Font Family
          </ContextMenuLabel>
          <ContextMenuRadioGroup value={font} onValueChange={setFont}>
            <ContextMenuRadioItem value="editor">Editor Serif</ContextMenuRadioItem>
            <ContextMenuRadioItem value="sans">Interface Sans</ContextMenuRadioItem>
            <ContextMenuRadioItem value="mono">Monospace</ContextMenuRadioItem>
          </ContextMenuRadioGroup>
        </ContextMenuContent>
      </ContextMenu>
    )
  },
}

export const CompactTrigger: Story = {
  render: () => (
    <ContextMenu>
      <ContextMenuTrigger className="inline-flex h-11 min-w-11 items-center justify-center rounded-md border bg-card px-4">
        <DotsThree className="size-5" />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>Open Thread</ContextMenuItem>
        <ContextMenuItem>Rename Work Item</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  ),
}
