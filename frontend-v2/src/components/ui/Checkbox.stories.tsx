import type { Meta, StoryObj } from "@storybook/react-vite"
import { Checkbox } from "./checkbox"

const meta = {
  title: "UI/Checkbox",
  component: Checkbox,
  tags: ["autodocs"],
  argTypes: {
    disabled: { control: "boolean" },
  },
} satisfies Meta<typeof Checkbox>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {},
}

export const WithLabel: Story = {
  args: { label: "Accept terms and conditions" },
}

export const Checked: Story = {
  args: { label: "Completed", defaultChecked: true },
}

export const Indeterminate: Story = {
  args: { label: "Select all", checked: "indeterminate" },
}

export const Disabled: Story = {
  args: { label: "Disabled option", disabled: true },
}

export const DisabledChecked: Story = {
  args: { label: "Required field", disabled: true, defaultChecked: true },
}

export const CheckboxGroup: Story = {
  render: () => (
    <div className="grid gap-3">
      <p className="text-sm font-medium">Export formats:</p>
      <Checkbox label="Markdown (.md)" defaultChecked />
      <Checkbox label="Plain Text (.txt)" />
      <Checkbox label="EPUB (.epub)" />
      <Checkbox label="PDF (.pdf)" disabled />
    </div>
  ),
}
