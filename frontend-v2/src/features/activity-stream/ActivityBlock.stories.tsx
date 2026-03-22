import type { Meta, StoryObj } from "@storybook/react-vite"

import { ActivityBlock } from "./ActivityBlock"
import type { ActivityBlockData, EditReviewStatus, ToolItem } from "./types"

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

const collapsedActivity: ActivityBlockData = {
  id: "collapsed",
  isStreaming: false,
  items: [
    readTool("read-a", "chapters/chapter-05.md"),
    readTool("read-b", "chapters/chapter-06.md"),
    editTool("edit-a", "chapters/chapter-05.md"),
  ],
}

const streamingCollapsedActivity: ActivityBlockData = {
  id: "stream-collapsed",
  isStreaming: true,
  pendingText:
    "I found a pacing gap between the sparring and meditation scenes. Drafting a softer transition now...",
  items: [
    { kind: "thinking", id: "thinking-stream-1", text: "Checking scene rhythm across chapter beats." },
    readTool("stream-read", "chapters/chapter-19.md", "done"),
    searchTool("stream-search", "meditation bell", "running"),
  ],
}

const expandedToolListActivity: ActivityBlockData = {
  id: "expanded-list",
  isStreaming: false,
  items: [
    readTool("exp-read-1", "chapters/chapter-03.md"),
    readTool("exp-read-2", "chapters/chapter-04.md"),
    searchTool("exp-search-1", "river gate motif"),
    editTool("exp-edit-1", "chapters/chapter-04.md"),
    bashTool("exp-bash-1", "scripts/analyze-motifs.sh"),
  ],
}

const thinkingInterleavedActivity: ActivityBlockData = {
  id: "thinking-interleaved",
  isStreaming: false,
  items: [
    { kind: "thinking", id: "thinking-1", text: "Comparing the emotional tempo of both scenes." },
    readTool("ti-read-1", "chapters/chapter-27.md"),
    { kind: "thinking", id: "thinking-2", text: "The handoff needs one sensory beat before silence." },
    editTool("ti-edit-1", "chapters/chapter-27.md"),
    { kind: "thinking", id: "thinking-3", text: "Keeping Lin's voice restrained, not melodramatic." },
    searchTool("ti-search-1", "breath count motif"),
  ],
}

const agentSpawnActivity: ActivityBlockData = {
  id: "agent-spawn",
  isStreaming: false,
  items: [
    readTool("agent-read-1", "notes/world/abbey-rituals.md"),
    {
      kind: "tool",
      id: "agent-tool-1",
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
}

const fullTurnActivity: ActivityBlockData = {
  id: "full-turn",
  isStreaming: false,
  items: [
    readTool("full-read-1", "chapters/chapter-18.md"),
    readTool("full-read-2", "chapters/chapter-19.md"),
    searchTool("full-search-1", "meditation hall"),
    editTool("full-edit-1", "chapters/chapter-19.md"),
  ],
}

const meta = {
  title: "Features/ActivityStream/ActivityBlock",
  component: ActivityBlock,
  tags: ["autodocs"],
  args: {
    activity: collapsedActivity,
  },
} satisfies Meta<typeof ActivityBlock>

export default meta
type Story = StoryObj<typeof meta>

export const Collapsed: Story = {
  render: () => <ActivityBlock activity={collapsedActivity} />,
}

export const CollapsedStreaming: Story = {
  render: () => <ActivityBlock activity={streamingCollapsedActivity} />,
}

export const ExpandedToolList: Story = {
  render: () => <ActivityBlock activity={expandedToolListActivity} defaultExpanded />,
}

export const ExpandedAllTools: Story = {
  render: () => (
    <ActivityBlock
      activity={expandedToolListActivity}
      defaultExpanded
      defaultShowAllTools
    />
  ),
}

export const ExpandedEditDetail: Story = {
  render: () => (
    <ActivityBlock
      activity={{
        id: "edit-detail",
        isStreaming: false,
        items: [editTool("edit-detail-1", "chapters/chapter-11.md")],
      }}
      defaultExpanded
      defaultExpandedToolIds={["edit-detail-1"]}
    />
  ),
}

export const ExpandedReadDetail: Story = {
  render: () => (
    <ActivityBlock
      activity={{
        id: "read-detail",
        isStreaming: false,
        items: [readTool("read-detail-1", "chapters/chapter-09.md")],
      }}
      defaultExpanded
      defaultExpandedToolIds={["read-detail-1"]}
    />
  ),
}

export const AcceptedEdit: Story = {
  render: () => (
    <ActivityBlock
      activity={{
        id: "accepted-edit",
        isStreaming: false,
        items: [editTool("accepted-edit-1", "chapters/chapter-22.md", "accepted")],
      }}
      defaultExpanded
      defaultExpandedToolIds={["accepted-edit-1"]}
    />
  ),
}

export const RejectedEdit: Story = {
  render: () => (
    <ActivityBlock
      activity={{
        id: "rejected-edit",
        isStreaming: false,
        items: [editTool("rejected-edit-1", "chapters/chapter-22.md", "rejected")],
      }}
      defaultExpanded
      defaultExpandedToolIds={["rejected-edit-1"]}
    />
  ),
}

export const AgentSpawn: Story = {
  render: () => (
    <ActivityBlock
      activity={agentSpawnActivity}
      defaultExpanded
      defaultExpandedToolIds={["agent-tool-1"]}
    />
  ),
}

export const FullTurn: Story = {
  render: () => (
    <div className="max-w-3xl space-y-4">
      <ActivityBlock activity={fullTurnActivity} />
      <p className="font-editor text-base leading-relaxed text-foreground">
        Here is what I changed to improve pacing in the transition scene between the sparring and
        meditation sequence: I added a bridge paragraph that carries Mara from noise into stillness
        with one breath-count beat and a bell cue.
      </p>
    </div>
  ),
}

export const StreamingTurn: Story = {
  render: () => (
    <ActivityBlock
      activity={{
        id: "streaming-turn",
        isStreaming: true,
        pendingText: "Applying edits to smooth the emotional handoff.",
        items: [
          { kind: "thinking", id: "stream-thinking-a", text: "Balancing tension release after sparring." },
          readTool("streaming-read-1", "chapters/chapter-19.md"),
          editTool("streaming-edit-1", "chapters/chapter-19.md", "pending-review", "running"),
          searchTool("streaming-search-1", "breath cadence", "pending"),
        ],
      }}
      defaultExpanded
    />
  ),
}

export const TextOnlyTurn: Story = {
  render: () => (
    <p className="max-w-3xl font-editor text-base leading-relaxed text-foreground">
      I tightened the transition paragraph so the emotional drop from sparring to meditation feels
      intentional instead of abrupt.
    </p>
  ),
}

export const ThinkingInterleaved: Story = {
  render: () => (
    <ActivityBlock
      activity={thinkingInterleavedActivity}
      defaultExpanded
      defaultShowAllTools
    />
  ),
}

export const WebSearch: Story = {
  render: () => (
    <ActivityBlock
      activity={{
        id: "web-search",
        isStreaming: false,
        items: [
          webSearchTool("web-search-1", "meditation bell ceremony traditions"),
        ],
      }}
      defaultExpanded
      defaultExpandedToolIds={["web-search-1"]}
    />
  ),
}

export const GenericTool: Story = {
  render: () => (
    <ActivityBlock
      activity={{
        id: "generic-tool",
        isStreaming: false,
        items: [
          {
            kind: "tool",
            id: "skill-invoke-1",
            toolName: "skill_invoke",
            status: "done",
            args: { skill_name: "pacing-analysis", chapter: "chapter-19.md" },
          },
          {
            kind: "tool",
            id: "skill-list-1",
            toolName: "skill_list",
            status: "done",
            args: {},
          },
        ],
      }}
      defaultExpanded
      defaultExpandedToolIds={["skill-invoke-1"]}
    />
  ),
}
