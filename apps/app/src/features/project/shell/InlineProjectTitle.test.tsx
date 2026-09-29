// @vitest-environment jsdom
/** The project title renames like a Work title: it closes at once, and a refusal reopens it. */
import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { InlineProjectTitle } from "./InlineProjectTitle";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
}));

function setValue(node: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
  setter?.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

let refuse!: (error: Error) => void;
/** Stands in for the rename mutation: the title changes at once and rolls back on refusal. */
function Harness() {
  const [title, setTitle] = useState("Old serial");
  return (
    <InlineProjectTitle
      projectId="project-1"
      title={title}
      onSave={(next) => {
        setTitle(next);
        return new Promise((_, reject) => {
          refuse = (error) => {
            setTitle("Old serial");
            reject(error);
          };
        });
      }}
    />
  );
}

it("closes on commit with the new title, and reopens with the writer's text when refused", async () => {
  await withReactRoot(<Harness />, async () => {
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Rename project: Old serial"]')
        ?.click(),
    );
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Project title"]');
    if (!input) throw new Error("Project title field did not open");
    await act(async () => {
      setValue(input, "New serial");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(document.querySelector("input")).toBeNull();
    expect(document.querySelector('[aria-label="Rename project: New serial"]')).not.toBeNull();

    await act(async () => refuse(new Error("Rejected")));
    const reopened = document.querySelector<HTMLInputElement>('input[aria-label="Project title"]');
    expect(reopened?.value).toBe("New serial");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Project title could not be saved. Try again.",
    );
    expect(reopened?.getAttribute("aria-describedby")).toBe(
      document.querySelector('[role="alert"]')?.id,
    );
  });
});
