/** Journal overlap rules depend on sequence and identity, not array order or placement kind. */
import { expect, it } from "vitest";
import { resolveRefusedLocationChain } from "./namespace-journal-policy";
import type { NamespaceIntent } from "./resource-records";

it.each([
  "set-location",
  "set-folder-location",
] as const)("resolves all move/rename/delete orderings for %s after refusal", (kind) => {
  const orders = [
    ["move", "rename", "delete"],
    ["move", "delete", "rename"],
    ["rename", "move", "delete"],
    ["rename", "delete", "move"],
    ["delete", "move", "rename"],
    ["delete", "rename", "move"],
  ];
  for (const order of orders) {
    for (const deleteState of [
      "pending",
      "submitted",
      "received",
      "settled",
      "needs-repair",
      "superseded",
    ] as const) {
      for (const identityRevision of [1, 2]) {
        const intents: NamespaceIntent[] = order.map((id, index) => ({
          projectId: "project",
          handle: "identity",
          intentId: id,
          sequence: index + 1,
          identityRevision: id === "delete" ? identityRevision : 1,
          desired:
            id === "delete"
              ? { kind: "delete" }
              : {
                  kind,
                  destination: {
                    parent: { kind: "root", scheme: "manuscript", owner: { workId: null } },
                    name: id,
                  },
                },
          state: id === "move" ? "needs-repair" : id === "delete" ? deleteState : "pending",
          attempts: [],
        }));
        const failed = intents.find((i) => i.intentId === "move");
        const deletion = intents.find((i) => i.intentId === "delete");
        if (!failed || !deletion) throw new Error("Missing fixture intent");
        const before = structuredClone(intents);
        const result = resolveRefusedLocationChain([...intents].reverse(), failed);
        const superseded =
          deletion.sequence > failed.sequence &&
          identityRevision === 1 &&
          ["pending", "submitted", "received", "settled"].includes(deleteState);
        expect(result.find((i) => i.intentId === "move")?.state).toBe(
          superseded ? "superseded" : "needs-repair",
        );
        expect(result.find((i) => i.intentId === "delete")).toEqual(deletion);
        for (const intent of result) {
          expect(intent.desired).toEqual(
            before.find((i) => i.intentId === intent.intentId)?.desired,
          );
          if (intent.intentId === "rename")
            expect(intent.state).toBe(intent.sequence > failed.sequence ? "cancelled" : "pending");
        }
        expect(intents).toEqual(before);
        expect(resolveRefusedLocationChain(result, failed)).toEqual(result);
      }
    }
  }
});
