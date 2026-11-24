import type { ModelEditKey, ModelEditOutcome } from "@meridian/contracts/drafts";

export interface CommandResolver {
  resolveCommand(key: ModelEditKey): Promise<ModelEditOutcome>;
}
