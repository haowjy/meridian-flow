/**
 * A model's document-changing call as a command: `run` is the one transaction that claims the
 * call's id, runs its effect and stores its outcome, and `write` is the one operation inside it
 * that reads, plans and appends under the document's lock.
 */

import type { ReadCommand, WriteCommand, WriteOutcome } from "@meridian/agent-edit/integration";
import type { Settlement } from "@meridian/contracts/commands";
import type {
  ModelEditKey,
  ModelEditOutcome,
  ModelEditToolResult,
} from "@meridian/contracts/drafts";
import type { ResultEvidence } from "../../../shared/model-evidence.js";
import type {
  RoutedReadContext,
  RoutedWriteContext,
  RoutedWriteOutcome,
} from "./agent-edit-cores.js";

/** An effect turned the call away: its savepoint rolls back and `toolResult` is the stored answer. */
export class ModelEditRefusal extends Error {
  constructor(
    readonly toolResult: ModelEditToolResult,
    /** What the refused result showed the model; it rides back in memory with the answer. */
    readonly evidence?: ResultEvidence,
  ) {
    super("A model edit was refused");
    this.name = "ModelEditRefusal";
  }
}

/** A model edit's write context: the routed one, and the blocks the model's frontiers are read among. */
export type ModelEditWriteContext = RoutedWriteContext & {
  creditedBlockIds?: readonly string[];
};

export type ModelEdits = {
  /**
   * Claims the call's command id, runs `effect` under it and stores what it returns. The effect
   * throws `ModelEditRefusal` to answer without changing anything; any other throw rolls the
   * claim back with it. A repeat of a settled key answers its stored outcome without the effect.
   * What an edit's result showed the model is recorded in the same transaction, under the result
   * block's id (`modelEditIds(key).blockId`); a refused edit records none, and what its answer
   * showed rides back in memory for the runtime to hand on once the block is stored. Refuses an
   * ambient transaction.
   */
  run(input: {
    key: ModelEditKey;
    /** The thread and turn the result block belongs to. */
    owner: { threadId: string; turnId: string };
    signal: AbortSignal;
    effect(): Promise<{
      toolResult: ModelEditToolResult;
      evidence?: ResultEvidence;
      /** Set when the call changed nothing and says why (a `returned` edit). */
      settled?: Settlement[];
    }>;
  }): Promise<{ outcome: ModelEditOutcome; evidence?: ResultEvidence }>;
  /**
   * What the call under `key` came to: waits on a transaction still holding it, and stops a call
   * that never started (`never`), so a late attempt under the key refuses.
   */
  resolve(key: ModelEditKey): Promise<ModelEditOutcome>;
  /**
   * The call's write at its destination, read, planned and appended under the lock the append
   * takes. Valid only inside a `run` effect: it joins that transaction.
   */
  write(command: WriteCommand, context: ModelEditWriteContext): Promise<RoutedWriteOutcome>;
  /**
   * A read inside a `run` effect: it joins the command's transaction and pulls nothing from live
   * (the document was caught up before `run`). A returned edit shows the document with it.
   */
  read(command: ReadCommand, context: RoutedReadContext): Promise<WriteOutcome>;
};
