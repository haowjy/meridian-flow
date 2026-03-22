import type { Meta, StoryObj } from "@storybook/react-vite"
import { Avatar, AvatarFallback, AvatarImage } from "./avatar"

const meta = {
  title: "UI/Avatar",
  component: Avatar,
  tags: ["autodocs"],
} satisfies Meta<typeof Avatar>

export default meta
type Story = StoryObj<typeof meta>

export const WithImage: Story = {
  render: () => (
    <Avatar>
      <AvatarImage src="https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=120&q=80" alt="Writer avatar" />
      <AvatarFallback>MW</AvatarFallback>
    </Avatar>
  ),
}

export const FallbackOnly: Story = {
  render: () => (
    <Avatar>
      <AvatarFallback>AI</AvatarFallback>
    </Avatar>
  ),
}

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Avatar className="size-9">
        <AvatarFallback>CH</AvatarFallback>
      </Avatar>
      <Avatar className="size-11">
        <AvatarFallback>ED</AvatarFallback>
      </Avatar>
      <Avatar className="size-14">
        <AvatarFallback>JR</AvatarFallback>
      </Avatar>
    </div>
  ),
}

export const ThreadParticipants: Story = {
  render: () => (
    <div className="flex items-center -space-x-2">
      <Avatar className="border border-background">
        <AvatarFallback>W</AvatarFallback>
      </Avatar>
      <Avatar className="border border-background">
        <AvatarFallback>E</AvatarFallback>
      </Avatar>
      <Avatar className="border border-background">
        <AvatarFallback>AI</AvatarFallback>
      </Avatar>
    </div>
  ),
}
