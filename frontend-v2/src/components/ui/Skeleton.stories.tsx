import type { Meta, StoryObj } from "@storybook/react-vite"
import { Skeleton } from "./skeleton"

const meta = {
  title: "UI/Skeleton",
  component: Skeleton,
  tags: ["autodocs"],
} satisfies Meta<typeof Skeleton>

export default meta
type Story = StoryObj<typeof meta>

export const Line: Story = {
  render: () => <Skeleton className="h-4 w-72" />,
}

export const ChapterCardLoading: Story = {
  render: () => (
    <div className="w-full max-w-md space-y-3 rounded-md border bg-card p-4">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-11 w-32" />
    </div>
  ),
}

export const ThreadLoading: Story = {
  render: () => (
    <div className="w-full max-w-xl space-y-4">
      <div className="flex items-start gap-3">
        <Skeleton className="size-11 rounded-full" />
        <div className="w-full space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      </div>
      <div className="flex items-start gap-3">
        <Skeleton className="size-11 rounded-full" />
        <div className="w-full space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </div>
    </div>
  ),
}
