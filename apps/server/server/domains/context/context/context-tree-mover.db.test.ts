/** Result and CAS semantics at the ContextTreeMover production owner. */
import { describe, expect, it, vi } from "vitest";
import { Err, Ok } from "../../../shared/result.js";
import type { ContextSchemeAdapter } from "../ports/context-adapter.js";
import type { ContextCommandTransaction } from "../ports/context-command-transaction.js";
import type { ContextLocationToken } from "../ports/context-tree-mutation-store.js";
import { type ContextTreeDispatch, ContextTreeMover } from "./context-tree-mover.js";

const sourceToken: ContextLocationToken = {
  kind: "file",
  nodeId: "document-1",
  sourceId: "source-1",
  path: "draft.md",
  filetype: "markdown",
};

function dispatch(input: {
  canonical: string;
  path: string;
  token?: ContextLocationToken | null;
}): ContextTreeDispatch {
  const adapter = {
    name: "manuscript",
    capabilities: { writable: true, searchable: true, creatable: true },
    tree: {
      inspectMovable: vi.fn(async (path: string) => {
        if (path === "") {
          return Ok({
            kind: "directory" as const,
            nodeId: "__context_root__",
            sourceId: "source-1",
            path,
          });
        }
        if (path === input.path) return Ok(input.token === undefined ? sourceToken : input.token);
        return Ok(null);
      }),
      commitProvisionalGraduation: vi.fn(async () => Ok(undefined)),
      commitPreparedMove: vi.fn(async (prepared) =>
        Ok({ movedNodeId: prepared.source.nodeId, path: prepared.destinationPath }),
      ),
      commitRecursiveDelete: vi.fn(async (command) =>
        Ok({
          deletedDocumentIds: command.root.kind === "file" ? [command.root.nodeId] : [],
          availabilityGeneration: "7",
        }),
      ),
    },
  } as unknown as ContextSchemeAdapter;
  return {
    adapter,
    scheme: "manuscript",
    workScopeId: null,
    path: input.path,
    canonical: input.canonical,
  };
}

describe("ContextTreeMover result-aware command ownership", () => {
  it("enters one transaction and preserves semantic move results", async () => {
    const transaction: ContextCommandTransaction = { run: vi.fn((operation) => operation()) };
    const mover = new ContextTreeMover(transaction);
    const source = dispatch({ canonical: "manuscript://draft.md", path: "draft.md" });
    const destination = dispatch({
      canonical: "manuscript://archive.md",
      path: "archive.md",
      token: null,
    });

    await expect(mover.move(source, destination)).resolves.toEqual(
      Ok({ movedNodeId: "document-1", destinationPath: "archive.md" }),
    );
    expect(transaction.run).toHaveBeenCalledOnce();
  });

  it("returns same-path preflight Err through rollback and propagates non-result exceptions", async () => {
    const transaction: ContextCommandTransaction = { run: vi.fn((operation) => operation()) };
    const mover = new ContextTreeMover(transaction);
    const target = dispatch({ canonical: "manuscript://draft.md", path: "draft.md" });

    await expect(mover.move(target, target)).resolves.toEqual(
      Err({ code: "invalid_operation", uri: "manuscript://draft.md" }),
    );
    const failure = new Error("transaction unavailable");
    const failing = new ContextTreeMover({ run: async () => Promise.reject(failure) });
    await expect(failing.move(target, target)).rejects.toBe(failure);
  });

  it("does not serialize independent mover commands behind callback settlement", async () => {
    let settleFirst!: () => void;
    const firstSettled = new Promise<void>((resolve) => {
      settleFirst = resolve;
    });
    let entries = 0;
    const transaction: ContextCommandTransaction = {
      async run<T>(operation: () => Promise<T>): Promise<T> {
        entries += 1;
        const current = entries;
        try {
          return await operation();
        } catch (error) {
          if (current === 1) await firstSettled;
          throw error;
        }
      },
    };
    const mover = new ContextTreeMover(transaction);
    const target = dispatch({ canonical: "manuscript://draft.md", path: "draft.md" });

    const first = mover.move(target, target);
    await vi.waitFor(() => expect(entries).toBe(1));
    const second = mover.move(target, target);
    await vi.waitFor(() => expect(entries).toBe(2));
    settleFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([
      Err({ code: "invalid_operation", uri: target.canonical }),
      Err({ code: "invalid_operation", uri: target.canonical }),
    ]);
  });

  it("preserves graduation and stale delete result mappings", async () => {
    const mover = new ContextTreeMover();
    const target = dispatch({ canonical: "manuscript://draft.md", path: "draft.md" });

    await expect(mover.commitWriterLocation(target, target)).resolves.toEqual(
      Ok({ movedNodeId: "document-1", destinationPath: "draft.md" }),
    );
    if (!target.adapter.tree) throw new Error("test adapter must own tree commands");
    vi.mocked(target.adapter.tree.commitRecursiveDelete).mockResolvedValueOnce(
      Err({ code: "stale_source" }),
    );
    await expect(
      mover.delete(target, { expected: { kind: "file", documentId: "document-1" } }),
    ).resolves.toEqual(Err({ code: "stale_target", uri: "manuscript://draft.md" }));
  });
});
