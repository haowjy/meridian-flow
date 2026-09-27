/** Model-visible transcript with preflight sizing, document excerpts and block-boundary splits. */
import type { Block } from "@meridian/contracts/threads";
import { SystemUpdateMetadataCodec } from "../../threads/index.js";
import type { ContentPart, ToolUsePart } from "../gateway/index.js";
import { estimateModelJsonTokens } from "../loop/compaction/estimate.js";
import type { ProjectedActiveHistory } from "../loop/compaction/index.js";
import { turnContextMessages } from "../loop/context-builder.js";

const EXCERPT_CHARACTERS = 1200;

function renderPart(part: ContentPart): string {
  if (part.type === "text") return part.text;
  if (part.type === "image" || part.type === "file")
    return `[${part.type}: ${(part as unknown as { uri?: string }).uri ?? "URI unavailable"}]`;
  return JSON.stringify(part);
}

function resultExcerpt(
  part: ContentPart,
  rendered: string,
  calls: ReadonlyMap<string, ToolUsePart>,
): string {
  if (part.type !== "tool_result" || rendered.length <= EXCERPT_CHARACTERS) return rendered;
  const call = calls.get(part.toolCallId);
  const uri =
    call?.toolName === "write" && call.input.command === "read"
      ? (call.input.path ?? call.input.file)
      : undefined;
  // Only document reads can be re-read. Writes and other bulky results must split or fail.
  return typeof uri === "string"
    ? `Tool result for ${uri}${part.isError ? " (error)" : ""} (excerpt; re-read this URI for the full document):
${rendered.slice(0, EXCERPT_CHARACTERS)}`
    : rendered;
}

/** All blocks are measured before the caller can start paying for any cold segment. */
export function transcriptSegments(projection: ProjectedActiveHistory, budget: number): string[] {
  const byTurn = new Map<string, Block[]>();
  for (const block of projection.blocks) {
    const blocks = byTurn.get(block.turnId) ?? [];
    blocks.push(block);
    byTurn.set(block.turnId, blocks);
  }
  const result: string[] = [];
  for (const turn of projection.turns) {
    if (turn.role === "compaction") continue;
    const blocks = byTurn.get(turn.id) ?? [];
    const metadata = SystemUpdateMetadataCodec.safeParse(turn.metadata);
    const label =
      metadata.success && metadata.data.section === "compaction_summary"
        ? "Prior context (previous conversation summary)"
        : turn.role;
    const wrap = (parts: string[]) => `[${label}]\n${parts.join("\n")}`;
    const fits = (value: string) => estimateModelJsonTokens(`\n\n${value}`) < budget;
    let content = turnContextMessages(turn, blocks)
      .flatMap((message) => message.content)
      .filter((part) => part.type !== "reasoning");
    const calls = new Map(
      content
        .filter((part): part is ToolUsePart => part.type === "tool_use")
        .map((call) => [call.toolCallId, call]),
    );
    let parts = content.map(renderPart);
    if (!parts.some(Boolean)) continue;
    // Live system updates join their text into one part; recover the original
    // block boundaries only when that joined part is too large for a segment.
    if (turn.role === "system" && !fits(wrap(parts))) {
      content = [...blocks]
        .sort((a, b) => a.sequence - b.sequence)
        .flatMap((block) => turnContextMessages(turn, [block]))
        .flatMap((message) => message.content)
        .filter((part) => part.type !== "reasoning");
      parts = content.map(renderPart);
    }
    if (!fits(wrap(parts)))
      parts = parts.map((part, index) => resultExcerpt(content[index], part, calls));
    if (fits(wrap(parts))) {
      result.push(wrap(parts));
      continue;
    }
    let chunk: string[] = [];
    const headerTokens = estimateModelJsonTokens(`\n\n${wrap([])}`);
    let chunkTokens = headerTokens;
    for (const part of parts.filter(Boolean)) {
      if (!fits(wrap([part])))
        throw new Error("A single conversation block exceeds the summarizer's usable window");
      const partTokens = estimateModelJsonTokens(`\n${part}`);
      if (chunk.length && chunkTokens + partTokens >= budget) {
        result.push(wrap(chunk));
        chunk = [];
        chunkTokens = headerTokens;
      }
      chunk.push(part);
      chunkTokens += partTokens;
    }
    if (chunk.length) result.push(wrap(chunk));
  }
  return result;
}
