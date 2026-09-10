import { describe, expect, it } from "vitest";
import { type LocalLineageEnvelope, reduceLocalUntitledLineage } from "./local-untitled-lineage";

function local(): LocalLineageEnvelope {
  return {
    version: 3,
    kind: "local",
    ref: { accountId: "account", projectId: "project", lineageHandle: "lineage" },
    envelopeRevision: 1,
    active: { documentId: "A", identityRevision: 1 },
    persistence: { persistenceId: "p", exactDatabaseName: "exact-p" },
    work: {
      workRevision: 1,
      home: null,
      createSettlement: { kind: "ready" },
      pendingSinceMs: null,
    },
    aliases: {},
  };
}

function applied(result: ReturnType<typeof reduceLocalUntitledLineage>) {
  expect(result.kind).toBe("applied");
  if (result.kind !== "applied") throw new Error("expected applied");
  return result.next;
}

describe("local Untitled lineage reducer", () => {
  it("publishes remint identity and its minimal alias in one next value", () => {
    const next = applied(
      reduceLocalUntitledLineage(local(), {
        kind: "commit-remint",
        expectedIdentityRevision: 1,
        replacementDocumentId: "B",
        publicationObligationId: "pub-A",
      }),
    );
    expect(next).toMatchObject({
      kind: "local",
      active: { documentId: "B", identityRevision: 2 },
      persistence: { exactDatabaseName: "exact-p" },
      aliases: { A: { publicationObligationId: "pub-A", introducedAtIdentityRevision: 2 } },
    });
    if (next.kind !== "local") throw new Error("expected local");
    expect(Object.keys(next.aliases.A ?? {})).toEqual([
      "publicationObligationId",
      "introducedAtIdentityRevision",
    ]);
  });

  it("normalizes A and B aliases through the current C authority", () => {
    const b = applied(
      reduceLocalUntitledLineage(local(), {
        kind: "commit-remint",
        expectedIdentityRevision: 1,
        replacementDocumentId: "B",
        publicationObligationId: "pub-A",
      }),
    );
    const c = applied(
      reduceLocalUntitledLineage(b, {
        kind: "commit-remint",
        expectedIdentityRevision: 2,
        replacementDocumentId: "C",
        publicationObligationId: "pub-B",
      }),
    );
    expect(c.kind).toBe("local");
    if (c.kind !== "local") return;
    expect(c.active.documentId).toBe("C");
    expect(Object.keys(c.aliases).sort()).toEqual(["A", "B"]);
    expect(c.persistence.exactDatabaseName).toBe("exact-p");
  });

  it("fences stale alias acknowledgements and settles only the exact obligation", () => {
    const b = applied(
      reduceLocalUntitledLineage(local(), {
        kind: "commit-remint",
        expectedIdentityRevision: 1,
        replacementDocumentId: "B",
        publicationObligationId: "pub-A",
      }),
    );
    expect(
      reduceLocalUntitledLineage(b, {
        kind: "acknowledge-remint-publication",
        obsoleteDocumentId: "A",
        obligationId: "wrong",
        minimumIdentityRevision: 2,
      }).kind,
    ).toBe("stale");
    const settled = applied(
      reduceLocalUntitledLineage(b, {
        kind: "acknowledge-remint-publication",
        obsoleteDocumentId: "A",
        obligationId: "pub-A",
        minimumIdentityRevision: 2,
      }),
    );
    expect(settled.kind !== "terminal" && settled.aliases).toEqual({});
  });

  it("keeps adoption sync and tab publication independent then removes final truth", () => {
    const adopted = applied(
      reduceLocalUntitledLineage(local(), {
        kind: "commit-adoption",
        expectedIdentityRevision: 1,
        adoptionRevision: 2,
        canonicalSyncObligationId: "sync",
        publicationObligationId: "tab",
      }),
    );
    expect(adopted.kind).toBe("adopted");
    const afterSync = reduceLocalUntitledLineage(adopted, {
      kind: "acknowledge-canonical-sync",
      obligationId: "sync",
      documentId: "A",
      adoptionRevision: 2,
    });
    const remaining = applied(afterSync);
    expect(remaining.kind === "adopted" && remaining.publication?.obligationId).toBe("tab");
    expect(
      reduceLocalUntitledLineage(remaining, {
        kind: "acknowledge-adoption-publication",
        obligationId: "tab",
        documentId: "A",
        adoptionRevision: 2,
      }).kind,
    ).toBe("removed");
  });

  it("replaces authoring truth with terminal truth and removes it on exact cleanup", () => {
    const terminal = applied(
      reduceLocalUntitledLineage(local(), {
        kind: "commit-terminal",
        transitionId: "terminal-4",
        terminalGeneration: "4",
        exactDatabaseName: "exact-p",
        cleanupObligationId: "cleanup",
      }),
    );
    expect(terminal.kind).toBe("terminal");
    expect(
      reduceLocalUntitledLineage(terminal, {
        kind: "acknowledge-terminal-cleanup",
        transitionId: "terminal-4",
        terminalGeneration: "4",
        exactDatabaseName: "other",
        cleanupObligationId: "cleanup",
      }).kind,
    ).toBe("stale");
    expect(
      reduceLocalUntitledLineage(terminal, {
        kind: "acknowledge-terminal-cleanup",
        transitionId: "terminal-4",
        terminalGeneration: "4",
        exactDatabaseName: "exact-p",
        cleanupObligationId: "cleanup",
      }).kind,
    ).toBe("removed");
  });
});
