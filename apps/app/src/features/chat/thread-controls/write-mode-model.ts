/**
 * Pure reads of write-mode divider turns, and of every writer command a divider
 * already answers.
 *
 * A switch is a complete `system` turn with `metadata.kind === "write_mode_switch"`.
 * Metadata is read defensively: the server owns its shape.
 */
import type { Turn } from "@meridian/contracts/protocol";
import type { AiWriteMode } from "@meridian/contracts/works";
import { readCompactionFacts } from "../compaction/compaction-model";

export type WriteModeSwitchFacts = {
  mode: AiWriteMode;
  /** The writer command this divider ran (`controlMessageId`). */
  controlId: string | null;
};

export function readWriteModeSwitch(turn: Turn): WriteModeSwitchFacts | null {
  const metadata = turn.metadata;
  if (
    turn.role !== "system" ||
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  )
    return null;
  const record = metadata as Record<string, unknown>;
  if (record.kind !== "write_mode_switch") return null;
  if (record.mode !== "draft" && record.mode !== "direct") return null;
  const controlId = record.controlMessageId;
  return {
    mode: record.mode,
    controlId: typeof controlId === "string" && controlId.length > 0 ? controlId : null,
  };
}

/** The mode the newest divider switched to, or null before any switch. */
export function latestWriteModeSwitch(
  turns: readonly Turn[],
): { turn: Turn; mode: AiWriteMode } | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const facts = turn ? readWriteModeSwitch(turn) : null;
    if (turn && facts) return { turn, mode: facts.mode };
  }
  return null;
}

/** Every writer command a divider already answers: a queued item for one is no longer queued. */
export function answeredControlIds(turns: readonly Turn[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const turn of turns) {
    const id =
      turn.role === "compaction"
        ? readCompactionFacts(turn).controlId
        : (readWriteModeSwitch(turn)?.controlId ?? null);
    if (id) ids.add(id);
  }
  return ids;
}
