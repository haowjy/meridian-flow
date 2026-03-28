/**
 * Interaction model story — all multi-modal interactions in one place.
 *
 * Exercises double-click, right-click context menu, Cmd+Click,
 * keyboard shortcuts, and paste handling.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import { StandaloneEditor } from "./helpers/StandaloneEditor"
import { interactionContent } from "./helpers/mockContent"

const meta = {
  title: "Editor/InteractionModel",
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta
type Story = StoryObj

export const AllInteractions: Story = {
  name: "All Interaction Modes",
  render: () => (
    <StandaloneEditor
      initialContent={interactionContent}
      livePreview
    />
  ),
}
