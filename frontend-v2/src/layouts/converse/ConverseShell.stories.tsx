import type { Meta, StoryObj } from "@storybook/react-vite"

import { ShellVisibilityProvider } from "../app-shell/shell-visibility-context"
import { ConverseShell } from "./ConverseShell"

const meta = {
  title: "Layouts/ConverseShell",
  component: ConverseShell,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <ShellVisibilityProvider activeMode="converse">
        <div className="h-dvh w-screen">
          <Story />
        </div>
      </ShellVisibilityProvider>
    ),
  ],
} satisfies Meta<typeof ConverseShell>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
