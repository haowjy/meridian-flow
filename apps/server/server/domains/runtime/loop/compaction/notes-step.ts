/** Constructs the durable notes marker after request preparation admits the cycle. */
import { splitDocumentFile } from "@meridian/agent-edit/integration";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Block, OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import { compactionNotesMetadata } from "../../../threads/index.js";
import { nextTurnPosition } from "../../../threads/order-turns.js";
import { contentForBlockInput, localBlockFromEvent } from "../block-helpers.js";
import { createLocalTurn } from "../local-turn.js";

export const MAX_SCRATCH_CALLS = 3;

export function prepareCompactionNotes(input: { threadId: ThreadId; turns: Turn[] }): {
  turns: Turn[];
  blocks: Block[];
  events: OrchestratorEvent[];
} {
  const leaf = input.turns.at(-1);
  if (!leaf) throw new Error("Compaction notes step requires a prior turn");
  const turn = createLocalTurn({
    threadId: input.threadId,
    position: nextTurnPosition(leaf),
    prevTurnId: leaf.id,
    role: "system",
    origin: "system",
    status: "complete",
    metadata: compactionNotesMetadata(),
  });
  const block = contentForBlockInput({
    id: turn.id,
    turnId: turn.id,
    blockType: "text",
    sequence: 0,
    textContent:
      "<system_update>\nBefore the compaction summary, you have up to 3 tool calls to write or update anything in scratch:// that needs updating from your current work. Scratch holds shared working state, not a handoff for your next context. Do not write a handoff file: the compaction summary carries that context forward. Only Scratch reads, listings, searches and writes run during this step; all count toward the 3-call limit. End this step without tools if nothing needs updating.\n</system_update>",
    status: "complete",
  });
  return {
    turns: [turn],
    blocks: [localBlockFromEvent(block)],
    events: [
      { type: "turn.created", turn },
      { type: "block.upserted", block },
    ],
  };
}

/** Only the run loop installs this value, after the prepared boundary commits. */
export type NotesContinuation =
  | { kind: "ordinary" }
  | { kind: "notes"; remaining: number }
  | { kind: "compaction_due" };

/** Selects Scratch operations only; ordinary tool validation and file policy still own access. */
export function isScratchCall(call: { name: string; arguments: unknown }): boolean {
  if (!["read", "write", "ls", "search"].includes(call.name)) return false;
  if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments))
    return false;
  const args = call.arguments as Record<string, unknown>;
  const paths = [call.name === "search" ? args.scope : args.path];
  if (call.name === "write" && args.from !== undefined) {
    if (!args.from || typeof args.from !== "object" || Array.isArray(args.from)) return false;
    paths.push((args.from as Record<string, unknown>).path);
  }
  return paths.every((path) => {
    if (typeof path !== "string") return false;
    const parsed = parseUnifiedContextUri(splitDocumentFile(path).filePath);
    return parsed.ok && parsed.value.scheme === "scratch";
  });
}
