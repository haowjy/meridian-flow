/** CLI document inputs use the shared codec and report the server's stored URI. */
import { describe, expect, it } from "vitest";
import { CliError } from "../../core/cli-error";
import type { Session } from "../../core/session";
import { putDocument } from "./put";
import { resolveUri } from "./uri";

const session: Session = {
  serverUrl: "https://unused.test",
  cookie: "",
  ca: undefined,
  async request<T>() {
    return { status: "created", documentId: "document-1", uri: "manuscript://Chapter 13" } as T;
  },
};

describe("CLI document names", () => {
  it("accepts every prose spelling, preserving the writer's dots and case", async () => {
    for (const suffix of ["", ".md", ".markdown", ".mdx", ".txt"]) {
      expect(await resolveUri(session, "project", `manuscript://Vol. 2${suffix}`)).toMatchObject({
        path: "Vol. 2",
        uri: "manuscript://Vol. 2",
      });
    }
    expect(
      await putDocument(session, {
        projectId: "project",
        uri: "manuscript://Chapter 13.TXT",
        content: "A story",
        overwrite: false,
      }),
    ).toEqual({
      uri: "manuscript://Chapter 13",
      documentId: "document-1",
      replaced: false,
      previousDocumentId: null,
    });
  });
});

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
