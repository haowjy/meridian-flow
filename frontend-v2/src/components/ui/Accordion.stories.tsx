import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./accordion"

const meta = {
  title: "UI/Accordion",
  component: Accordion,
  tags: ["autodocs"],
} satisfies Meta<typeof Accordion>

export default meta
type Story = StoryObj<typeof meta>

export const SingleOpen: Story = {
  args: {
    type: "single",
  },
  render: () => (
    <Accordion type="single" collapsible className="w-full max-w-2xl rounded-md border px-4">
      <AccordionItem value="item-1">
        <AccordionTrigger>Story Settings</AccordionTrigger>
        <AccordionContent>
          Manage POV defaults, narrative tense, and publishing cadence.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-2">
        <AccordionTrigger>Character Vault</AccordionTrigger>
        <AccordionContent>
          Keep aliases, appearance notes, and relationship links in one place.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-3">
        <AccordionTrigger>World Glossary</AccordionTrigger>
        <AccordionContent>
          Track places, artifacts, and invented terminology for continuity.
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
}

export const MultipleOpen: Story = {
  args: {
    type: "multiple",
  },
  render: () => (
    <Accordion type="multiple" defaultValue={["item-1", "item-2"]} className="w-full max-w-2xl rounded-md border px-4">
      <AccordionItem value="item-1">
        <AccordionTrigger>Arc 1 Notes</AccordionTrigger>
        <AccordionContent>Origin chapters and major reveal scaffolding.</AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-2">
        <AccordionTrigger>Arc 2 Notes</AccordionTrigger>
        <AccordionContent>Training sequence pacing and faction politics.</AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-3">
        <AccordionTrigger>Arc 3 Notes</AccordionTrigger>
        <AccordionContent>Convergence chapters and betrayal timing.</AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
}
