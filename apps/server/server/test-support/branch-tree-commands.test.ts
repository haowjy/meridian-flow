/** Reader probes must distinguish absence from a failed observation.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Branch-tree harness absence and malformed-result handling
 */
import { describe, expect, it } from "vitest";
import type { ContextPort } from "../domains/context/ports/context-port.js";
import { branchTreeCommands } from "./branch-tree-commands.js";

function reader(result: unknown) {
  const port = {
    read: async () => result,
    stat: async () => result,
  } as unknown as ContextPort;
  const world = {
    project: { id: "project", userId: "writer" },
    works: () => [],
  } as unknown as Parameters<typeof branchTreeCommands>[0];
  const composed = () =>
    ({
      runtime: { ports: { contextPorts: { forProject: () => port } } },
    }) as unknown as ReturnType<Parameters<typeof branchTreeCommands>[1]>;
  return branchTreeCommands(world, composed).view("live");
}

describe("branch-tree reader observations", () => {
  it("only not_found means absent, not a broken read or stat", async () => {
    for (const code of ["io_error", "permission_denied", "invalid_operation"]) {
      const view = reader({ ok: false, error: { code, message: "broken observer" } });
      await expect(view.text("hidden.md")).rejects.toThrow(
        /manuscript:\/\/hidden.md.*broken observer/,
      );
      await expect(view.idAt("hidden.md")).rejects.toThrow(
        /manuscript:\/\/hidden.md.*broken observer/,
      );
    }
    const absent = reader({ ok: false, error: { code: "not_found", message: "absent" } });
    expect(await absent.text("hidden.md")).toBeNull();
    expect(await absent.idAt("hidden.md")).toBeNull();
  });

  it("a successful stat without a document id is malformed, not absent", async () => {
    await expect(reader({ ok: true, value: {} }).idAt("hidden.md")).rejects.toThrow(
      /manuscript:\/\/hidden.md.*document id/,
    );
  });
});
