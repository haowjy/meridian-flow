import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { Switch } from "./switch"

const meta = {
  title: "UI/Switch",
  component: Switch,
  tags: ["autodocs"],
  argTypes: {
    disabled: { control: "boolean" },
  },
} satisfies Meta<typeof Switch>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {},
}

export const WithLabel: Story = {
  args: { label: "Dark Mode" },
}

export const Checked: Story = {
  args: { label: "Notifications", defaultChecked: true },
}

export const Disabled: Story = {
  args: { label: "Locked Setting", disabled: true },
}

export const DisabledChecked: Story = {
  args: { label: "Always On", disabled: true, defaultChecked: true },
}

export const Controlled: Story = {
  render: function ControlledStory() {
    const [checked, setChecked] = useState(false)
    return (
      <div className="grid gap-4">
        <Switch
          label="Focus Mode"
          checked={checked}
          onCheckedChange={setChecked}
        />
        <p className="text-sm text-muted-foreground">
          Focus mode is {checked ? "on" : "off"}.
        </p>
      </div>
    )
  },
}

export const SettingsGroup: Story = {
  render: () => (
    <div className="grid max-w-sm gap-4">
      <Switch label="Auto-save" defaultChecked />
      <Switch label="Spell check" defaultChecked />
      <Switch label="Word count" />
      <Switch label="Focus mode" />
      <Switch label="Distraction-free" />
    </div>
  ),
}
