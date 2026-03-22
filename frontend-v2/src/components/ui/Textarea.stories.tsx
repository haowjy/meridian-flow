import type { Meta, StoryObj } from "@storybook/react-vite"
import { Label } from "./label"
import { Textarea } from "./textarea"

const meta = {
  title: "UI/Textarea",
  component: Textarea,
  tags: ["autodocs"],
  argTypes: {
    disabled: { control: "boolean" },
  },
} satisfies Meta<typeof Textarea>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { placeholder: "Write something..." },
}

export const WithLabel: Story = {
  render: () => (
    <div className="grid max-w-md gap-2">
      <Label htmlFor="notes">Chapter Notes</Label>
      <Textarea id="notes" placeholder="Add notes for this chapter..." />
    </div>
  ),
}

export const WithError: Story = {
  render: () => (
    <div className="grid max-w-md gap-2">
      <Label htmlFor="desc-error">Description</Label>
      <Textarea
        id="desc-error"
        defaultValue="Too short"
        aria-invalid
      />
      <p className="text-sm text-destructive">Description must be at least 50 characters.</p>
    </div>
  ),
}

export const Disabled: Story = {
  args: {
    defaultValue: "This content cannot be edited.",
    disabled: true,
  },
}

export const AllStates: Story = {
  render: () => (
    <div className="grid max-w-md gap-6">
      <div className="grid gap-2">
        <Label>Normal</Label>
        <Textarea placeholder="Type here..." />
      </div>
      <div className="grid gap-2">
        <Label>Error state</Label>
        <Textarea defaultValue="Bad content" aria-invalid />
        <p className="text-sm text-destructive">This field has an error.</p>
      </div>
      <div className="grid gap-2">
        <Label>Disabled</Label>
        <Textarea defaultValue="Locked" disabled />
      </div>
    </div>
  ),
}
