import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  SelectSeparator,
} from "./select"

const meta = {
  title: "UI/Select",
  component: Select,
  tags: ["autodocs"],
} satisfies Meta<typeof Select>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Select>
      <SelectTrigger className="w-[280px]">
        <SelectValue placeholder="Select a chapter..." />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Chapters</SelectLabel>
          <SelectItem value="ch-1">Chapter 1: The Beginning</SelectItem>
          <SelectItem value="ch-2">Chapter 2: The Journey</SelectItem>
          <SelectItem value="ch-3">Chapter 3: The Conflict</SelectItem>
          <SelectItem value="ch-4">Chapter 4: The Resolution</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
}

export const WithGroups: Story = {
  render: () => (
    <Select>
      <SelectTrigger className="w-[280px]">
        <SelectValue placeholder="Select a document..." />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Arc 1: Origins</SelectLabel>
          <SelectItem value="ch-1">Chapter 1</SelectItem>
          <SelectItem value="ch-2">Chapter 2</SelectItem>
          <SelectItem value="ch-3">Chapter 3</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Arc 2: Cultivation</SelectLabel>
          <SelectItem value="ch-4">Chapter 4</SelectItem>
          <SelectItem value="ch-5">Chapter 5</SelectItem>
          <SelectItem value="ch-6">Chapter 6</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
}

export const Disabled: Story = {
  render: () => (
    <Select disabled>
      <SelectTrigger className="w-[280px]">
        <SelectValue placeholder="Disabled..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="1">Option 1</SelectItem>
      </SelectContent>
    </Select>
  ),
}

export const WithDisabledItems: Story = {
  render: () => (
    <Select>
      <SelectTrigger className="w-[280px]">
        <SelectValue placeholder="Select a role..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="reader">Reader</SelectItem>
        <SelectItem value="editor">Editor</SelectItem>
        <SelectItem value="admin" disabled>
          Admin (locked)
        </SelectItem>
      </SelectContent>
    </Select>
  ),
}
