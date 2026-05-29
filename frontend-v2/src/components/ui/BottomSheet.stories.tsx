import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState, type ComponentProps } from "react"

import { Button } from "./button"
import { BottomSheet } from "./bottom-sheet"

const meta = {
  title: "UI/BottomSheet",
  component: BottomSheet,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof BottomSheet>

export default meta
type Story = StoryObj<typeof meta>

/** Satisfies Storybook required-args when stories use custom `render`. */
const bottomSheetStoryArgs = {
  open: false,
  onOpenChange: () => undefined,
  children: null,
} satisfies ComponentProps<typeof BottomSheet>

function BottomSheetDemo({
  title = "Thread details",
  subtitle,
  withActionBar = false,
}: {
  title?: string
  subtitle?: string
  withActionBar?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [detent, setDetent] = useState(0.5)

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Button type="button" onClick={() => setOpen(true)}>
        Open bottom sheet
      </Button>
      <BottomSheet
        open={open}
        onOpenChange={setOpen}
        activeDetent={detent}
        onDetentChange={setDetent}
        title={title}
        subtitle={subtitle}
        actionBar={
          withActionBar ? (
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1">
                Discard
              </Button>
              <Button type="button" className="flex-1">
                Keep
              </Button>
            </div>
          ) : undefined
        }
      >
        <p className="text-sm text-muted-foreground">
          Scrollable sheet body. Drag the grabber down to dismiss, or tap the
          backdrop. Switch detents with the height controls above.
        </p>
        <ul className="mt-4 space-y-2 text-sm">
          {Array.from({ length: 12 }).map((_, i) => (
            <li key={i} className="rounded-md border border-border p-3">
              List item {i + 1}
            </li>
          ))}
        </ul>
      </BottomSheet>
    </div>
  )
}

export const HalfHeight: Story = {
  args: bottomSheetStoryArgs,
  render: () => <BottomSheetDemo />,
}

export const WithSubtitle: Story = {
  args: bottomSheetStoryArgs,
  render: () => (
    <BottomSheetDemo
      title="More"
      subtitle="Settings, theme, and connection status"
    />
  ),
}

export const WithActionBar: Story = {
  args: bottomSheetStoryArgs,
  render: () => (
    <BottomSheetDemo
      title="Review hunk"
      subtitle="2 of 5"
      withActionBar
    />
  ),
}

export const FullDetent: Story = {
  args: bottomSheetStoryArgs,
  render: function FullDetentStory() {
    const [open, setOpen] = useState(true)
    return (
      <BottomSheet
        open={open}
        onOpenChange={setOpen}
        activeDetent={0.9}
        title="Expanded sheet"
      >
        <p className="text-sm">Opened at 90% detent for detail views.</p>
      </BottomSheet>
    )
  },
}
