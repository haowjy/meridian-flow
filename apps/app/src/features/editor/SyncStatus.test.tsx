/** SyncStatus renders exactly one label, with terminal session states winning over offline or stalled adoption. */
import { act } from "react";
import { expect, it } from "vitest";

import { DocumentSession } from "@/core/editor/document-session";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { SyncStatus } from "./SyncStatus";

it("shows only 'Closed' for a session destroyed after an adoption failure", async () => {
  const session = new DocumentSession({
    roomKey: "doc-sync-status",
    persistence: { kind: "none" },
  });
  session.reportAdoptionStalled(true);

  await withReactRoot(<SyncStatus session={session} />, async () => {
    expect(document.body.textContent).toBe("Saved locally (offline)");
    await act(async () => {
      await session.destroy();
    });
    expect(document.body.textContent).toBe("Closed");
  });
});
