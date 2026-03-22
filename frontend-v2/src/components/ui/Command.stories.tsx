import type { Meta, StoryObj } from "@storybook/react-vite"
import { useMemo, useState } from "react"
import {
  Book,
  ClockCounterClockwise,
  MagnifyingGlass,
  Sparkle,
  User,
} from "@phosphor-icons/react"
import { Button } from "./button"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "./command"

const chapterItems = [
  "Chapter 11: Glass Harbor",
  "Chapter 12: The Quiet Signal",
  "Chapter 13: Tideworn Pact",
  "Chapter 14: Lantern Court",
]

const meta = {
  title: "UI/Command",
  component: Command,
  tags: ["autodocs"],
} satisfies Meta<typeof Command>

export default meta
type Story = StoryObj<typeof meta>

export const Palette: Story = {
  render: () => (
    <div className="w-full max-w-xl rounded-md border bg-card">
      <Command>
        <CommandInput placeholder="Search chapters, characters, or actions..." />
        <CommandList>
          <CommandEmpty>No result found.</CommandEmpty>
          <CommandGroup heading="Recent">
            <CommandItem>
              <ClockCounterClockwise className="size-4" />
              Reopen Chapter 14 draft
              <CommandShortcut>R</CommandShortcut>
            </CommandItem>
            <CommandItem>
              <Sparkle className="size-4" />
              Generate scene prompt
              <CommandShortcut>G</CommandShortcut>
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Chapters">
            {chapterItems.map((item) => (
              <CommandItem key={item}>
                <Book className="size-4" />
                {item}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Characters">
            <CommandItem>
              <User className="size-4" />
              Mira Vale
            </CommandItem>
            <CommandItem>
              <User className="size-4" />
              Kael Thorn
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  ),
}

export const SearchFilter: Story = {
  render: function SearchFilterRender() {
    const [query, setQuery] = useState("")

    const filteredItems = useMemo(
      () =>
        chapterItems.filter((item) =>
          item.toLowerCase().includes(query.toLowerCase())
        ),
      [query]
    )

    return (
      <div className="w-full max-w-xl rounded-md border bg-card">
        <Command>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Filter chapter list..."
          />
          <CommandList>
            <CommandEmpty>No chapters match this query.</CommandEmpty>
            <CommandGroup heading="Results">
              {filteredItems.map((item) => (
                <CommandItem key={item}>
                  <MagnifyingGlass className="size-4" />
                  {item}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </div>
    )
  },
}

export const DialogMode: Story = {
  render: function DialogModeRender() {
    const [open, setOpen] = useState(false)

    return (
      <>
        <Button variant="outline" onClick={() => setOpen(true)}>
          Open Command Dialog
        </Button>
        <CommandDialog open={open} onOpenChange={setOpen}>
          <CommandInput placeholder="Jump to character note..." />
          <CommandList>
            <CommandGroup heading="Characters">
              <CommandItem>Mira Vale</CommandItem>
              <CommandItem>Kael Thorn</CommandItem>
              <CommandItem>Archivist Sol</CommandItem>
            </CommandGroup>
          </CommandList>
        </CommandDialog>
      </>
    )
  },
}
