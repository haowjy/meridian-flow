// @vitest-environment jsdom
/**
 * Files dropped on a Work upload side by side, their rows outlive the tab that
 * started them, a finished upload keeps its row until the catalog lists it, and
 * an account switch drops every row.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import { uploadIntakePort } from "@/client/api/upload-intake-api";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useWorkFileIntake } from "./use-work-file-intake";

vi.mock("@/client/api/upload-intake-api", () => ({ uploadIntakePort: { intake: vi.fn() } }));
const account = vi.hoisted(() => ({ epoch: new AbortController() }));
vi.mock("../context/account-feature-context", () => ({
  useOptionalAccountEpochSignal: () => account.epoch.signal,
}));
vi.mock("@/client/query/useCreateContextEntry", () => ({
  useCreateContextEntry: () => ({ mutateAsync: vi.fn() }),
}));

function deferred() {
  let resolve!: (value?: { documentId: string }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ documentId: string } | undefined>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type Catalog = { findDocument(documentId: string): unknown } | null;

let intake!: ReturnType<typeof useWorkFileIntake>;
function Probe({ workId, catalog = null }: { workId: string; catalog?: Catalog }) {
  intake = useWorkFileIntake("project-1", workId, catalog);
  return null;
}

const catalogOf = (...documentIds: string[]): Catalog => ({
  findDocument: (documentId) => (documentIds.includes(documentId) ? { documentId } : null),
});

it("sends every file at once, and keeps a refused upload after the tab remounts", async () => {
  const first = deferred();
  const second = deferred();
  vi.mocked(uploadIntakePort.intake)
    .mockImplementationOnce(() => first.promise as never)
    .mockImplementationOnce(() => second.promise as never);
  const client = new QueryClient();
  const tab = (
    <QueryClientProvider client={client}>
      <Probe workId="work-1" />
    </QueryClientProvider>
  );
  let upload!: Promise<unknown>;
  await withReactRoot(
    tab,
    async () => {
      await act(async () => {
        upload = intake.submitFiles([new File(["a"], "a.md"), new File(["b"], "b.md")]);
      });
      expect(uploadIntakePort.intake).toHaveBeenCalledTimes(2);
      expect(intake.uploads.map((item) => [item.name, item.state])).toEqual([
        ["a.md", "pending"],
        ["b.md", "pending"],
      ]);
      await act(async () => {
        second.reject(new Error("Rejected"));
        first.resolve({ documentId: "doc-a" });
        await upload;
      });
      // a.md has landed but the catalog does not list it yet: its row stays.
      expect(intake.uploads.map((item) => [item.name, item.state])).toEqual([
        ["a.md", "pending"],
        ["b.md", "failed"],
      ]);
    },
    { drainMacrotask: true },
  );
  // The Files tab mounts again with a.md listed: its attempt retires, and the
  // refused upload is still there to dismiss.
  await withReactRoot(
    <QueryClientProvider client={client}>
      <Probe workId="work-1" catalog={catalogOf("doc-a")} />
    </QueryClientProvider>,
    async () => {
      expect(intake.uploads.map((item) => item.name)).toEqual(["b.md"]);
      await act(async () => intake.dismissUpload(intake.uploads[0]?.key ?? ""));
      expect(intake.uploads).toEqual([]);
    },
    { drainMacrotask: true },
  );
});

it("retires a finished upload once its catalog lists it", async () => {
  vi.mocked(uploadIntakePort.intake).mockResolvedValueOnce({ documentId: "doc-c" } as never);
  const client = new QueryClient();
  let setCatalog!: (catalog: Catalog) => void;
  function Tab() {
    const [catalog, update] = useState<Catalog>(catalogOf());
    setCatalog = update;
    return <Probe workId="work-2" catalog={catalog} />;
  }
  await withReactRoot(
    <QueryClientProvider client={client}>
      <Tab />
    </QueryClientProvider>,
    async () => {
      await act(async () => {
        await intake.submitFiles([new File(["c"], "c.md")]);
      });
      expect(intake.uploads.map((item) => [item.name, item.state])).toEqual([["c.md", "pending"]]);
      await act(async () => setCatalog(catalogOf("doc-c")));
      expect(intake.uploads).toEqual([]);
      // Retired, not hidden: a later catalog without it does not bring the row back.
      await act(async () => setCatalog(catalogOf()));
      expect(intake.uploads).toEqual([]);
    },
    { drainMacrotask: true },
  );
});

it("drops every attempt when the account ends, and one settling after writes none", async () => {
  const late = deferred();
  vi.mocked(uploadIntakePort.intake)
    .mockRejectedValueOnce(new Error("Rejected"))
    .mockImplementationOnce(() => late.promise as never);
  const client = new QueryClient();
  await withReactRoot(
    <QueryClientProvider client={client}>
      <Probe workId="work-3" />
    </QueryClientProvider>,
    async () => {
      let pending!: Promise<unknown>;
      await act(async () => {
        await intake.submitFiles([new File(["d"], "d.md")]);
        pending = intake.submitFiles([new File(["e"], "e.md")]);
      });
      expect(intake.uploads.map((item) => [item.name, item.state])).toEqual([
        ["d.md", "failed"],
        ["e.md", "pending"],
      ]);
      await act(async () => account.epoch.abort());
      expect(intake.uploads).toEqual([]);
      await act(async () => {
        late.reject(new Error("Aborted"));
        await pending;
      });
      expect(intake.uploads).toEqual([]);
    },
    { drainMacrotask: true },
  );
  account.epoch = new AbortController();
});
