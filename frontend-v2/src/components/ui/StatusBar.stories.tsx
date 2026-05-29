import type { Meta, StoryObj } from "@storybook/react-vite"

import { StatusBar } from "./status-bar"

const meta = {
  title: "UI/StatusBar",
  component: StatusBar,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="flex min-h-24 flex-col justify-end bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatusBar>

export default meta
type Story = StoryObj<typeof meta>

export const Connected: Story = {
  args: {
    connected: true,
    creditBalance: "1,240 credits",
  },
}

export const Disconnected: Story = {
  args: {
    connected: false,
  },
}

export const ConnectedNoCredits: Story = {
  args: {
    connected: true,
  },
}
