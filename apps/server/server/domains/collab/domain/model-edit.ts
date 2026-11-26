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

export class ModelEditRefusal extends Error {
  constructor(
    readonly toolResult: ModelEditToolResult,
    readonly evidence?: ResultEvidence,
  ) {
    super("A model edit was refused");
    this.name = "ModelEditRefusal";
  }
}

export type ModelEditWriteContext = RoutedWriteContext & {
  creditedBlockIds?: readonly string[];
};

export type ModelEdits = {
  run(input: {
    key: ModelEditKey;
    owner: { threadId: string; turnId: string };
    signal: AbortSignal;
    effect(): Promise<{
      toolResult: ModelEditToolResult;
      evidence?: ResultEvidence;
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
