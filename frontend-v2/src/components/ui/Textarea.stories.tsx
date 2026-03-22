import type { Meta, StoryObj } from "@storybook/react-vite"
import { Textarea } from "./textarea"

const meta = {
  title: "UI/Textarea",
  component: Textarea,
  tags: ["autodocs"],
  argTypes: {
    autoGrow: { control: "boolean" },
    disabled: { control: "boolean" },
  },
} satisfies Meta<typeof Textarea>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { placeholder: "Write something..." },
}

export const WithLabel: Story = {
  args: {
    label: "Chapter Notes",
    placeholder: "Add notes for this chapter...",
  },
}

export const AutoGrow: Story = {
  args: {
    label: "Auto-Growing Textarea",
    placeholder: "This textarea grows as you type...",
    autoGrow: true,
  },
}

export const WithCharCount: Story = {
  args: {
    label: "Summary",
    placeholder: "Write a brief summary...",
    maxCharCount: 200,
  },
}

export const WithError: Story = {
  args: {
    label: "Description",
    defaultValue: "Too short",
    error: "Description must be at least 50 characters.",
  },
}

export const Disabled: Story = {
  args: {
    label: "Locked Field",
    defaultValue: "This content cannot be edited.",
    disabled: true,
  },
}

export const AllStates: Story = {
  render: () => (
    <div className="grid max-w-md gap-6">
      <Textarea label="Normal" placeholder="Type here..." />
      <Textarea
        label="Auto-Grow"
        placeholder="Grows as you type..."
        autoGrow
      />
      <Textarea
        label="With Counter"
        placeholder="Limited to 100 chars..."
        maxCharCount={100}
      />
      <Textarea
        label="Error State"
        defaultValue="Bad content"
        error="This field has an error."
      />
      <Textarea label="Disabled" defaultValue="Locked" disabled />
    </div>
  ),
}
