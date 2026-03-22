import type { Meta, StoryObj } from "@storybook/react-vite"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs"

const meta = {
  title: "UI/Tabs",
  component: Tabs,
  tags: ["autodocs"],
} satisfies Meta<typeof Tabs>

export default meta
type Story = StoryObj<typeof meta>

export const EditorModes: Story = {
  render: () => (
    <Tabs defaultValue="preview" className="w-full max-w-2xl">
      <TabsList>
        <TabsTrigger value="preview">Live Preview</TabsTrigger>
        <TabsTrigger value="source">Source</TabsTrigger>
      </TabsList>
      <TabsContent value="preview" className="rounded-md border bg-card p-4">
        <h3 className="font-semibold">Chapter 12 Preview</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Rain drummed on the observatory glass as Mira traced the old sigils.
        </p>
      </TabsContent>
      <TabsContent value="source" className="rounded-md border bg-card p-4 font-mono text-sm">
        {`## Chapter 12\nRain drummed on the observatory glass...`}
      </TabsContent>
    </Tabs>
  ),
}

export const PanelTabs: Story = {
  render: () => (
    <Tabs defaultValue="outline" className="w-full max-w-2xl">
      <TabsList>
        <TabsTrigger value="outline">Outline</TabsTrigger>
        <TabsTrigger value="characters">Characters</TabsTrigger>
        <TabsTrigger value="notes">Notes</TabsTrigger>
      </TabsList>
      <TabsContent value="outline" className="rounded-md border bg-card p-4 text-sm">
        Arc 3 beats and chapter checkpoints.
      </TabsContent>
      <TabsContent value="characters" className="rounded-md border bg-card p-4 text-sm">
        Eira, Kael, and Archivist Sol relationship notes.
      </TabsContent>
      <TabsContent value="notes" className="rounded-md border bg-card p-4 text-sm">
        Resolve the storm cult foreshadowing in Chapter 14.
      </TabsContent>
    </Tabs>
  ),
}

export const DisabledTab: Story = {
  render: () => (
    <Tabs defaultValue="draft" className="w-full max-w-xl">
      <TabsList>
        <TabsTrigger value="draft">Draft</TabsTrigger>
        <TabsTrigger value="published">Published</TabsTrigger>
        <TabsTrigger value="archived" disabled>
          Archived
        </TabsTrigger>
      </TabsList>
      <TabsContent value="draft" className="rounded-md border bg-card p-4 text-sm">
        Current manuscript draft view.
      </TabsContent>
      <TabsContent value="published" className="rounded-md border bg-card p-4 text-sm">
        Public reader-facing chapter list.
      </TabsContent>
    </Tabs>
  ),
}
