// @vitest-environment jsdom
/** Tree file creation selects one durable resource or direct-server command boundary. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { useCreateEntryForm } from "./use-create-entry-form";

vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  reserveDocument: vi.fn(),
  setLocation: vi.fn(),
  mutateAsync: vi.fn(),
}));
vi.mock("./account-feature-context", () => ({
  useAccountResourceReplica: () => ({
    reserveDocument: mocks.reserveDocument,
    setLocation: mocks.setLocation,
  }),
}));
vi.mock("@/client/query/useCreateContextEntry", () => ({
  useCreateContextEntry: () => ({ isPending: false, mutateAsync: mocks.mutateAsync }),
}));

beforeEach(() => {
  mocks.reserveDocument.mockReset();
  mocks.setLocation.mockReset();
  mocks.mutateAsync.mockReset();
});

async function renderForm(onDone = vi.fn()) {
  const host = document.createElement("div");
  const root = createRoot(host);
  let severity: ReturnType<typeof useCreateEntryForm>["severity"] = null;
  function Harness() {
    const form = useCreateEntryForm({
      projectId: "project",
      workId: null,
      scheme: "kb",
      kind: "file",
      parent: "chapters",
      onDone,
    });
    severity = form.severity;
    return (
      <input
        ref={form.inputRef}
        value={form.name}
        onChange={form.onChange}
        onKeyDown={form.onKeyDown}
        onBlur={form.onBlur}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  const input = host.querySelector("input");
  if (!input) throw new Error("Expected create input");
  return {
    input,
    onDone,
    severity: () => severity,
    close: () => act(async () => root.unmount()),
  };
}

async function submit(input: HTMLInputElement, name: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

it("reserves, files, and releases a Markdown document through the resource replica", async () => {
  const release = vi.fn();
  mocks.reserveDocument.mockResolvedValue({
    key: { handle: "resource" },
    name: "Untitled",
    content: { kind: "opened", handle: { release } },
  });
  mocks.setLocation.mockResolvedValue({ isLatest: true });
  const form = await renderForm();

  await submit(form.input, "Opening.md");

  expect(mocks.reserveDocument).toHaveBeenCalledWith("project", "chapters");
  expect(mocks.setLocation).toHaveBeenCalledWith(
    "project",
    { handle: "resource" },
    {
      scheme: "kb",
      folderPath: "chapters",
      name: "Opening.md",
      workId: null,
    },
  );
  expect(release).toHaveBeenCalledOnce();
  expect(mocks.mutateAsync).not.toHaveBeenCalled();
  expect(form.onDone).toHaveBeenCalledOnce();
  await form.close();
});

it("releases prepared content and keeps the form open when filing fails", async () => {
  const release = vi.fn();
  mocks.reserveDocument.mockResolvedValue({
    key: { handle: "resource" },
    name: "Untitled",
    content: { kind: "opened", handle: { release } },
  });
  mocks.setLocation.mockRejectedValue(new Error("Name is already used"));
  const form = await renderForm();

  await submit(form.input, "Taken.md");

  expect(release).toHaveBeenCalledOnce();
  expect(form.onDone).not.toHaveBeenCalled();
  expect(form.severity()).toEqual({ level: "error", message: "Name is already used" });
  await form.close();
});

it("keeps non-document files on the direct server mutation path", async () => {
  mocks.mutateAsync.mockResolvedValue({});
  const form = await renderForm();

  await submit(form.input, "cover.png");

  expect(mocks.reserveDocument).not.toHaveBeenCalled();
  expect(mocks.mutateAsync).toHaveBeenCalledWith({
    scheme: "kb",
    type: "file",
    path: "chapters/cover.png",
    workId: null,
  });
  expect(form.onDone).toHaveBeenCalledOnce();
  await form.close();
});
