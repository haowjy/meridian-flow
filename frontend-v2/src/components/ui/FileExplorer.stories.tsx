import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"

import { FileExplorer, type FileExplorerNode } from "./file-explorer"

const MOCK_TREE: FileExplorerNode[] = [
  {
    id: "chapters",
    name: "chapters",
    children: [
      { id: "chapters/28.md", name: "28-lantern-harbor.md" },
      { id: "chapters/29.md", name: "29-tideglass-gate.md" },
      { id: "chapters/30.md", name: "30-oath-ledger.md" },
    ],
  },
  {
    id: "notes",
    name: "notes",
    children: [
      { id: "notes/outline.md", name: "arc-4-outline.md" },
      { id: "notes/characters.md", name: "characters.md" },
    ],
  },
  { id: "README.md", name: "README.md" },
]

const meta = {
  title: "UI/FileExplorer",
  component: FileExplorer,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <div className="h-96 w-48 border border-border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FileExplorer>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: function DefaultStory() {
    const [activeId, setActiveId] = useState("chapters/28.md")
    return (
      <FileExplorer
        nodes={MOCK_TREE}
        activeFileId={activeId}
        defaultExpandedIds={["chapters", "notes"]}
        onFileSelect={setActiveId}
      />
    )
  },
}

export const Loading: Story = {
  args: {
    state: "loading",
  },
}

export const Empty: Story = {
  args: {
    state: "empty",
    onCreateDocument: () => undefined,
  },
}

export const Error: Story = {
  args: {
    state: "error",
    onRetry: () => undefined,
  },
}

export const DeepTree: Story = {
  render: () => (
    <FileExplorer
      nodes={[
        {
          id: "manuscript",
          name: "manuscript",
          children: [
            {
              id: "manuscript/part-1",
              name: "part-1",
              children: [
                { id: "m1", name: "01-prologue.md" },
                { id: "m2", name: "02-fracture.md" },
              ],
            },
          ],
        },
      ]}
      activeFileId="m1"
      defaultExpandedIds={["manuscript", "manuscript/part-1"]}
    />
  ),
}
