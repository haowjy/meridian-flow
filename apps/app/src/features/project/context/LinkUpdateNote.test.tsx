/** Pending operation selection must survive offline time before settlement. */
import type { ContextOperationReceipt } from "@meridian/contracts/protocol";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  movedDestinationName,
  rememberRenameOperation,
  useRenameOperation,
} from "./LinkUpdateNote";

it("keeps a slow move selected when another operation is admitted after eight seconds", async () => {
  vi.useFakeTimers();
  function Selection() {
    return <span>{useRenameOperation("slow-move-document")}</span>;
  }
  try {
    rememberRenameOperation("slow-move-document", "slow-move");
    await withReactRoot(<Selection />, async () => {
      await act(async () => {
        vi.advanceTimersByTime(9_000);
        rememberRenameOperation("other-document", "other-move");
      });
      expect(document.getElementById("root")?.textContent).toBe("slow-move");
    });
  } finally {
    vi.useRealTimers();
  }
});

it("names the receipt's destination without mistaking a rename or refusal for placement", () => {
  const receipt = (sourceUri: string, destinationUri: string, ok = true) =>
    ({
      operationId: "move",
      command: { kind: "move", sourceUri, destinationUri, expected: {} },
      result: ok
        ? { ok: true, value: { destinationPath: "" } }
        : { ok: false, error: { code: "not_found", uri: sourceUri } },
    }) as ContextOperationReceipt;
  expect(movedDestinationName(receipt("manuscript://old.md", "manuscript://Book/Act/ch.md"))).toBe(
    "Act",
  );
  expect(movedDestinationName(receipt("manuscript://Book/ch.md", "kb://note.md"))).toBe(
    "Knowledge Base",
  );
  expect(movedDestinationName(receipt("scratch://@old/ch.md", "scratch://@new/ch.md"))).toBe(
    "Scratch",
  );
  expect(
    movedDestinationName(receipt("manuscript://Book/old.md", "manuscript://Book/new.md")),
  ).toBeNull();
  expect(
    movedDestinationName(receipt("manuscript://old.md", "manuscript://Book/ch.md", false)),
  ).toBeNull();
});
