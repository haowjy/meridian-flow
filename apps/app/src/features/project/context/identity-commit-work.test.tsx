// @vitest-environment jsdom
/**
 * Renaming a named Work's Scratch document from the identity bar: the
 * placement carries the Work's slug, so the renamed tab stays that Work's and
 * the namespace has a request to sync.
 */
import {
  planResourceLocation,
  prepareNamespaceAttempt,
  type ResourceDestination,
  type ResourceRecord,
} from "@meridian/resource-replica";
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { projectResourceTab } from "./context-tab-from-file";
import { type IdentityCommitOutcome, useIdentityCommit } from "./use-identity-commit";

const PROJECT = "project";
const ARC = "work-arc";

const { replica, works } = vi.hoisted(() => ({
  replica: { record: null as ResourceRecord | null, setLocation: vi.fn() },
  works: { list: [] as { id: string; slug: string | null }[] },
}));
vi.mock("./account-feature-context", () => ({ useAccountResourceReplica: () => replica }));
vi.mock("@/client/query/useWorks", () => ({ useWorks: () => ({ works: works.list }) }));

/** Arc's `side/note.md`, on the server and open in Arc's Editor. */
function arcNote(): ResourceRecord {
  return {
    resource: {
      handle: "resource",
      revision: 1,
      identity: { documentId: "document", revision: 1 },
      content: { kind: "exact", databaseName: "content", schema: null },
      classification: { editable: true, filetype: "markdown", schemaType: "document" },
      canonical: {
        scheme: "scratch",
        path: "/side/note.md",
        name: "note.md",
        workId: ARC,
        workSlug: "arc",
      },
      lifecycle: { kind: "acknowledged", availabilityGeneration: "1" },
      aliases: {},
      obligations: {},
    },
    intents: [],
  };
}

const tab: ContextTab = {
  kind: "tracked",
  documentId: "document",
  scheme: "scratch",
  path: "/side/note.md",
  name: "note.md",
  workId: ARC,
  resourceHandle: "resource",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
  provisionalName: false,
};

beforeEach(() => {
  works.list = [{ id: ARC, slug: "arc" }];
  replica.record = arcNote();
  replica.setLocation.mockReset();
  // The replica's own plan, so the record is what the real setLocation commits.
  replica.setLocation.mockImplementation(
    async (projectId: string, _key: unknown, destination: ResourceDestination) => {
      const write = planResourceLocation({
        record: replica.record as ResourceRecord,
        projectId,
        intentId: "rename",
        eligibleAt: 1,
        destination,
      });
      if (write) replica.record = write.next;
      return { isLatest: true };
    },
  );
});

async function renameTo(name: string): Promise<IdentityCommitOutcome> {
  let commit!: ReturnType<typeof useIdentityCommit>;
  function Probe() {
    commit = useIdentityCommit({
      projectId: PROJECT,
      tab,
      editorWorkId: ARC,
      onCommitted: () => undefined,
    });
    return null;
  }
  let outcome!: IdentityCommitOutcome;
  await withReactRoot(<Probe />, async () => {
    await act(async () => {
      outcome = await commit({
        destination: { scheme: "scratch", folderPath: "/side", workId: ARC },
        name,
      });
    });
  });
  return outcome;
}

it("places a named Work's Scratch rename with the Work's slug", async () => {
  expect(await renameTo("note2.md")).toEqual({ status: "committed" });
  expect(replica.setLocation).toHaveBeenCalledWith(
    PROJECT,
    { handle: "resource" },
    { scheme: "scratch", folderPath: "/side", name: "note2.md", workId: ARC, workSlug: "arc" },
  );
});

it("keeps the renamed tab in its Work's strip", async () => {
  await renameTo("note2.md");
  const projection = projectResourceTab(PROJECT, tab, [replica.record as ResourceRecord]);
  expect(projection.kind === "projected" && projection.tab).toMatchObject({
    path: "/side/note2.md",
    workId: ARC,
  });
});

it("gives the namespace a request that syncs the rename", async () => {
  await renameTo("note2.md");
  const attempt = prepareNamespaceAttempt(replica.record as ResourceRecord, {
    attemptId: "attempt",
    operationId: "operation",
  });
  expect(attempt?.next.intents.at(-1)?.attempts.at(-1)?.request).toMatchObject({
    kind: "move",
    sourceWorkSlug: "arc",
    destinationWorkSlug: "arc",
    body: { path: "side/note.md", newName: "note2.md", destinationWorkId: ARC },
  });
});

it("fails on the document rather than queue a placement for a Work it cannot name", async () => {
  works.list = [];
  expect(await renameTo("note2.md")).toMatchObject({ status: "error" });
  expect(replica.setLocation).not.toHaveBeenCalled();
});
