// @vitest-environment jsdom
/** Choose again returns to both ways of choosing, whatever the writer used first. */
import { i18n } from "@lingui/core";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, expect, it } from "vitest";
import { PickZone, useSelectionPicker } from "./SelectionPicker";
import { useSelectionReader } from "./use-selection-reader";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  i18n.loadAndActivate({ locale: "en", messages: {} });
});

/** A picker whose writer already chose two loose files. */
function Picker() {
  const reader = useSelectionReader();
  const picker = useSelectionPicker(reader);
  const { drop } = reader;
  useEffect(() => {
    void drop({ entries: [], files: [new File(["a"], "One.md"), new File(["b"], "Two.md")] });
  }, [drop]);
  return (
    <>
      {picker.inputs}
      {reader.state.status === "ready" ? (
        <button type="button" onClick={picker.chooseAgain}>
          Choose again
        </button>
      ) : (
        <PickZone state={reader.state} picker={picker} />
      )}
    </>
  );
}

it("shows the choices again, focused, instead of reopening one kind of picker", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(<Picker />));
  const again = [...element.querySelectorAll("button")].find(
    (b) => b.textContent === "Choose again",
  );
  expect(again).toBeDefined();

  await act(async () => again?.click());

  const files = [...element.querySelectorAll("button")].find(
    (button) => button.textContent === "Choose files…",
  );
  expect(files).toBeDefined();
  expect(document.activeElement).toBe(element.querySelector("button[data-first]"));
  await act(async () => root.unmount());
  element.remove();
});
