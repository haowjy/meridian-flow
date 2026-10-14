/**
 * Pure read of a write-mode switch turn.
 *
 * A switch is a complete `system` turn with `metadata.kind === "write_mode_switch"`.
 * Metadata is read defensively: the server owns its shape.
 */
import type { Turn } from "@meridian/contracts/protocol";
import type { AiWriteMode } from "@meridian/contracts/works";

export type WriteModeSwitchFacts = {
  mode: AiWriteMode;
  /** The writer command this switch turn ran (`controlMessageId`). */
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
