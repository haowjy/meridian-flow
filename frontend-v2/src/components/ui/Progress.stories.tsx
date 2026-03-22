import type { Meta, StoryObj } from "@storybook/react-vite"
import { useEffect, useState } from "react"
import { Progress } from "./progress"

const meta = {
  title: "UI/Progress",
  component: Progress,
  tags: ["autodocs"],
  argTypes: {
    value: { control: { type: "range", min: 0, max: 100, step: 1 } },
  },
} satisfies Meta<typeof Progress>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: { value: 42 },
  render: (args) => (
    <div className="w-full max-w-md space-y-2">
      <Progress {...args} />
      <p className="text-sm text-muted-foreground">Draft completion: {args.value}%</p>
    </div>
  ),
}

export const Animated: Story = {
  render: function AnimatedRender() {
    const [value, setValue] = useState(12)

    useEffect(() => {
      const interval = setInterval(() => {
        setValue((current) => (current >= 100 ? 12 : current + 8))
      }, 700)

      return () => clearInterval(interval)
    }, [])

    return (
      <div className="w-full max-w-md space-y-2">
        <Progress value={value} />
        <p className="text-sm text-muted-foreground">Uploading chapter assets... {value}%</p>
      </div>
    )
  },
}

export const Showcase: Story = {
  render: () => (
    <div className="w-full max-w-md space-y-4">
      <div>
        <p className="mb-2 text-sm font-medium">Word Count Goal</p>
        <Progress value={64} />
      </div>
      <div>
        <p className="mb-2 text-sm font-medium">Revision Checklist</p>
        <Progress value={28} className="[&>div]:bg-muted-foreground" />
      </div>
      <div>
        <p className="mb-2 text-sm font-medium">Publish Pipeline</p>
        <Progress value={90} className="[&>div]:bg-success" />
      </div>
    </div>
  ),
}
