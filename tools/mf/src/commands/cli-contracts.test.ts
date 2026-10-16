import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/** CLI document inputs use the shared codec and report the server's stored URI. */
import { describe, expect, it } from "vitest";
import { CliError, EXIT } from "../core/cli-error";
import type { Session } from "../core/session";
import { startWire } from "../test-support/wire";
import { replyScenario } from "../test-support/wire-fixtures";
import { putDocument } from "./doc/put";

const session: Session = {
  serverUrl: "https://unused.test",
  cookie: "",
  ca: undefined,
  async request<T>() {
    return { status: "created", documentId: "document-1", uri: "manuscript://Chapter 13" } as T;
  },
};

describe("doc put --overwrite", () => {
  const conflict = new CliError("http_error", "conflict", { details: { status: "conflict" } });
  const input = { projectId: "project", uri: "kb://Lin", content: "x", overwrite: true };
  // Calls in order: create (conflict), resolve id, delete, create again.
  function scripted(secondCreate: "ok" | "fail"): Session {
    let creates = 0;
    return {
      ...session,
      async request<T>(method: string, path: string) {
        if (method === "POST" && path.includes("/create")) {
          creates += 1;
          if (creates === 1) throw conflict;
          if (secondCreate === "fail") throw new CliError("http_error", "boom");
          return { status: "created", documentId: "new-id", uri: "kb://Lin" } as T;
        }
        if (path.includes("/delete")) return {} as T;
        return { kind: "available", document: { documentId: "old-id" } } as T;
      },
    };
  }

  it("names the deleted document id", async () => {
    const result = await putDocument(scripted("ok"), input);
    expect(result).toMatchObject({ replaced: true, documentId: "new-id" });
    expect(result.previousDocumentId).toBe("old-id");
  });

  it("says the old document was already deleted when the create fails", async () => {
    await expect(putDocument(scripted("fail"), input)).rejects.toThrow(/old-id.*already deleted/);
  });
});

it("does not let a later complete send hide an earlier failed send", async () => {
  const wire = await startWire();
  // The first message's reply fails; the second's completes.
  replyScenario(wire, [
    { status: "error" },
    { status: "complete" },
    { status: "error" },
    { status: "complete" },
  ]);
  const dir = mkdtempSync(join(tmpdir(), "mf-seed-"));
  const fixture = join(dir, "scenario.json");
  writeFileSync(
    fixture,
    JSON.stringify({ thread: {}, messages: [{ text: "fail" }, { text: "hi" }] }),
  );
  try {
    const result = await wire.mf(["seed", fixture, "--json"]);
    expect(result.code).toBe(EXIT.failed);
    const record = JSON.parse(result.stdout);
    expect(record).toMatchObject({
      type: "result",
      command: "seed",
      outcome: "failed",
      reason: null,
    });
    expect(record.messages).toMatchObject([
      { type: "result", command: "thread.send", outcome: "failed", reason: null },
      { type: "result", command: "thread.send", outcome: "complete", reason: null },
    ]);
  } finally {
    await wire.close();
    rmSync(dir, { recursive: true });
  }
});
