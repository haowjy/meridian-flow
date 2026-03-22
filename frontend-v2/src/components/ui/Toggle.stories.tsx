import type { Meta, StoryObj } from "@storybook/react-vite"
import { TextB, TextItalic, TextUnderline } from "@phosphor-icons/react"
import { useState } from "react"
import { Toggle } from "./toggle"

const meta = {
  title: "UI/Toggle",
  component: Toggle,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "outline"],
    },
    size: {
      control: "select",
      options: ["default", "sm", "lg"],
    },
  },
} satisfies Meta<typeof Toggle>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => {
    const [pressed, setPressed] = useState(false)

    return (
      <Toggle pressed={pressed} onPressedChange={setPressed}>
        <TextB className="size-4" />
        Bold
      </Toggle>
    )
  },
}

export const Outline: Story = {
  render: () => {
    const [pressed, setPressed] = useState(true)

    return (
      <Toggle variant="outline" pressed={pressed} onPressedChange={setPressed}>
        <TextItalic className="size-4" />
        Italic
      </Toggle>
    )
  },
}

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Toggle size="sm" aria-label="Underline">
        <TextUnderline className="size-4" />
      </Toggle>
      <Toggle size="default" aria-label="Underline">
        <TextUnderline className="size-4" />
      </Toggle>
      <Toggle size="lg" aria-label="Underline">
        <TextUnderline className="size-4" />
      </Toggle>
    </div>
  ),
}

export const Showcase: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Toggle>
        <TextB className="size-4" />
        Bold
      </Toggle>
      <Toggle>
        <TextItalic className="size-4" />
        Italic
      </Toggle>
      <Toggle>
        <TextUnderline className="size-4" />
        Underline
      </Toggle>
      <Toggle variant="outline" disabled>
        Disabled
      </Toggle>
    </div>
  ),
}
