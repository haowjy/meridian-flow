// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  creationRecordKey,
  creationRegistry,
  removeCreationRecord,
  scopeCreationRegistry,
  writeCreationRecord,
} from "@/client/creation/creation-registry";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useIsProjectPendingCreation } from "./useProjectCreation";

const PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000";
const ACCOUNT_ID = "writer-1";

function PendingProbe({ projectId }: { projectId: string }) {
  return <output>{String(useIsProjectPendingCreation(projectId))}</output>;
}

describe("useIsProjectPendingCreation", () => {
  beforeEach(() => {
    creationRegistry.setState({ accountId: null, records: {} });
    scopeCreationRegistry(ACCOUNT_ID);
  });

  it("tracks only unresolved project records in the active account", async () => {
    await withReactRoot(<PendingProbe projectId={PROJECT_ID} />, async () => {
      const output = document.querySelector("output");
      expect(output?.textContent).toBe("false");

      await act(async () => {
        writeCreationRecord("writer-1", {
          key: creationRecordKey("project", PROJECT_ID),
          payload: { id: PROJECT_ID, title: "New project", userId: "writer-1" },
          result: null,
          status: "pending",
          error: null,
        });
      });
      expect(output?.textContent).toBe("true");

      await act(async () => {
        writeCreationRecord("writer-1", {
          key: creationRecordKey("project", PROJECT_ID),
          payload: { id: PROJECT_ID, title: "New project", userId: "writer-1" },
          result: null,
          status: "confirmed",
          error: null,
        });
      });
      expect(output?.textContent).toBe("false");

      await act(async () => {
        removeCreationRecord(creationRecordKey("project", PROJECT_ID), "writer-1");
        scopeCreationRegistry("writer-2");
      });
      expect(output?.textContent).toBe("false");
    });
  });
});
