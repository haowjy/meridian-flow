// @vitest-environment jsdom
/**
 * A refused title rename reopens the field, and committing it again retries;
 * only the latest rename of a title reopens, and never by taking focus away.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TitleEditSlot } from "./TitleEditSlot";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const field = () => host.querySelector("input");

function type(value: string) {
  const input = field() as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string) {
  await act(async () => {
    field()?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function Slot({
  titleKey = "work:1",
  rename,
  children = "Arc 3",
}: {
  titleKey?: string;
  rename: (title: string) => Promise<unknown>;
  children?: ReactNode;
}) {
  return (
    <TitleEditSlot titleKey={titleKey} label="Rename" failure="Couldn’t rename." rename={rename}>
      {({ start, triggerRef }) => (
        <button ref={triggerRef} type="button" onClick={() => start("Arc 3")}>
          {children}
        </button>
      )}
    </TitleEditSlot>
  );
}

/** Renames that settle when the test says so, in any order. */
function deferredRenames() {
  const calls: { title: string; refuse: () => void }[] = [];
  const rename = vi.fn(
    (title: string) =>
      new Promise<unknown>((_, reject) => {
        calls.push({ title, refuse: () => reject(new Error("refused")) });
      }),
  );
  const refuse = async (title: string) => {
    await act(async () => calls.find((call) => call.title === title)?.refuse());
  };
  return { rename, refuse };
}

async function renameTo(title: string, trigger = host.querySelector("button")) {
  act(() => trigger?.click());
  type(title);
  await press("Enter");
}

it("reopens a refused rename with the writer's text, and Enter retries it", async () => {
  const rename = vi
    .fn<(title: string) => Promise<unknown>>()
    .mockRejectedValueOnce(new Error("refused"))
    .mockResolvedValueOnce(undefined);
  act(() => root.render(<Slot titleKey="work:retry" rename={rename} />));
  act(() => host.querySelector("button")?.click());
  type("Arc 4");
  await press("Enter");

  expect(rename).toHaveBeenCalledWith("Arc 4");
  expect(field()?.value).toBe("Arc 4");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t rename.");
  expect(field()?.getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(field());

  await press("Enter");
  expect(rename).toHaveBeenCalledTimes(2);
  expect(field()).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("keeps a newer rename when an older one is refused, and reopens only for the newer one", async () => {
  const { rename, refuse } = deferredRenames();
  act(() => root.render(<Slot rename={rename} />));
  await renameTo("A");
  await renameTo("B");

  await refuse("A");
  expect(field()).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();

  await refuse("B");
  expect(field()?.value).toBe("B");
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});

it("lets a rename from another slot of the same title supersede this one", async () => {
  const { rename, refuse } = deferredRenames();
  act(() =>
    root.render(
      <>
        <Slot titleKey="work:2" rename={rename}>
          Tab
        </Slot>
        <Slot titleKey="work:2" rename={rename}>
          Heading
        </Slot>
      </>,
    ),
  );
  const [tab, heading] = host.querySelectorAll("button");
  await renameTo("A", tab);
  await renameTo("B", heading);

  await refuse("A");
  expect(field()).toBeNull();
});

it("shows a refusal without taking focus from where the writer moved on", async () => {
  const { rename, refuse } = deferredRenames();
  const manuscript = document.createElement("textarea");
  document.body.append(manuscript);
  act(() => root.render(<Slot titleKey="project:1" rename={rename} />));
  await renameTo("A");
  manuscript.focus();

  await refuse("A");
  expect(field()?.value).toBe("A");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t rename.");
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(document.activeElement).toBe(manuscript);
  manuscript.remove();
});
