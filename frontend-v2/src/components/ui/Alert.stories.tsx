import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  CheckCircle,
  Info,
  XCircle,
} from "@phosphor-icons/react"
import { Alert, AlertDescription, AlertTitle } from "./alert"

const meta = {
  title: "UI/Alert",
  component: Alert,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "success", "destructive"],
    },
  },
} satisfies Meta<typeof Alert>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Alert>
      <Info className="size-4" />
      <AlertTitle>Draft Sync Complete</AlertTitle>
      <AlertDescription>
        Chapter 22 has been synced to your local working copy.
      </AlertDescription>
    </Alert>
  ),
}

export const Success: Story = {
  render: () => (
    <Alert variant="success">
      <CheckCircle className="size-4" />
      <AlertTitle>Publish Ready</AlertTitle>
      <AlertDescription>
        All quality checks passed for the upcoming chapter release.
      </AlertDescription>
    </Alert>
  ),
}

export const Destructive: Story = {
  render: () => (
    <Alert variant="destructive">
      <XCircle className="size-4" />
      <AlertTitle>Merge Conflict Detected</AlertTitle>
      <AlertDescription>
        Resolve overlapping edits in `chapter-28.md` before publishing.
      </AlertDescription>
    </Alert>
  ),
}

export const Showcase: Story = {
  render: () => (
    <div className="w-full max-w-2xl space-y-3">
      <Alert>
        <Info className="size-4" />
        <AlertTitle>Info</AlertTitle>
      </Alert>
      <Alert variant="success">
        <CheckCircle className="size-4" />
        <AlertTitle>Success</AlertTitle>
      </Alert>
      <Alert variant="destructive">
        <XCircle className="size-4" />
        <AlertTitle>Destructive</AlertTitle>
      </Alert>
    </div>
  ),
}
