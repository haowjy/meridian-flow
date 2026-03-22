import type { Meta, StoryObj } from "@storybook/react-vite"
import { Separator } from "./separator"

const meta = {
  title: "UI/Separator",
  component: Separator,
  tags: ["autodocs"],
  argTypes: {
    orientation: {
      control: "select",
      options: ["horizontal", "vertical"],
    },
  },
} satisfies Meta<typeof Separator>

export default meta
type Story = StoryObj<typeof meta>

export const Horizontal: Story = {
  render: () => (
    <div className="w-full max-w-sm">
      <div className="space-y-1">
        <h4 className="text-sm font-medium leading-none">Chapter Settings</h4>
        <p className="text-sm text-muted-foreground">
          Configure how this chapter appears and behaves.
        </p>
      </div>
      <Separator className="my-4" />
      <div className="space-y-1">
        <h4 className="text-sm font-medium leading-none">Publishing</h4>
        <p className="text-sm text-muted-foreground">
          Set the publication schedule and visibility.
        </p>
      </div>
    </div>
  ),
}

export const Vertical: Story = {
  render: () => (
    <div className="flex h-8 items-center gap-4">
      <span className="text-sm">Edit</span>
      <Separator orientation="vertical" />
      <span className="text-sm">Preview</span>
      <Separator orientation="vertical" />
      <span className="text-sm">Publish</span>
    </div>
  ),
}

export const InContent: Story = {
  render: () => (
    <div className="max-w-md space-y-4">
      <div className="rounded-md border p-4">
        <h3 className="text-sm font-semibold">Section One</h3>
        <p className="text-sm text-muted-foreground">First section content.</p>
      </div>
      <Separator />
      <div className="rounded-md border p-4">
        <h3 className="text-sm font-semibold">Section Two</h3>
        <p className="text-sm text-muted-foreground">
          Second section content.
        </p>
      </div>
      <Separator />
      <div className="rounded-md border p-4">
        <h3 className="text-sm font-semibold">Section Three</h3>
        <p className="text-sm text-muted-foreground">Third section content.</p>
      </div>
    </div>
  ),
}
