import type { Meta, StoryObj } from "@storybook/react-vite"
import { CalendarDots, Fire } from "@phosphor-icons/react"
import { Badge } from "./badge"
import { Button } from "./button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card"

const meta = {
  title: "UI/Card",
  component: Card,
  tags: ["autodocs"],
} satisfies Meta<typeof Card>

export default meta
type Story = StoryObj<typeof meta>

export const WorkItemCard: Story = {
  render: () => (
    <Card className="w-full max-w-md">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Work Item: Arc 5 Polishing</CardTitle>
          <Badge variant="secondary">In Review</Badge>
        </div>
        <CardDescription>
          Tighten pacing for Chapters 44-48 before Sunday publish.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-muted-foreground">
        <p className="flex items-center gap-2">
          <CalendarDots className="size-4" />
          Deadline: March 28
        </p>
        <p className="flex items-center gap-2">
          <Fire className="size-4 text-destructive" />
          Priority: High
        </p>
      </CardContent>
      <CardFooter className="gap-2">
        <Button variant="outline">Open Thread</Button>
        <Button>Resume Work</Button>
      </CardFooter>
    </Card>
  ),
}

export const Showcase: Story = {
  render: () => (
    <div className="grid w-full max-w-4xl gap-4 md:grid-cols-3">
      <Card variant="default">
        <CardHeader>
          <CardTitle>Default</CardTitle>
          <CardDescription>Standard thread card.</CardDescription>
        </CardHeader>
      </Card>
      <Card variant="outline">
        <CardHeader>
          <CardTitle>Outline</CardTitle>
          <CardDescription>Low emphasis container.</CardDescription>
        </CardHeader>
      </Card>
      <Card variant="muted">
        <CardHeader>
          <CardTitle>Muted</CardTitle>
          <CardDescription>Subtle support panel.</CardDescription>
        </CardHeader>
      </Card>
    </div>
  ),
}
