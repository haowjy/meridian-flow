// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CreationPage } from "./CreationPage";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(onSubmit: () => void) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <CreationPage
        backTo="/"
        backLabel="Back"
        title="New"
        submitLabel="Create"
        onSubmit={onSubmit}
      >
        <label htmlFor="name">Name</label>
        <input id="name" name="creation-name" />
        <label htmlFor="description">Description</label>
        <textarea id="description" />
      </CreationPage>,
    ),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

it("submits on Enter in the name field and Ctrl+Enter in the optional field", () => {
  const onSubmit = vi.fn();
  render(onSubmit);
  const name = container?.querySelector<HTMLInputElement>("input");
  const description = container?.querySelector<HTMLTextAreaElement>("textarea");
  if (!name || !description) throw new Error("Creation fields did not render");
  name.value = "A new arc";
  act(() => name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  act(() =>
    description.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
    ),
  );
  expect(onSubmit).toHaveBeenCalledTimes(2);
});

it("keeps Create available and focuses the name field when validation fails", () => {
  const onSubmit = vi.fn();
  render(onSubmit);
  const button = container?.querySelector<HTMLButtonElement>("button[type=submit]");
  const form = container?.querySelector("form");
  const name = container?.querySelector<HTMLInputElement>("input");
  if (!button || !form || !name) throw new Error("Creation form did not render");
  expect(button.disabled).toBe(false);
  act(() => form.requestSubmit());
  expect(onSubmit).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(name);
  expect(container?.querySelector('[role="alert"]')?.textContent).toContain("Enter a name");
});
