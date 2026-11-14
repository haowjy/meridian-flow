/** The host's side of `host_effects`: what each kind the runtime records does in the host's tables. */

import type { UploadIntake } from "../../domains/context/index.js";
import type { HostEffects } from "../../domains/runtime/index.js";
import { type DrizzleDatabase, runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";

export function createHostEffects(deps: {
  db: DrizzleDatabase;
  uploadIntake: Pick<UploadIntake, "consume">;
}): HostEffects {
  return {
    async handle(effect) {
      switch (effect.kind) {
        case "uploads.used": {
          const { documentIds, chatId } = effect.payload as {
            documentIds: string[];
            chatId: string;
          };
          // One transaction, so a step added after the update fails with it and the retry does both.
          await runInDrizzleTransaction(deps.db, () =>
            deps.uploadIntake.consume(documentIds, chatId),
          );
          return;
        }
        default:
          throw new Error(`No host handler for effect kind "${effect.kind}"`);
      }
    },
  };
}
