/** Result-aware command barriers at the ContextFS production owner. */
import { describe, expect, it, vi } from "vitest";
import { Err, Ok } from "../../../../shared/result.js";
import { createInMemoryCollabDomain } from "../../../collab/index.js";
import { createResultAwareCommandExecutor } from "../../context/result-aware-command-executor.js";
import type { ContextCommandTransaction } from "../../ports/context-command-transaction.js";
import { ContextFS } from "./context-fs.js";
import {
  createInMemoryContextDocumentStoreBacking,
  InMemoryContextDocumentStore,
  InMemoryContextTreeMutationStore,
} from "./in-memory-store.js";

const SOURCE_ID = "00000000-0000-4000-8000-000000000911";
const UNTITLED_ID = "00000000-0000-4000-8000-000000000912";

describe("ResultAwareCommandExecutor at the ContextFS owner", () => {
  it("enters the supplied transaction and converts a returned Err into rollback", async () => {
    const durable: string[] = [];
    const transaction: ContextCommandTransaction = {
      run: vi.fn(async (operation) => {
        const before = [...durable];
        try {
          return await operation();
        } catch (error) {
          durable.splice(0, durable.length, ...before);
          throw error;
        }
      }),
    };
    const executor = createResultAwareCommandExecutor<{ code: "rejected" }>({
      transaction,
      serializeThroughCallbacks: true,
    });

    await expect(
      executor.run(async () => {
        durable.push("uncommitted");
        return Err({ code: "rejected" });
      }),
    ).resolves.toEqual(Err({ code: "rejected" }));
    expect(transaction.run).toHaveBeenCalledOnce();
    expect(durable).toEqual([]);
  });

  it("propagates a non-result exception unchanged", async () => {
    const failure = new Error("transaction infrastructure failed");
    const executor = createResultAwareCommandExecutor({
      transaction: { run: (operation) => operation() },
      serializeThroughCallbacks: true,
    });

    await expect(
      executor.run(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("serializes same-owner commands through transaction callback settlement", async () => {
    let settleFirst!: () => void;
    const firstCallbacksSettled = new Promise<void>((resolve) => {
      settleFirst = resolve;
    });
    let transactionEntries = 0;
    const transaction: ContextCommandTransaction = {
      run: async (operation) => {
        transactionEntries += 1;
        const result = await operation();
        if (transactionEntries === 1) await firstCallbacksSettled;
        return result;
      },
    };
    const executor = createResultAwareCommandExecutor({
      transaction,
      serializeThroughCallbacks: true,
    });

    const first = executor.run(async () => Ok("first"));
    await vi.waitFor(() => expect(transactionEntries).toBe(1));
    const second = executor.run(async () => Ok("second"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transactionEntries).toBe(1);

    settleFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([Ok("first"), Ok("second")]);
    expect(transactionEntries).toBe(2);
  });

  it("keeps a committed Ok stable when the transaction settles callback failures", async () => {
    const transaction: ContextCommandTransaction = {
      run: async (operation) => {
        const committed = await operation();
        await Promise.allSettled([Promise.reject(new Error("post-commit callback failed"))]);
        return committed;
      },
    };
    const executor = createResultAwareCommandExecutor({
      transaction,
      serializeThroughCallbacks: true,
    });

    await expect(executor.run(async () => Ok({ receipt: "committed" }))).resolves.toEqual(
      Ok({ receipt: "committed" }),
    );
  });
});

it("routes every current first-touch ContextFS mutation through the command owner", async () => {
  const backing = createInMemoryContextDocumentStoreBacking();
  const store = new InMemoryContextDocumentStore({ sourceId: SOURCE_ID, backing });
  let transactionEntries = 0;
  const transaction: ContextCommandTransaction = {
    run<T>(operation: () => Promise<T>) {
      transactionEntries += 1;
      return store.transaction(operation);
    },
  };
  const context = new ContextFS({
    store,
    mutationStore: new InMemoryContextTreeMutationStore(backing),
    documentSync: createInMemoryCollabDomain(),
    commandTransaction: transaction,
    scheme: "manuscript",
  });

  async function expectOneTransaction(operation: () => Promise<unknown>): Promise<void> {
    const before = transactionEntries;
    await expect(operation()).resolves.toMatchObject({ ok: true });
    expect(transactionEntries - before).toBe(1);
  }

  await expectOneTransaction(() => context.write("written.md", "one"));
  await expectOneTransaction(() => context.createTrackedDocument("created.md", "two"));
  await expectOneTransaction(() =>
    context.createUntitledDocument("", {
      documentId: UNTITLED_ID,
      origin: { type: "system" },
    }),
  );
  await expectOneTransaction(() => context.ensureTrackedDocument("ensured.md"));
  await expectOneTransaction(() =>
    context.edit("written.md", { kind: "append", content: " updated" }),
  );
  await expectOneTransaction(() =>
    context.writeBinary("image.png", {
      fileType: "image",
      storageUrl: "s3://bucket/image.png",
      mimeType: "image/png",
      sizeBytes: 42,
    }),
  );
  await expectOneTransaction(() => context.mkdir("folder"));
});
