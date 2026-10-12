/** CLI document inputs use the shared codec and report the server's stored URI. */
import { describe, expect, it } from "vitest";
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
    ).toEqual({ uri: "manuscript://Chapter 13", documentId: "document-1", replaced: false });
  });
});
