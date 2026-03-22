import type { Meta, StoryObj } from "@storybook/react-vite"
import { Badge } from "./badge"

const meta = {
  title: "UI/Badge",
  component: Badge,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: [
        "default",
        "secondary",
        "destructive",
        "outline",
        "success",
      ],
    },
  },
} satisfies Meta<typeof Badge>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { children: "Badge" },
}

export const Secondary: Story = {
  args: { variant: "secondary", children: "Secondary" },
}

export const Destructive: Story = {
  args: { variant: "destructive", children: "Destructive" },
}

export const Outline: Story = {
  args: { variant: "outline", children: "Outline" },
}

export const Success: Story = {
  args: { variant: "success", children: "Success" },
}

/** Proposal status badges for collab review UI */
export const ProposalStates: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Badge variant="outline">pending</Badge>
      <Badge variant="secondary">partial</Badge>
      <Badge variant="success">accepted</Badge>
      <Badge variant="destructive">rejected</Badge>
    </div>
  ),
}

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Badge variant="default">Default</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="outline">Outline</Badge>
      <Badge variant="success">Success</Badge>
      <Badge variant="destructive">Destructive</Badge>
    </div>
  ),
}

export const LongText: Story = {
  args: {
    children:
      "This is a badge with extremely long text that should still render correctly",
  },
}
