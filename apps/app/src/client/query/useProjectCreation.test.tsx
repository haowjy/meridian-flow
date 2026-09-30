// @vitest-environment jsdom
/** Project creation navigates before persistence settles and retries the same identity. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  creationRecordKey,
  creationRegistry,
  readCreationRecord,
  scopeCreationRegistry,
} from "@/client/creation/creation-registry";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useCreateProject, useProjectCreationState } from "./useProjectCreation";

const ACCOUNT_ID = "writer-1";

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  getProject: vi.fn(),
  navigate: vi.fn(() => Promise.resolve()),
  invalidate: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/client/api/projects-api", () => ({
  createProject: mocks.createProject,
  getProject: mocks.getProject,
}));
vi.mock("@/client/stores", () => ({ useProjectActions: () => ({ ensureProject: vi.fn() }) }));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountId: () => ACCOUNT_ID,
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: mocks.navigate, invalidate: mocks.invalidate }),
}));

const account = new AbortController();
let create!: (input: { title: string }) => string;
let retry!: () => void;
let status = "";

function Creator() {
  create = useCreateProject(ACCOUNT_ID, account.signal).create;
  return null;
}

function Destination({ projectId }: { projectId: string }) {
  const state = useProjectCreationState(projectId, account.signal);
  retry = state.retry;
  status = state.status;
  return null;
}

function flush() {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  creationRegistry.setState({ accountId: null, records: {} });
  scopeCreationRegistry(ACCOUNT_ID);
});

describe("project creation", () => {
  it("navigates to the new project's chats before persistence settles", async () => {
    mocks.createProject.mockReturnValue(new Promise(() => undefined));
    await withReactRoot(
      <QueryClientProvider client={new QueryClient()}>
        <Creator />
      </QueryClientProvider>,
      async () => {
        let projectId = "";
        await act(async () => {
          projectId = create({ title: "  Fast project " });
        });
        expect(mocks.navigate).toHaveBeenCalledWith(
          expect.objectContaining({ params: { projectId, _splat: "chats" } }),
        );
        expect(mocks.navigate.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.createProject.mock.invocationCallOrder[0] ?? 0,
        );
        expect(mocks.createProject).toHaveBeenCalledWith(
          { id: projectId, title: "Fast project" },
          expect.anything(),
        );
        expect(readCreationRecord(creationRecordKey("project", projectId))?.status).toBe("pending");
      },
      { drainMacrotask: true },
    );
  });

  it("retries a failed creation with the same identity and title", async () => {
    const failure = new Error("offline");
    mocks.createProject.mockRejectedValueOnce(failure);
    mocks.getProject.mockRejectedValueOnce(failure);
    const client = new QueryClient();
    let projectId = "";
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Creator />
      </QueryClientProvider>,
      async () => {
        await act(async () => {
          projectId = create({ title: "Fast project" });
        });
        await flush();
      },
      { drainMacrotask: true },
    );
    expect(readCreationRecord(creationRecordKey("project", projectId))?.status).toBe("failed");

    mocks.createProject.mockResolvedValueOnce({ id: projectId, userId: ACCOUNT_ID });
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Destination projectId={projectId} />
      </QueryClientProvider>,
      async () => {
        expect(status).toBe("failed");
        await act(async () => retry());
        await flush();
        expect(mocks.createProject).toHaveBeenLastCalledWith(
          { id: projectId, title: "Fast project" },
          expect.anything(),
        );
        expect(mocks.invalidate).toHaveBeenCalled();
        expect(status).toBe("none");
      },
      { drainMacrotask: true },
    );
  });
});
