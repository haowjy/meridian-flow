/** Shared admission-order contract for live and branch writer updates. */

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { admitWriterUpdate } from "./document-mutation-policy.js";

describe.each(["live", "branch"])("%s writer admission", () => {
  it("validates the target, acknowledges exact containment, then validates fresh authorship", async () => {
    const calls: string[] = [];
    const targetDocument = new Y.Doc({ gc: false });
    targetDocument.getText("content").insert(0, "writer");
    const append = vi.fn(async () => {
      calls.push("append");
      return "appended";
    });

    await expect(
      admitWriterUpdate({
        targetDocument,
        update: Y.encodeStateAsUpdate(targetDocument),
        validateTarget() {
          calls.push("target");
        },
        isContained() {
          calls.push("containment");
          return true;
        },
        append,
      }),
    ).resolves.toEqual({ admitted: false });

    expect(calls).toEqual(["target", "containment"]);
    expect(append).not.toHaveBeenCalled();
  });

  it("validates fresh authorship immediately before durable append", async () => {
    const calls: string[] = [];
    const targetDocument = new Y.Doc({ gc: false });
    const writer = new Y.Doc({ gc: false });
    writer.getText("content").insert(0, "writer");

    await expect(
      admitWriterUpdate({
        targetDocument,
        update: Y.encodeStateAsUpdate(writer),
        validateTarget() {
          calls.push("target");
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

    expect(calls).toEqual(["target", "containment", "append"]);
  });
});
