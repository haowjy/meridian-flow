import { blockContentRecord, type Turn } from "@meridian/contracts/threads";

export type BlockRow = {
  turnId: string;
  role: string;
  sequence: number;
  type: string;
  status: string | null;
  tool: string | null;
  createdAt: string;
  offsetMs: number;
  gapMs: number;
  bytes: number;
};

export type BlockTable = { threadId: string; blocks: BlockRow[]; turns: number };

export function blockTimings(threadId: string, selected: Turn[]): BlockTable {
  const toolNames = new Map<string, string>();
  const blocks: BlockRow[] = [];
  for (const turn of selected) {
    const turnStart = Date.parse(turn.createdAt);
    let previous = turnStart;
    for (const block of [...turn.blocks].sort((a, b) => a.sequence - b.sequence)) {
      const content = blockContentRecord(block);
      const toolCallId = typeof content.toolCallId === "string" ? content.toolCallId : null;
      let tool: string | null = null;
      if (block.blockType === "tool_use" && typeof content.toolName === "string") {
        tool = content.toolName;
        if (toolCallId) toolNames.set(toolCallId, tool);
      } else if (block.blockType === "tool_result" && toolCallId) {
        tool = toolNames.get(toolCallId) ?? null;
      }
      const at = Date.parse(block.createdAt);
      blocks.push({
        turnId: turn.id,
        role: turn.role,
        sequence: block.sequence,
        type: block.blockType,
        status: block.status ?? null,
        tool,
        createdAt: block.createdAt,
        offsetMs: at - turnStart,
        gapMs: at - previous,
        bytes: Buffer.byteLength(JSON.stringify(block.content ?? null)),
      });
      previous = at;
    }
  }
  return { threadId, blocks, turns: selected.length };
}

function seconds(ms: number): string {
  return `${ms < 0 ? "-" : "+"}${(Math.abs(ms) / 1000).toFixed(2)}s`;
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}

export function renderBlocks(table: BlockTable): string {
  if (table.blocks.length === 0) return `(no blocks in ${table.turns} turn(s))`;
  const lines: string[] = [];
  let turnId = "";
  for (const row of table.blocks) {
    if (row.turnId !== turnId) {
      turnId = row.turnId;
      lines.push(`turn ${row.turnId} ${row.role}`);
    }
    const partial = row.status === "partial" ? " (partial)" : "";
    const tool = row.tool ? ` ${row.tool}` : "";
    lines.push(
      `  #${row.sequence} ${row.createdAt} ${seconds(row.offsetMs)} (gap ${seconds(row.gapMs)}) ${row.type}${tool} ${size(row.bytes)}${partial}`,
    );
  }
  return lines.join("\n");
}
