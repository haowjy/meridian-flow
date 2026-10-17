// Raw fixture model producers reserve identity before durable branch admission.
import { createDrizzleBranchStore } from "../adapters/drizzle-branches.js";
import { createDrizzleJournal } from "../adapters/drizzle-journal.js";

export function createFixtureBranchStore(...args: Parameters<typeof createDrizzleBranchStore>) {
  const store = createDrizzleBranchStore(...args);
  const journal = createDrizzleJournal(args[0]);
  return {
    ...store,
    async appendRows(input: Parameters<typeof store.appendRows>[0]) {
      const branch = await store.getBranch(input.branchId);
      if (!branch) return store.appendRows(input);
      const ordinals = new Map<string, number>();
      const journals = [];
      for (const [index, row] of input.rows.entries()) {
        if (row.source !== "agent" || !row.threadId || row.wId != null) {
          journals.push(row);
          continue;
        }
        const key = row.documentEditKey ?? `${index}`;
        let wId = ordinals.get(key);
        if (wId === undefined) {
          wId = await journal.reserveWriteOrdinal(branch.documentId, row.threadId);
          ordinals.set(key, wId);
        }
        journals.push({ ...row, wId });
      }
      return store.appendRows({ ...input, rows: journals });
    },
  };
}
