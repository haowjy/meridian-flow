import type { Meta, StoryObj } from "@storybook/react-vite"
import { Label } from "./label"
import { Input } from "./input"

const meta = {
  title: "UI/Input",
  component: Input,
  tags: ["autodocs"],
  argTypes: {
    type: {
      control: "select",
      options: ["text", "email", "password", "number", "search", "url"],
    },
    disabled: { control: "boolean" },
  },
} satisfies Meta<typeof Input>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { placeholder: "Enter text..." },
}

export const WithLabel: Story = {
  render: () => (
    <div className="grid max-w-sm gap-2">
      <Label htmlFor="chapter-title">Chapter Title</Label>
      <Input id="chapter-title" placeholder="Enter chapter title..." />
    </div>
  ),
}

export const Email: Story = {
  render: () => (
    <div className="grid max-w-sm gap-2">
      <Label htmlFor="email">Email</Label>
      <Input id="email" type="email" placeholder="writer@example.com" />
    </div>
  ),
}

export const Password: Story = {
  args: {
    type: "password",
    placeholder: "Enter password...",
  },
}

export const WithError: Story = {
  render: () => (
    <div className="grid max-w-sm gap-2">
      <Label htmlFor="email-error">Email</Label>
      <Input
        id="email-error"
        type="email"
        defaultValue="not-an-email"
        aria-invalid
      />
      <p className="text-sm text-destructive">Please enter a valid email address.</p>
    </div>
  ),
}

export const Disabled: Story = {
  args: {
    defaultValue: "This cannot be edited",
    disabled: true,
  },
}

export const AllStates: Story = {
  render: () => (
    <div className="grid max-w-sm gap-6">
      <div className="grid gap-2">
        <Label>Normal</Label>
        <Input placeholder="Type here..." />
      </div>
      <div className="grid gap-2">
        <Label>With helper text</Label>
        <Input placeholder="Type here..." />
        <p className="text-sm text-muted-foreground">Additional context for the user.</p>
      </div>
      <div className="grid gap-2">
        <Label>Error state</Label>
        <Input defaultValue="bad input" aria-invalid />
        <p className="text-sm text-destructive">This field is required.</p>
      </div>
      <div className="grid gap-2">
        <Label>Disabled</Label>
        <Input defaultValue="locked" disabled />
      </div>
    </div>
  ),
}
