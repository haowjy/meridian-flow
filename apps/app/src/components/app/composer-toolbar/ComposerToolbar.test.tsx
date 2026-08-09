// @vitest-environment jsdom
/** React/Radix contract tests for the reducer-owned composer toolbar surface. */
import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerCurrentValueTrigger } from "./ComposerCurrentValueTrigger";
import { ComposerToolbar } from "./ComposerToolbar";
import type { ComposerToolbarLayout } from "./composer-toolbar-layout";
import type {
  ComposerToolbarControl,
  ComposerToolbarInlineContext,
  ComposerToolbarPanelContext,
} from "./types";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

let measuredLayout: ComposerToolbarLayout;
vi.mock("./useMeasuredComposerToolbar", async () => {
  const { useLayoutEffect, useRef } = await import("react");
  return {
    useMeasuredComposerToolbar: (
      controls: readonly ComposerToolbarControl[],
      onLayout: (layout: ComposerToolbarLayout) => void,
    ) => {
      const root = useRef<HTMLFieldSetElement | null>(null);
      const probe = useRef<HTMLButtonElement | null>(null);
      useLayoutEffect(() => onLayout(measuredLayout), [controls, onLayout]);
      return { root, probe, controlRef: () => () => {} };
    },
  };
});

type ControlHarness = ComposerToolbarControl & {
  initial: React.RefObject<HTMLElement | null>;
};
const panelControl = (
  id: string,
  label: string,
  size: "compact" | "identity" | "catalog" = "compact",
): ControlHarness => {
  const initial = createRef<HTMLButtonElement>();
  const inline = ({ triggerRef, activate }: ComposerToolbarInlineContext) => (
    <button ref={triggerRef} type="button" aria-label={label} onClick={activate}>
      {label}
    </button>
  );
  const render = (context: ComposerToolbarPanelContext) => (
    <div>
      <button ref={initial} type="button">
        {label} initial
      </button>
      <button type="button" onClick={() => context.beginBlocking()}>
        Lock {label}
      </button>
      <button type="button" onClick={context.terminalClose}>
        Finish {label}
      </button>
    </div>
  );
  return {
    id,
    priority: 1,
    initial,
    inline,
    overflow: {
      kind: "panel",
      item: { ariaLabel: label, label },
      panel: { ariaLabel: `${label} panel`, size, initialFocusRef: initial, render },
    },
  };
};
const writeModeControl = (): ControlHarness => {
  const initial = createRef<HTMLInputElement>();
  const render = () => (
    <div role="radiogroup" aria-label="AI write mode choices">
      <label>
        <input type="radio" name="mode" /> Draft
      </label>
      <label>
        <input ref={initial} type="radio" name="mode" defaultChecked /> Auto-apply
      </label>
    </div>
  );
  return {
    id: "write-mode",
    priority: 2,
    initial,
    inline: ({ triggerRef, activate, active, locked }) => (
      <ComposerCurrentValueTrigger
        ref={triggerRef}
        ariaLabel="AI write mode: Auto-apply"
        active={active}
        readOnly={locked}
        onActivate={activate}
      >
        Auto-apply
      </ComposerCurrentValueTrigger>
    ),
    overflow: {
      kind: "panel",
      item: { ariaLabel: "AI write mode", label: "Write mode", value: "Auto-apply" },
      panel: {
        ariaLabel: "AI write mode panel",
        size: "compact",
        initialFocusRef: initial,
        render,
      },
    },
  };
};
const statusControl = (): ComposerToolbarControl => ({
  id: "readonly",
  priority: 0,
  inline: () => <span>Readonly</span>,
  overflow: {
    kind: "status",
    item: { ariaLabel: "Readonly status", label: "Agent", value: "Readonly" },
  },
});
const layout = (controls: readonly ComposerToolbarControl[], inlineIds: string[]) => ({
  inlineIds,
  overflowIds: controls.map((control) => control.id).filter((id) => !inlineIds.includes(id)),
  constrained: inlineIds.length !== controls.length,
});

let root: Root;
let host: HTMLDivElement;
let controls: ComposerToolbarControl[];
const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});
beforeEach(async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const renderToolbar = async (nextControls = controls) => {
  controls = nextControls;
  await act(async () => {
    root.render(<ComposerToolbar controls={nextControls} ariaLabel="Composer options" />);
  });
};
const button = (name: string) => {
  const found = [...document.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === name || node.textContent?.trim() === name,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing button: ${name}`);
  return found;
};
const press = async (node: HTMLElement) => {
  await act(async () => {
    node.focus();
    node.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    node.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true }));
    node.click();
  });
};
const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
const pressEscape = async () => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
};
const settleRadixFocus = async () => {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

describe("ComposerToolbar Radix navigation", () => {
  it("keeps root, compact, and catalog navigation on their semantic pages", async () => {
    const compact = panelControl("compact", "Compact");
    const catalog = panelControl("catalog", "Catalog", "catalog");
    controls = [compact, catalog];
    measuredLayout = layout(controls, []);
    await renderToolbar();

    await press(button("More composer controls"));
    expect(dialogs()[0]?.getAttribute("data-page")).toBe("root");
    await press(button("Compact"));
    expect(dialogs()[0]?.getAttribute("aria-label")).toBe("Compact panel");
    await press(button("Back"));
    expect(dialogs()[0]?.getAttribute("data-page")).toBe("root");
    await press(button("Catalog"));
    expect(dialogs()[0]?.getAttribute("aria-label")).toBe("Catalog panel");
  });

  it("toggles a direct panel with focus return and refuses the same click when locked", async () => {
    const agent = panelControl("agent", "Agent");
    controls = [agent];
    measuredLayout = layout(controls, ["agent"]);
    await renderToolbar();

    await press(button("Agent"));
    expect(dialogs()).toHaveLength(1);
    expect(document.activeElement).toBe(agent.initial.current);
    await press(button("Agent"));
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(button("Agent"));

    await press(button("Agent"));
    await press(button("Lock Agent"));
    await press(button("Agent"));
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0]?.getAttribute("aria-label")).toBe("Agent panel");
  });

  it("pointer-switches A to B with one B dialog immediately and after Presence time", async () => {
    const agent = panelControl("agent", "Agent");
    const work = panelControl("work", "Work");
    controls = [agent, work];
    measuredLayout = layout(controls, ["agent", "work"]);
    await renderToolbar();
    await press(button("Agent"));
    await press(button("Work"));
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0]?.getAttribute("aria-label")).toBe("Work panel");
    expect(document.body.textContent).not.toContain("Agent initial");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0]?.getAttribute("aria-label")).toBe("Work panel");
  });

  it.each([
    ["inline", true],
    ["overflow", false],
  ] as const)("focuses the checked enabled write-mode radio from %s", async (_host, inline) => {
    const mode = writeModeControl();
    controls = [mode];
    measuredLayout = layout(controls, inline ? [mode.id] : []);
    await renderToolbar();
    if (!inline) await press(button("More composer controls"));
    await press(button(inline ? "AI write mode: Auto-apply" : "AI write mode"));
    expect(document.activeElement).toBe(mode.initial.current);
    expect(mode.initial.current).toBeInstanceOf(HTMLInputElement);
    expect((mode.initial.current as HTMLInputElement | null)?.checked).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("Back restores the exact root row and terminal close focuses the whole-surface trigger", async () => {
    const agent = panelControl("agent", "Agent");
    const work = panelControl("work", "Work");
    controls = [agent, work];
    measuredLayout = layout(controls, []);
    await renderToolbar();
    const ellipsis = button("More composer controls");
    await press(ellipsis);
    await press(button("Work"));
    await press(button("Back"));
    expect(document.activeElement).toBe(dialogs()[0]?.querySelector('[aria-label="Work"]'));
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0]?.getAttribute("data-page")).toBe("root");

    await press(button("Work"));
    await press(button("Finish Work"));
    await settleRadixFocus();
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(ellipsis);
  });

  it("refuses locked Escape and outside pointer, then accepts terminal close", async () => {
    const agent = panelControl("agent", "Agent");
    controls = [agent];
    measuredLayout = layout(controls, ["agent"]);
    await renderToolbar();
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(outside);
    await press(button("Agent"));
    await press(button("Lock Agent"));
    agent.initial.current?.focus();
    await pressEscape();
    expect(dialogs()).toHaveLength(1);
    expect(document.activeElement).toBe(agent.initial.current);
    await act(async () => {
      outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    });
    expect(dialogs()).toHaveLength(1);
    expect(document.activeElement).toBe(agent.initial.current);
    await press(button("Finish Agent"));
    expect(dialogs()).toHaveLength(0);
  });

  it("atomically migrates direct to overflow and back with one surface and panel focus", async () => {
    const agent = panelControl("agent", "Agent");
    const work = panelControl("work", "Work");
    controls = [agent, work];
    measuredLayout = layout(controls, ["agent", "work"]);
    await renderToolbar();
    await press(button("Agent"));

    measuredLayout = layout(controls, []);
    await renderToolbar([...controls]);
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0]?.getAttribute("aria-label")).toBe("Agent panel");
    expect(document.activeElement).toBe(agent.initial.current);

    measuredLayout = layout(controls, ["agent", "work"]);
    await renderToolbar([...controls]);
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0]?.getAttribute("aria-label")).toBe("Agent panel");
    expect(document.activeElement).toBe(agent.initial.current);
  });

  it.each([
    ["overflow remaining", ["agent"]],
    ["no overflow", ["agent", "work"]],
  ] as const)("focuses a promoted root row with %s", async (_name, promotedInline) => {
    const agent = panelControl("agent", "Agent");
    const work = panelControl("work", "Work");
    controls = [agent, work];
    measuredLayout = layout(controls, []);
    await renderToolbar();
    await press(button("More composer controls"));
    const rootRow = dialogs()[0]?.querySelector('[aria-label="Agent"]');
    if (!(rootRow instanceof HTMLButtonElement)) throw new Error("missing Agent root row");
    await act(async () => rootRow.focus());

    measuredLayout = layout(controls, [...promotedInline]);
    await renderToolbar([...controls]);
    await settleRadixFocus();
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(button("Agent"));
  });

  it("opens a status-only overflow instead of rendering a dead ellipsis", async () => {
    controls = [statusControl()];
    measuredLayout = layout(controls, []);
    await renderToolbar();
    await press(button("More composer controls"));
    expect(dialogs()).toHaveLength(1);
    expect(document.body.textContent).toContain("Readonly");
  });
});
