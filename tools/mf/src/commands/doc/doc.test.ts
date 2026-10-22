/** CLI document inputs use the shared codec and report the server's stored URI. */
import { describe, expect, it } from "vitest";
import { CliError } from "../../core/cli-error";
import type { Session } from "../../core/session";
import { putDocument } from "./put";

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

  it("says the old document was already deleted when the create fails", async () => {
    await expect(putDocument(scripted("fail"), input)).rejects.toThrow(/old-id.*already deleted/);
  });
});
