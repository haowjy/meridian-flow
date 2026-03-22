import type { Meta, StoryObj } from "@storybook/react-vite"

import { ActivityBlock } from "./ActivityBlock"
import type { ActivityBlockData, EditReviewStatus, ToolItem } from "./types"

// ---------------------------------------------------------------------------
// Mock data factories
// ---------------------------------------------------------------------------

function readTool(id: string, filePath: string, status: ToolItem["status"] = "done"): ToolItem {
  return {
    kind: "tool",
    id,
    toolName: "Read",
    status,
    args: { path: filePath },
    detail: {
      kind: "read",
      filePath,
      previewLines: [
        "The rain eased into a silver mist over East Gate.",
        "Mara counted six breaths before stepping into the courtyard.",
        "A temple bell carried through the wet stone arcades.",
      ],
    },
  }
}

function editTool(
  id: string,
  filePath: string,
  reviewStatus: EditReviewStatus = "pending-review",
  status: ToolItem["status"] = "done"
): ToolItem {
  return {
    kind: "tool",
    id,
    toolName: "EditDocument",
    status,
    args: { path: filePath },
    detail: {
      kind: "edit",
      filePath,
      reviewStatus,
      addedLines: 12,
      removedLines: 4,
      hunks: 3,
      diffLines: [
        { type: "remove", text: "She crossed the bridge quickly and looked back once." },
        { type: "add", text: "She paused on the bridge, letting the drums fade behind her." },
        { type: "add", text: "Only then did she step into the hush of the monastery hall." },
        { type: "context", text: "Master Ren waited beside the cedar table with two cups of tea." },
        { type: "remove", text: "The transition felt abrupt but she ignored it." },
        { type: "add", text: "The slower transition gave the scene room to breathe." },
      ],
    },
  }
}

function searchTool(id: string, query: string, status: ToolItem["status"] = "done"): ToolItem {
  return {
    kind: "tool",
    id,
    toolName: "doc_search",
    status,
    args: { query },
    detail: {
      kind: "doc-search",
      query,
      matchCount: 4,
      matches: [
        {
          id: `${id}-1`,
          filePath: "chapters/chapter-18.md",
          lineStart: 44,
          lineEnd: 46,
          snippet: "...the sparring match ended just before the meditation bell rang...",
        },
        {
          id: `${id}-2`,
          filePath: "notes/character-notes/lin.md",
          lineStart: 12,
          lineEnd: 13,
          snippet: "Lin slows scenes with ritual gestures before major revelations.",
        },
      ],
    },
  }
}

function webSearchTool(id: string, query: string, status: ToolItem["status"] = "done"): ToolItem {
  return {
    kind: "tool",
    id,
    toolName: "web_search",
    status,
    args: { query },
    detail: {
      kind: "web-search",
      query,
      resultCount: 3,
      results: [
        {
          id: `${id}-1`,
          title: "Zen Meditation Bell Ceremonies - Buddhist Traditions",
          url: "https://example.com/meditation-bells",
          snippet: "The meditation bell (keisu) is struck three times to signal the beginning of zazen. The intervals between strikes carry meaning...",
        },
        {
          id: `${id}-2`,
          title: "Monastery Courtyards in East Asian Architecture",
          url: "https://example.com/monastery-architecture",
          snippet: "Stone arcades surrounding monastery courtyards served both practical and spiritual purposes, channeling sound and rain...",
        },
      ],
    },
  }
}

function bashTool(id: string, command: string, status: ToolItem["status"] = "done"): ToolItem {
  return {
    kind: "tool",
    id,
    toolName: "Bash",
    status,
    args: { command },
    detail: {
      kind: "bash",
      command,
      exitCode: status === "done" ? 0 : undefined,
      output: [
        "$ scripts/analyze-pacing.sh chapters/chapter-19.md",
        "Detected abrupt transition between scenes 2 and 3",
        "Recommended bridge paragraph length: 90-140 words",
      ].join("\n"),
    },
  }
}

function genericTool(id: string, toolName: string, args: Record<string, unknown>): ToolItem {
  return { kind: "tool", id, toolName, status: "done", args }
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

const meta = {
  title: "Features/ActivityStream/ActivityBlock",
  component: ActivityBlock,
  tags: ["autodocs"],
} satisfies Meta<typeof ActivityBlock>

export default meta
type Story = StoryObj<typeof meta>

/** Collapsed block with response text below -- the standard completed turn pattern. */
export const CompletedTurn: Story = {
  render: () => (
    <div className="max-w-3xl space-y-4">
      <ActivityBlock
        activity={{
          id: "completed",
          isStreaming: false,
          items: [
            readTool("c-read-1", "chapters/chapter-18.md"),
            readTool("c-read-2", "chapters/chapter-19.md"),
            searchTool("c-search-1", "meditation hall"),
            editTool("c-edit-1", "chapters/chapter-19.md"),
          ],
        }}
      />
      <p className="font-editor text-base leading-relaxed text-foreground">
        Here is what I changed to improve pacing in the transition scene between the sparring and
        meditation sequence: I added a bridge paragraph that carries Mara from noise into stillness
        with one breath-count beat and a bell cue.
      </p>
    </div>
  ),
}

/** Streaming turn -- realistic interleaved thinking, text, and tools with mixed statuses. */
export const Streaming: Story = {
  render: () => (
    <ActivityBlock
      activity={{
        id: "streaming",
        isStreaming: true,
        pendingText: "Now let me adjust the bridge paragraph to carry the bell motif forward...",
        items: [
          { kind: "thinking", id: "s-think-1", text: "The user wants me to fix the pacing between chapters 18 and 19. The sparring scene ends abruptly and jumps straight into the meditation hall. I need to check how the transition currently reads and whether there are any sensory anchors I can use as a bridge.\n\nLet me start by reading the end of chapter 19 to see the current state." },
          readTool("s-read-1", "chapters/chapter-19.md"),
          { kind: "thinking", id: "s-think-2", text: "The transition is too abrupt — Mara goes from mid-swing to seated meditation in one paragraph break. There's no decompression beat. The bell motif from the abbey rituals could work as a bridge element, but I need to find where it was first introduced to keep the imagery consistent.\n\nLet me search for the meditation bell references across the manuscript." },
          { kind: "text", id: "s-text-1", text: "I noticed the transition between the sparring and meditation scenes feels rushed. Let me look at how the bell motif was set up earlier." },
          searchTool("s-search-1", "meditation bell", "done"),
          { kind: "thinking", id: "s-think-3", text: "Found the bell motif in chapter 18 — three strikes with specific intervals. The first strike signals awareness, the second signals release, the third signals stillness. This three-beat pattern gives me exactly the structure I need for the transitional paragraph.\n\nI should read the full passage to make sure I get the cadence right before editing." },
          { kind: "text", id: "s-text-2", text: "The bell motif was established in chapter 18 with three strikes. I'll add a transitional beat that echoes that pattern." },
          readTool("s-read-2", "chapters/chapter-18.md"),
          { kind: "thinking", id: "s-think-4", text: "Good — the three-strike pattern is consistent with the abbey's established rituals. I'll write a bridge paragraph that mirrors this cadence: one sentence for the last echo of steel, one for the breath between, one for the first bell. This should make the scene transition feel intentional rather than abrupt." },
          editTool("s-edit-1", "chapters/chapter-19.md", "pending-review", "running"),
          searchTool("s-search-2", "breath cadence", "pending"),
        ],
      }}
    />
  ),
}

/** All tool detail types in a single block -- starts truncated with "Show more". */
export const AllToolDetails: Story = {
  render: () => (
    <ActivityBlock
      activity={{
        id: "all-details",
        isStreaming: false,
        items: [
          readTool("d-read-1", "chapters/chapter-03.md"),
          editTool("d-edit-1", "chapters/chapter-04.md"),
          searchTool("d-search-1", "river gate motif"),
          webSearchTool("d-web-1", "monastery bell ceremony traditions"),
          bashTool("d-bash-1", "scripts/analyze-motifs.sh"),
          genericTool("d-generic-1", "skill_invoke", { skill_name: "pacing-analysis", chapter: "chapter-19.md" }),
        ],
      }}
      defaultExpanded
    />
  ),
}

/** Edit review states: pending, accepted, rejected side by side. */
export const EditReviewStates: Story = {
  render: () => (
    <div className="max-w-3xl space-y-4">
      <ActivityBlock
        activity={{
          id: "edit-pending",
          isStreaming: false,
          items: [editTool("er-pending", "chapters/chapter-11.md", "pending-review")],
        }}
        defaultExpanded
        defaultExpandedToolIds={["er-pending"]}
      />
      <ActivityBlock
        activity={{
          id: "edit-accepted",
          isStreaming: false,
          items: [editTool("er-accepted", "chapters/chapter-22.md", "accepted")],
        }}
        defaultExpanded
        defaultExpandedToolIds={["er-accepted"]}
      />
      <ActivityBlock
        activity={{
          id: "edit-rejected",
          isStreaming: false,
          items: [editTool("er-rejected", "chapters/chapter-22.md", "rejected")],
        }}
        defaultExpanded
        defaultExpandedToolIds={["er-rejected"]}
      />
    </div>
  ),
}

/** Nested agent spawn with sub-activity. */
export const AgentSpawn: Story = {
  render: () => (
    <ActivityBlock
      activity={{
        id: "agent-spawn",
        isStreaming: false,
        items: [
          readTool("a-read-1", "notes/world/abbey-rituals.md"),
          {
            kind: "tool",
            id: "a-agent-1",
            toolName: "SpawnAgent",
            status: "done",
            detail: {
              kind: "agent",
              agent: {
                id: "sub-agent-1",
                name: "Continuity Scout",
                activity: {
                  id: "sub-agent-activity",
                  isStreaming: false,
                  items: [
                    readTool("sub-read-1", "chapters/chapter-19.md"),
                    searchTool("sub-search-1", "abbey oath"),
                  ],
                  pendingText: "Cross-checking oath language for consistency.",
                },
                response:
                  "Found one inconsistency: chapter 19 says 'second oath' while chapter 7 established 'third oath'.",
              },
            },
          },
        ],
      }}
      defaultExpanded
      defaultExpandedToolIds={["a-agent-1"]}
    />
  ),
}
