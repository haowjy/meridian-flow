// Raw fixture model producers reserve identity before durable draft admission.
import { createDrizzleDraftStore } from "../adapters/drizzle-drafts.js";
import { createDrizzleJournal } from "../adapters/drizzle-journal.js";
import type { AppendDraftJournalInput } from "../domain/draft-store.js";

export function createFixtureDraftStore(...args: Parameters<typeof createDrizzleDraftStore>) {
  const store = createDrizzleDraftStore(...args);
  const journal = createDrizzleJournal(args[0]);
  return {
    ...store,
    appendRows(input: Parameters<typeof store.appendRows>[0]) {
      return store.appendRows({
        ...input,
        async finalize(read) {
          const finalized = await input.finalize(read);
          if (finalized.status !== "appended") return finalized;
          // One ordinal per logical write, so the receipt groups finalization formed hold.
          const ordinals = new Map<string, number>();
          const rows: AppendDraftJournalInput[] = [];
          for (const [index, row] of finalized.rows.entries()) {
            if (row.source !== "agent" || !row.threadId || row.wId != null) {
              rows.push(row);
              continue;
            }
            const key = row.documentEditKey ?? `${index}`;
            let wId = ordinals.get(key);
            if (wId === undefined) {
              wId = await journal.reserveWriteOrdinal(read.documentDraft.documentId, row.threadId);
              ordinals.set(key, wId);
            }
            rows.push({ ...row, wId });
          }
          return { ...finalized, rows };
        },
      });
    },
  };
}
