import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import {
  PencilSimple,
  Copy,
  TrashSimple,
  DotsThreeVertical,
  FolderOpen,
  Export,
  Gear,
  User,
} from "@phosphor-icons/react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
} from "./dropdown-menu"
import { Button } from "./button"

const meta = {
  title: "UI/DropdownMenu",
  component: DropdownMenu,
  tags: ["autodocs"],
} satisfies Meta<typeof DropdownMenu>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Open Menu</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <PencilSimple className="mr-2 size-4" />
          Edit
          <DropdownMenuShortcut>Cmd+E</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Copy className="mr-2 size-4" />
          Duplicate
          <DropdownMenuShortcut>Cmd+D</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive">
          <TrashSimple className="mr-2 size-4" />
          Delete
          <DropdownMenuShortcut>Del</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
}

export const WithSubmenu: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="More options">
          <DotsThreeVertical className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuItem>
          <FolderOpen className="mr-2 size-4" />
          Open
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Export className="mr-2 size-4" />
            Export As
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>Markdown (.md)</DropdownMenuItem>
            <DropdownMenuItem>Plain Text (.txt)</DropdownMenuItem>
            <DropdownMenuItem>EPUB (.epub)</DropdownMenuItem>
            <DropdownMenuItem>PDF (.pdf)</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <Gear className="mr-2 size-4" />
          Settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
}

export const WithCheckboxes: Story = {
  render: function CheckboxStory() {
    const [showWordCount, setShowWordCount] = useState(true)
    const [showLineNumbers, setShowLineNumbers] = useState(false)
    const [showMinimap, setShowMinimap] = useState(false)

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">View Options</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuLabel>Editor View</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={showWordCount}
            onCheckedChange={setShowWordCount}
          >
            Word Count
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={showLineNumbers}
            onCheckedChange={setShowLineNumbers}
          >
            Line Numbers
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={showMinimap}
            onCheckedChange={setShowMinimap}
          >
            Minimap
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  },
}

export const WithRadioGroup: Story = {
  render: function RadioStory() {
    const [theme, setTheme] = useState("light")

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            <User className="mr-2 size-4" />
            Preferences
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
            <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  },
}
