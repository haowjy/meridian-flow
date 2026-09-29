// @vitest-environment jsdom
/** Files dropped on a Work upload side by side, and their rows outlive the tab that started them. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { uploadIntakePort } from "@/client/api/upload-intake-api";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useWorkFileIntake } from "./use-work-file-intake";

vi.mock("@/client/api/upload-intake-api", () => ({ uploadIntakePort: { intake: vi.fn() } }));
vi.mock("@/client/query/useCreateContextEntry", () => ({
  useCreateContextEntry: () => ({ mutateAsync: vi.fn() }),
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let intake!: ReturnType<typeof useWorkFileIntake>;
function Probe({ workId }: { workId: string }) {
  intake = useWorkFileIntake("project-1", workId);
  return null;
}

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
        first.resolve();
        await upload;
      });
      expect(intake.uploads.map((item) => [item.name, item.state])).toEqual([["b.md", "failed"]]);
    },
    { drainMacrotask: true },
  );
  // The Files tab mounts again: the refused upload is still there to dismiss.
  await withReactRoot(
    tab,
    async () => {
      expect(intake.uploads.map((item) => item.name)).toEqual(["b.md"]);
      await act(async () => intake.dismissUpload(intake.uploads[0]?.key ?? ""));
      expect(intake.uploads).toEqual([]);
    },
    { drainMacrotask: true },
  );
});
