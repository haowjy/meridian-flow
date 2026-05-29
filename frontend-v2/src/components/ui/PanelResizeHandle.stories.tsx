import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState, type ComponentProps } from "react"

import { PanelResizeHandle } from "./panel-resize-handle"

const meta = {
  title: "UI/PanelResizeHandle",
  component: PanelResizeHandle,
  tags: ["autodocs"],
} satisfies Meta<typeof PanelResizeHandle>

export default meta
type Story = StoryObj<typeof meta>

/** Satisfies Storybook required-args when stories use custom `render`. */
const panelResizeHandleStoryArgs = {
  value: 200,
  min: 150,
  max: 300,
  defaultValue: 200,
} satisfies ComponentProps<typeof PanelResizeHandle>

export const Vertical: Story = {
  args: panelResizeHandleStoryArgs,
  render: function VerticalStory() {
    const [width, setWidth] = useState(200)
    return (
      <div className="flex h-64 w-full max-w-2xl border border-border">
        <div
          className="shrink-0 bg-muted/30 p-4 text-sm"
          style={{ width }}
        >
          Pane A ({width}px)
        </div>
        <PanelResizeHandle
          orientation="vertical"
          value={width}
          min={150}
          max={300}
          defaultValue={200}
          onResize={setWidth}
          onReset={() => setWidth(200)}
        />
        <div className="min-w-0 flex-1 bg-card p-4 text-sm">Pane B (flex)</div>
      </div>
    )
  },
}

export const Horizontal: Story = {
  args: panelResizeHandleStoryArgs,
  render: function HorizontalStory() {
    const [height, setHeight] = useState(120)
    return (
      <div className="flex h-80 w-full max-w-md flex-col border border-border">
        <div
          className="shrink-0 bg-muted/30 p-4 text-sm"
          style={{ height }}
        >
          Top pane ({height}px)
        </div>
        <PanelResizeHandle
          orientation="horizontal"
          value={height}
          min={80}
          max={240}
          defaultValue={120}
          onResize={setHeight}
          onReset={() => setHeight(120)}
        />
        <div className="min-h-0 flex-1 bg-card p-4 text-sm">Bottom pane</div>
      </div>
    )
  },
}

export const HoverAndFocus: Story = {
  ...Vertical,
  parameters: {
    docs: {
      description: {
        story:
          "Tab to the handle and use arrow keys (Shift for 100px steps). Enter resets; Escape reverts.",
      },
    },
  },
}
