import type { Meta, StoryObj } from "@storybook/react-vite"
import type React from "react"
import { FormField } from "./form-field"
import { Input } from "./input"
import { Textarea } from "./textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select"

const meta = {
  title: "UI/FormField",
  component: FormField,
  tags: ["autodocs"],
  // All stories use render(); children default satisfies TS since the prop is required.
  args: {
    children: null as unknown as React.ReactElement<{ id?: string; [key: string]: unknown }>,
  },
} satisfies Meta<typeof FormField>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <FormField label="Chapter Title">
      <Input placeholder="Enter chapter title..." />
    </FormField>
  ),
}

export const WithHelperText: Story = {
  render: () => (
    <FormField label="Display Name" helperText="This will be visible to other collaborators.">
      <Input placeholder="Enter name..." />
    </FormField>
  ),
}

export const WithError: Story = {
  render: () => (
    <FormField label="Email" error="Please enter a valid email address.">
      <Input type="email" defaultValue="not-an-email" />
    </FormField>
  ),
}

export const TextareaField: Story = {
  render: () => (
    <FormField label="Chapter Notes" helperText="Markdown is supported.">
      <Textarea placeholder="Add notes for this chapter..." />
    </FormField>
  ),
}

export const TextareaError: Story = {
  render: () => (
    <FormField label="Description" error="Description must be at least 50 characters.">
      <Textarea defaultValue="Too short" />
    </FormField>
  ),
}

export const SelectField: Story = {
  render: () => (
    <FormField label="Point of View" helperText="Select the POV character for this scene.">
      <Select>
        <SelectTrigger className="w-[280px]">
          <SelectValue placeholder="Select character..." />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="mara">Mara</SelectItem>
          <SelectItem value="kael">Kael</SelectItem>
          <SelectItem value="eira">Eira Vale</SelectItem>
        </SelectContent>
      </Select>
    </FormField>
  ),
}

export const AllStates: Story = {
  render: () => (
    <div className="grid max-w-sm gap-6">
      <FormField label="Normal">
        <Input placeholder="Type here..." />
      </FormField>
      <FormField label="With Helper" helperText="Additional context.">
        <Input placeholder="Type here..." />
      </FormField>
      <FormField label="Error" error="This field is required.">
        <Input defaultValue="bad input" />
      </FormField>
      <FormField label="Disabled">
        <Input defaultValue="locked" disabled />
      </FormField>
    </div>
  ),
}
