import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { Slider } from "./slider"

const meta = {
  title: "UI/Slider",
  component: Slider,
  tags: ["autodocs"],
} satisfies Meta<typeof Slider>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => {
    const [value, setValue] = useState([35])

    return (
      <div className="w-full max-w-md space-y-2">
        <Slider value={value} onValueChange={setValue} max={100} step={1} />
        <p className="text-sm text-muted-foreground">
          Creativity level: {value[0]}%
        </p>
      </div>
    )
  },
}

export const Range: Story = {
  render: () => {
    const [value, setValue] = useState([20, 70])

    return (
      <div className="w-full max-w-md space-y-2">
        <Slider value={value} onValueChange={setValue} max={100} step={1} />
        <p className="text-sm text-muted-foreground">
          Dialogue density target: {value[0]}% - {value[1]}%
        </p>
      </div>
    )
  },
}

export const Disabled: Story = {
  render: () => (
    <div className="w-full max-w-md space-y-2">
      <Slider value={[60]} disabled />
      <p className="text-sm text-muted-foreground">Locked by project defaults.</p>
    </div>
  ),
}
