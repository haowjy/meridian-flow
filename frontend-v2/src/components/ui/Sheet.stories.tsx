import type { Meta, StoryObj } from "@storybook/react-vite"
import { ListBullets, Sparkle } from "@phosphor-icons/react"
import { Button } from "./button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./sheet"

const meta = {
  title: "UI/Sheet",
  component: Sheet,
  tags: ["autodocs"],
} satisfies Meta<typeof Sheet>

export default meta
type Story = StoryObj<typeof meta>

export const RightPanel: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button>
          <ListBullets className="size-4" />
          Open Chapter Panel
        </Button>
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Chapter Queue</SheetTitle>
          <SheetDescription>
            Reorder and prioritize this week&apos;s chapter drafts.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-6 space-y-3">
          <div className="rounded-md border p-3 text-sm">Chapter 28: Lantern Harbor</div>
          <div className="rounded-md border p-3 text-sm">Chapter 29: Tideglass Gate</div>
          <div className="rounded-md border p-3 text-sm">Chapter 30: The Oath Ledger</div>
        </div>
        <SheetFooter className="mt-6">
          <Button variant="outline">Close</Button>
          <Button>Save Order</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  ),
}

export const LeftPanel: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">Open Outline</Button>
      </SheetTrigger>
      <SheetContent side="left">
        <SheetHeader>
          <SheetTitle>Arc 4 Outline</SheetTitle>
          <SheetDescription>
            Keep your beat sheet visible while drafting.
          </SheetDescription>
        </SheetHeader>
        <ul className="mt-6 list-disc space-y-2 pl-4 text-sm text-muted-foreground">
          <li>Inciting fracture in the storm court.</li>
          <li>Mira discovers the mirrored archive.</li>
          <li>Kael defects in Chapter 36.</li>
        </ul>
      </SheetContent>
    </Sheet>
  ),
}

export const BottomSheet: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="secondary">
          <Sparkle className="size-4" />
          Writing Prompt
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>Prompt Generator</SheetTitle>
          <SheetDescription>
            Write a confrontation where trust costs more than truth.
          </SheetDescription>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  ),
}
