// @vitest-environment jsdom
/** Creation dialog: Create waits for a name; Enter and Ctrl+Enter create. */
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { CreationDialog } from "./CreationDialog";

afterEach(() => vi.restoreAllMocks());

function setValue(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
  setter?.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

function dialog(onCreate: (values: { name: string; details: string }) => void) {
  return (
    <CreationDialog
      title="Create a Work"
      nameLabel="What are you working on?"
      namePlaceholder="Name this Work"
      details={{ label: "What is your goal?", placeholder: "Goals" }}
      submitLabel="Create Work"
      onClose={vi.fn()}
      onCreate={onCreate}
    />
  );
}

it("creates with trimmed values from Enter in the name and Ctrl+Enter in the details field", async () => {
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
      details: "Tighten the midpoint.",
    });
    await act(async () => {
      details.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
    });
    expect(onCreate).toHaveBeenCalledTimes(2);
  });
});
