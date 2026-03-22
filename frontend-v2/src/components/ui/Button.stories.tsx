import type { Meta, StoryObj } from "@storybook/react-vite"
import { PaperPlaneTilt, Plus, TrashSimple } from "@phosphor-icons/react"
import { Button } from "./button"

const meta = {
  title: "UI/Button",
  component: Button,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: [
        "default",
        "outline",
        "secondary",
        "ghost",
        "destructive",
        "link",
      ],
    },
    size: {
      control: "select",
      options: ["default", "sm", "lg", "icon"],
    },
    loading: { control: "boolean" },
    disabled: { control: "boolean" },
  },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { children: "Button" },
}

export const Outline: Story = {
  args: { variant: "outline", children: "Outline" },
}

export const Secondary: Story = {
  args: { variant: "secondary", children: "Secondary" },
}

export const Ghost: Story = {
  args: { variant: "ghost", children: "Ghost" },
}

export const Destructive: Story = {
  args: { variant: "destructive", children: "Delete" },
}

export const Link: Story = {
  args: { variant: "link", children: "Link" },
}

export const Small: Story = {
  args: { size: "sm", children: "Small" },
}

export const Large: Story = {
  args: { size: "lg", children: "Large" },
}

export const Loading: Story = {
  args: { loading: true, children: "Saving..." },
}

export const Disabled: Story = {
  args: { disabled: true, children: "Disabled" },
}

export const WithIconStart: Story = {
  render: () => (
    <Button>
      <Plus className="size-4" />
      New Chapter
    </Button>
  ),
}

export const WithIconEnd: Story = {
  render: () => (
    <Button>
      Send
      <PaperPlaneTilt className="size-4" />
    </Button>
  ),
}

export const IconOnly: Story = {
  render: () => (
    <Button variant="ghost" size="icon" aria-label="Delete">
      <TrashSimple className="size-4" />
    </Button>
  ),
}

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="default">Default</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="link">Link</Button>
    </div>
  ),
}

export const AllSizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm">Small</Button>
      <Button size="default">Default</Button>
      <Button size="lg">Large</Button>
      <Button size="icon" aria-label="Icon">
        <Plus className="size-4" />
      </Button>
    </div>
  ),
}

export const AllStates: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button>Normal</Button>
      <Button disabled>Disabled</Button>
      <Button loading>Loading</Button>
    </div>
  ),
}
