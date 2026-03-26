import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"

import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"

import { ActivityBlock } from "./ActivityBlock"
import { PACING_FIX_SCENARIO } from "./streaming/scenario"
import { useStreamSimulator } from "./streaming/use-stream-simulator"
import type { ActivityBlockData, ToolItem } from "./types"

// ---------------------------------------------------------------------------
// Mock data factories — streaming-first ToolItem shape
//
// Each factory creates a ToolItem as it would appear after AG-UI events:
// - argsText: raw JSON string (what TOOL_CALL_ARGS deltas accumulate to)
// - parsedArgs: the parsed version (what partial-json produces)
// - resultText: the result string (from TOOL_CALL_RESULT)
// ---------------------------------------------------------------------------

function readTool(id: string, filePath: string, status: ToolItem["status"] = "done"): ToolItem {
  const args = { file_path: filePath }
  return {
    kind: "tool",
    id,
    toolName: "Read",
    status,
    argsText: JSON.stringify(args),
    parsedArgs: args,
    resultText:
      status === "done"
        ? "The rain eased into a silver mist over East Gate.\nMara counted six breaths before stepping into the courtyard.\nA temple bell carried through the wet stone arcades."
        : undefined,
  }
}

function editTool(id: string, filePath: string, status: ToolItem["status"] = "done"): ToolItem {
  const args = {
    file_path: filePath,
    old_string: "She crossed the bridge quickly and looked back once.\nThe transition felt abrupt but she ignored it.",
    new_string:
      "She paused on the bridge, letting the drums fade behind her.\nOnly then did she step into the hush of the monastery hall.\nThe slower transition gave the scene room to breathe.",
  }
  return {
    kind: "tool",
    id,
    toolName: "EditDocument",
    status,
    argsText: JSON.stringify(args),
    parsedArgs: args,
    resultText: status === "done" ? "Edit applied successfully." : undefined,
  }
}

function searchTool(id: string, query: string, status: ToolItem["status"] = "done"): ToolItem {
  const args = { pattern: query, path: "chapters/" }
  return {
    kind: "tool",
    id,
    toolName: "doc_search",
    status,
    argsText: JSON.stringify(args),
    parsedArgs: args,
    resultText:
      status === "done"
        ? "chapters/chapter-18.md:44: ...the sparring match ended just before the meditation bell rang...\nnotes/character-notes/lin.md:12: Lin slows scenes with ritual gestures before major revelations."
        : undefined,
  }
}

function webSearchTool(id: string, query: string, status: ToolItem["status"] = "done"): ToolItem {
  const args = { query }
  return {
    kind: "tool",
    id,
    toolName: "web_search",
    status,
    argsText: JSON.stringify(args),
    parsedArgs: args,
    resultText:
      status === "done"
        ? "Zen Meditation Bell Ceremonies - Buddhist Traditions\nhttps://example.com/meditation-bells\nThe meditation bell (keisu) is struck three times to signal the beginning of zazen.\n\nMonastery Courtyards in East Asian Architecture\nhttps://example.com/monastery-architecture\nStone arcades surrounding monastery courtyards served both practical and spiritual purposes."
        : undefined,
  }
}

function bashTool(id: string, command: string, status: ToolItem["status"] = "done"): ToolItem {
  const args = { command }
  return {
    kind: "tool",
    id,
    toolName: "Bash",
    status,
    argsText: JSON.stringify(args),
    parsedArgs: args,
    resultText:
      status === "done"
        ? "$ scripts/analyze-pacing.sh chapters/chapter-19.md\nDetected abrupt transition between scenes 2 and 3\nRecommended bridge paragraph length: 90-140 words"
        : undefined,
  }
}

function genericTool(id: string, toolName: string, args: Record<string, unknown>): ToolItem {
  return {
    kind: "tool",
    id,
    toolName,
    status: "done",
    argsText: JSON.stringify(args, null, 2),
    parsedArgs: args,
    resultText: '{"status": "ok"}',
  }
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

const meta = {
  title: "Features/ActivityStream/ActivityBlock",
  component: ActivityBlock,
  tags: ["autodocs"],
  args: { activity: { id: "default", items: [] } satisfies ActivityBlockData },
} satisfies Meta<typeof ActivityBlock>

export default meta
type Story = StoryObj<typeof meta>

/** Collapsed block with response text below -- the standard completed turn pattern. */
export const CompletedTurn: Story = {
  render: () => (
    <ActivityBlock
      activity={{
        id: "completed",
        isStreaming: false,
        items: [
          readTool("c-read-1", "chapters/chapter-19.md"),
          searchTool("c-search-1", "meditation hall"),
          editTool("c-edit-1", "chapters/chapter-19.md"),
          { kind: "content", id: "c-response", text: "Here is what I changed to improve pacing in the transition scene between the sparring and meditation sequence: I added a bridge paragraph that carries Mara from noise into stillness with one breath-count beat and a bell cue." },
        ],
      }}
      className="max-w-3xl"
    />
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
          { kind: "content", id: "s-text-1", text: "I noticed the transition between the sparring and meditation scenes feels rushed. Let me look at how the bell motif was set up earlier." },
          searchTool("s-search-1", "meditation bell", "done"),
          { kind: "thinking", id: "s-think-3", text: "Found the bell motif in chapter 18 — three strikes with specific intervals. The first strike signals awareness, the second signals release, the third signals stillness. This three-beat pattern gives me exactly the structure I need for the transitional paragraph.\n\nI should read the full passage to make sure I get the cadence right before editing." },
          { kind: "content", id: "s-text-2", text: "The bell motif was established in chapter 18 with three strikes. I'll add a transitional beat that echoes that pattern." },
          readTool("s-read-2", "chapters/chapter-18.md"),
          { kind: "thinking", id: "s-think-4", text: "Good — the three-strike pattern is consistent with the abbey's established rituals. I'll write a bridge paragraph that mirrors this cadence: one sentence for the last echo of steel, one for the breath between, one for the first bell. This should make the scene transition feel intentional rather than abrupt." },
          editTool("s-edit-1", "chapters/chapter-19.md", "executing"),
          searchTool("s-search-2", "breath cadence", "streaming-args"),
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

/** Edit detail showing diff view. */
export const EditDiff: Story = {
  render: () => (
    <div className="max-w-3xl space-y-4">
      <ActivityBlock
        activity={{
          id: "edit-diff",
          isStreaming: false,
          items: [editTool("ed-1", "chapters/chapter-11.md")],
        }}
        defaultExpanded
        defaultExpandedToolIds={["ed-1"]}
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
            argsText: JSON.stringify({ name: "Continuity Scout", prompt: "Check oath language consistency" }),
            parsedArgs: { name: "Continuity Scout", prompt: "Check oath language consistency" },
            resultText:
              "Found one inconsistency: chapter 19 says 'second oath' while chapter 7 established 'third oath'.",
            nestedActivity: {
              id: "sub-agent-activity",
              isStreaming: false,
              items: [
                readTool("sub-read-1", "chapters/chapter-19.md"),
                searchTool("sub-search-1", "abbey oath"),
              ],
              pendingText: "Cross-checking oath language for consistency.",
            },
          },
        ],
      }}
      defaultExpanded
      defaultExpandedToolIds={["a-agent-1"]}
    />
  ),
}

/** Tool with streaming args — shows progressive header (static snapshot). */
export const StreamingArgs: Story = {
  render: () => (
    <ActivityBlock
      activity={{
        id: "streaming-args",
        isStreaming: true,
        items: [
          {
            kind: "tool",
            id: "sa-1",
            toolName: "Read",
            status: "streaming-args",
            argsText: '{"file_path": "/chapters/ch',
            parsedArgs: { file_path: "/chapters/ch" },
          },
          {
            kind: "tool",
            id: "sa-2",
            toolName: "Bash",
            status: "streaming-args",
            argsText: '{"command": "scripts/analy',
            parsedArgs: { command: "scripts/analy" },
          },
        ],
      }}
      defaultExpanded
      defaultExpandedToolIds={["sa-1", "sa-2"]}
    />
  ),
}

/**
 * Live streaming simulation — AG-UI events fire on timers and feed through
 * the reducer to produce a live-updating ActivityBlock.
 *
 * Demonstrates: thinking → text → Read (progressive args) → Search →
 * text → Edit (diff builds up) → Bash → final response → done.
 *
 * Click "Restart" to replay.
 */
export const LiveStreaming: Story = {
  render: function LiveStreamingStory() {
    const [speed, setSpeed] = useState(0.5)
    const { activity, restart, paused, togglePause, progress } = useStreamSimulator(
      "live-demo",
      PACING_FIX_SCENARIO,
      speed,
    )

    return (
      <div className="max-w-3xl space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => restart()}>
            Restart
          </Button>
          <Button variant="outline" size="sm" onClick={togglePause}>
            {paused ? "Resume" : "Pause"}
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Speed:</span>
            <Slider
              className="w-28"
              min={0.1}
              max={4}
              step={0.1}
              value={[speed]}
              onValueChange={([v]) => setSpeed(v)}
            />
            <span className="w-10 text-xs font-mono text-muted-foreground">{speed.toFixed(1)}x</span>
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">
            {progress.current}/{progress.total}
            {paused ? " (paused)" : activity.isStreaming ? "" : " ✓"}
          </span>
        </div>

        <ActivityBlock activity={activity} defaultExpanded />
      </div>
    )
  },
}
