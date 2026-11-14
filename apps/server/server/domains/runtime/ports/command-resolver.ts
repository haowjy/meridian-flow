/** The runtime's door to the document commands a model's tool calls make effects through. */
import type { ModelEditKey, ModelEditOutcome } from "@meridian/contracts/branches";

export interface CommandResolver {
  /**
   * What the call under `key` came to, for a caller that stopped waiting for it. A call still
   * running is waited for; one that never started is stopped for good (`never`).
   */
  resolveCommand(key: ModelEditKey): Promise<ModelEditOutcome>;
}
