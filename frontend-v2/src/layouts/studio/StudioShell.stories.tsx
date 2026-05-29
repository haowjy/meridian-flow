import type { Meta, StoryObj } from "@storybook/react-vite"

import { ShellVisibilityProvider } from "../app-shell/shell-visibility-context"
import { StudioShell } from "./StudioShell"

const meta = {
  title: "Layouts/StudioShell",
  component: StudioShell,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <ShellVisibilityProvider activeMode="studio">
        <div className="h-dvh w-screen">
          <Story />
        </div>
      </ShellVisibilityProvider>
    ),
  ],
} satisfies Meta<typeof StudioShell>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithDocument: Story = {
  args: {
    activeDocumentPath: "chapters/28.md",
  },
}
