import type { Meta, StoryObj } from "@storybook/react-vite"
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
  args: {
    label: "Chapter Title",
    placeholder: "Enter chapter title...",
  },
}

export const Email: Story = {
  args: {
    type: "email",
    label: "Email",
    placeholder: "writer@example.com",
  },
}

export const Password: Story = {
  args: {
    type: "password",
    label: "Password",
    placeholder: "Enter password...",
  },
}

export const WithHelperText: Story = {
  args: {
    label: "Display Name",
    placeholder: "Enter name...",
    helperText: "This will be visible to other collaborators.",
  },
}

export const WithError: Story = {
  args: {
    label: "Email",
    type: "email",
    defaultValue: "not-an-email",
    error: "Please enter a valid email address.",
  },
}

export const Disabled: Story = {
  args: {
    label: "Locked Field",
    defaultValue: "This cannot be edited",
    disabled: true,
  },
}

export const AllStates: Story = {
  render: () => (
    <div className="grid max-w-sm gap-6">
      <Input label="Normal" placeholder="Type here..." />
      <Input
        label="With Helper"
        placeholder="Type here..."
        helperText="Additional context for the user."
      />
      <Input
        label="Error State"
        defaultValue="bad input"
        error="This field is required."
      />
      <Input label="Disabled" defaultValue="locked" disabled />
    </div>
  ),
}
