// @vitest-environment jsdom
/** Inline naming admits at most one commit until the active submission settles. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useInlineNameForm } from "./use-inline-name-form";

it("coalesces Enter and blur while an async submission is pending", async () => {
  let settle!: () => void;
  const onSubmit = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
  );
  const onDone = vi.fn();
  const host = document.createElement("div");
  const root = createRoot(host);
  function Harness() {
    const form = useInlineNameForm({
      initialName: "Chapter.md",
      siblingNames: [],
      isPending: false,
      onSubmit,
      onDone,
    });
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
  if (!input) throw new Error("Expected inline name input");
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.blur();
  });
  expect(onSubmit).toHaveBeenCalledTimes(1);

  await act(async () => settle());
  expect(onDone).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});
