/**
 * A model's document-changing call as a command: `run` is the one transaction that claims the
 * call's id, runs its effect and stores its outcome, and `write` is the one operation inside it
 * that reads, plans and appends under the document's lock.
 */

import type { WriteCommand } from "@meridian/agent-edit/integration";
import type {
  ModelEditKey,
  ModelEditOutcome,
  ModelEditToolResult,
} from "@meridian/contracts/branches";
import type { RoutedWriteContext, RoutedWriteOutcome } from "./agent-edit-cores.js";

/** An effect turned the call away: its savepoint rolls back and `toolResult` is the stored answer. */
export class ModelEditRefusal<E = unknown> extends Error {
  constructor(
    readonly toolResult: ModelEditToolResult,
    /** What the refused result showed the model; it rides back in memory with the answer. */
    readonly evidence?: E,
  ) {
    super("A model edit was refused");
    this.name = "ModelEditRefusal";
  }
}

export type ModelEdits = {
  /**
   * Claims the call's command id, runs `effect` under it and stores what it returns. The effect
   * throws `ModelEditRefusal` to answer without changing anything; any other throw rolls the
   * claim back with it. A repeat of a settled key answers its stored outcome without the effect.
   * `evidence` rides back in memory: it is not stored. Refuses an ambient transaction.
   */
  run<E>(input: {
    key: ModelEditKey;
    signal: AbortSignal;
    effect(): Promise<{ toolResult: ModelEditToolResult; evidence?: E }>;
  }): Promise<{ outcome: ModelEditOutcome; evidence?: E }>;
  /**
   * What the call under `key` came to: waits on a transaction still holding it, and stops a call
   * that never started (`never`), so a late attempt under the key refuses.
   */
  resolve(key: ModelEditKey): Promise<ModelEditOutcome>;
  /**
   * The call's write at its destination, read, planned and appended under the lock the append
   * takes. Valid only inside a `run` effect: it joins that transaction.
   */
  write(command: WriteCommand, context: RoutedWriteContext): Promise<RoutedWriteOutcome>;
};
