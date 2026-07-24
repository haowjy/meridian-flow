/** Shared admission-order contract for live and branch writer updates. */

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { admitWriterUpdate } from "./document-authority.js";

describe.each(["live", "branch"])("%s writer admission", () => {
  it("validates authority, acknowledges exact containment, then validates fresh authorship", async () => {
    const calls: string[] = [];
    const authority = new Y.Doc({ gc: false });
    authority.getText("content").insert(0, "writer");
    const append = vi.fn(async () => {
      calls.push("append");
      return "appended";
    });

    await expect(
      admitWriterUpdate({
        authority,
        update: Y.encodeStateAsUpdate(authority),
        validateAuthority() {
          calls.push("authority");
        },
        isContained() {
          calls.push("containment");
          return true;
        },
        append,
      }),
    ).resolves.toEqual({ admitted: false });

    expect(calls).toEqual(["authority", "containment"]);
    expect(append).not.toHaveBeenCalled();
  });

  it("validates fresh authorship immediately before durable append", async () => {
    const calls: string[] = [];
    const authority = new Y.Doc({ gc: false });
    const writer = new Y.Doc({ gc: false });
    writer.getText("content").insert(0, "writer");

    await expect(
      admitWriterUpdate({
        authority,
        update: Y.encodeStateAsUpdate(writer),
        validateAuthority() {
          calls.push("authority");
        },
        isContained() {
          calls.push("containment");
          return false;
        },
        async append() {
          calls.push("append");
          return "appended";
        },
      }),
    ).resolves.toEqual({ admitted: true, value: "appended" });

    expect(calls).toEqual(["authority", "containment", "append"]);
  });
});
