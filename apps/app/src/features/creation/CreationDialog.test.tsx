// @vitest-environment jsdom
/** Creation dialog: Create waits for a name; Enter and Ctrl+Enter create. */
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { CreationDialog } from "./CreationDialog";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));

afterEach(() => vi.restoreAllMocks());

function setValue(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
  setter?.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

function dialog(onCreate: (values: { name: string; description: string }) => void) {
  return (
    <CreationDialog
      title="Create a Work"
      nameLabel="What are you working on?"
      namePlaceholder="Name this Work"
      description={{ label: "What should the AI know?", placeholder: "Goals" }}
      submitLabel="Create Work"
      onClose={vi.fn()}
      onCreate={onCreate}
    />
  );
}

it("keeps Create disabled until the name has text", async () => {
  const onCreate = vi.fn();
  await withReactRoot(dialog(onCreate), async () => {
    const submit = document.querySelector<HTMLButtonElement>("button[type=submit]");
    expect(submit?.disabled).toBe(true);
    const name = document.querySelector<HTMLInputElement>("input");
    if (!name) throw new Error("Name field did not render");
    await act(async () => setValue(name, "   "));
    expect(submit?.disabled).toBe(true);
    await act(async () => setValue(name, "Arc three"));
    expect(submit?.disabled).toBe(false);
  });
});

it("creates with trimmed values from Enter in the name and Ctrl+Enter in the description", async () => {
  const onCreate = vi.fn();
  await withReactRoot(dialog(onCreate), async () => {
    const name = document.querySelector<HTMLInputElement>("input");
    const details = document.querySelector<HTMLTextAreaElement>("textarea");
    const form = document.querySelector("form");
    if (!name || !details || !form) throw new Error("Creation form did not render");
    await act(async () => {
      setValue(name, " Arc three ");
      setValue(details, " Tighten the midpoint. ");
    });
    await act(async () => form.requestSubmit());
    expect(onCreate).toHaveBeenLastCalledWith({
      name: "Arc three",
      description: "Tighten the midpoint.",
    });
    await act(async () => {
      details.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
    });
    expect(onCreate).toHaveBeenCalledTimes(2);
  });
});
