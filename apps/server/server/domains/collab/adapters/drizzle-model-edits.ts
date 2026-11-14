/** Postgres model edits: the command claim, the effect's transaction, and `resolve`. */
import type {
  ModelEditCommandResult,
  ModelEditKey,
  ModelEditOutcome,
} from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import { CommandExistsError } from "../../../shared/commands/command-record.js";
import { lookupCommand, resolveCommand } from "../../../shared/commands/drizzle-commands.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { modelEditIds } from "../../../shared/model-edit-ids.js";
import { evidenceFrontiers } from "../../../shared/model-evidence.js";
import { ModelEditRefusal, type ModelEdits } from "../domain/model-edit.js";
import type { ModelEvidence } from "../domain/model-evidence.js";
import { runDocumentCommand } from "./drizzle-document-commands.js";

export function createDrizzleModelEdits(
  db: Database,
  seams: Pick<ModelEdits, "write" | "catchUp">,
  evidence: Pick<ModelEvidence, "resultStored">,
): ModelEdits {
  async function stored(key: ModelEditKey): Promise<ModelEditOutcome> {
    const ids = modelEditIds(key);
    const found = await lookupCommand(currentDrizzleDb(db), {
      commandId: ids.commandId,
      accountId: key.accountId,
      digest: ids.digest,
    });
    if (found.kind !== "stored" || found.commandKind !== "model_edit")
      throw new Error(`Command ${ids.commandId} is not this call's model edit`);
    return found.outcome as ModelEditOutcome;
  }

  return {
    ...seams,

    async run({ key, owner, signal, effect }) {
      const ids = modelEditIds(key);
      let refusedEvidence: Awaited<ReturnType<typeof effect>>["evidence"];
      try {
        const result = await runDocumentCommand<ModelEditCommandResult>(
          db,
          {
            commandId: ids.commandId,
            accountId: key.accountId,
            projectId: key.projectId,
            threadId: key.threadId,
            kind: "model_edit",
            digest: ids.digest,
          },
          async () => {
            signal.throwIfAborted();
            const done = await effect();
            // A call the runtime stopped waiting for must not land after it stored `never`.
            signal.throwIfAborted();
            if (done.evidence)
              await evidence.resultStored({
                projectId: key.projectId,
                ...owner,
                shown: done.evidence.shown,
                frontiers: evidenceFrontiers(ids.blockId, done.evidence),
              });
            return { status: "edited" as const, toolResult: done.toolResult };
          },
          (cause) => {
            if (!(cause instanceof ModelEditRefusal)) return undefined;
            refusedEvidence = cause.evidence;
            return { status: "refused" as const, toolResult: cause.toolResult };
          },
        );
        return {
          outcome: { status: result.status === "edited" ? "done" : "refused", result },
          ...(refusedEvidence === undefined ? {} : { evidence: refusedEvidence }),
        };
      } catch (cause) {
        if (cause instanceof CommandExistsError) return { outcome: await stored(key) };
        throw cause;
      }
    },

    async resolve(key) {
      const ids = modelEditIds(key);
      await resolveCommand(db, {
        commandId: ids.commandId,
        accountId: key.accountId,
        kind: "model_edit",
        projectId: key.projectId,
        threadId: key.threadId,
        digest: ids.digest,
      });
      return stored(key);
    },
  };
}
