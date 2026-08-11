// @vitest-environment jsdom
/** React/Radix contract tests for toolbar ownership, focus, and topology. */
import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerToolbar } from "./ComposerToolbar";
import type { ComposerToolbarLayout } from "./composer-toolbar-layout";
import type { ComposerToolbarControl, ComposerToolbarPanelContext } from "./types";
import { createComposerToolbarModel } from "./types";

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
      controls: readonly { id: string; priority: number }[],
      onLayout: (layout: ComposerToolbarLayout) => void,
    ) => {
      const root = useRef<HTMLFieldSetElement | null>(null);
      const probe = useRef<HTMLButtonElement | null>(null);
      useLayoutEffect(() => onLayout(measuredLayout), [controls, onLayout]);
      return { root, probe, controlRef: () => () => {} };
    },
  };
});

type PanelHarness = Extract<ComposerToolbarControl, { kind: "panel" }> & {
  primary: React.RefObject<HTMLButtonElement | null>;
  secondary: React.RefObject<HTMLButtonElement | null>;
};
let settleBlocking: ((outcome: "close" | "stay") => void) | null = null;
const panelControl = (
  id: string,
  options: {
    interaction?: "enabled" | "busy";
    pageId?: string;
    repair?: string;
    primaryDisabled?: boolean;
    showPrimary?: boolean;
  } = {},
): PanelHarness => {
  const primary = createRef<HTMLButtonElement>();
  const secondary = createRef<HTMLButtonElement>();
  const showPrimary = options.showPrimary ?? true;
  const render = (context: ComposerToolbarPanelContext) => (
    <div>
      {showPrimary ? (
        <button ref={primary} type="button" disabled={options.primaryDisabled}>
          {id} primary
        </button>
      ) : null}
      <button ref={secondary} type="button">
        {id} secondary
      </button>
      <button
        type="button"
        onClick={() => {
          const result = context.beginBlocking();
          if (result.kind === "started") settleBlocking = result.settle;
        }}
      >
        Lock {id}
      </button>
      <button type="button" onClick={context.terminalClose}>
        Finish {id}
      </button>
    </div>
  );
  return {
    kind: "panel",
    id,
    priority: 1,
    interaction: options.interaction ?? "enabled",
    item: { ariaLabel: id, label: id },
    primary,
    secondary,
    inline: ({ trigger }) => (
      <button ref={trigger.ref} {...trigger.buttonProps} type="button" aria-label={id}>
        {id}
      </button>
    ),
    panel: {
      ariaLabel: `${id} panel`,
      size: "compact",
      focus: {
        pageId: options.pageId ?? "ready",
        repairRevision: options.repair ?? "rows",
        candidates: [
          { key: "primary", ref: primary },
          { key: "secondary", ref: secondary },
        ],
        fallback: "content",
      },
      render,
    },
  };
};
const statusControl = (id = "agent"): ComposerToolbarControl => ({
  kind: "status",
  id,
  priority: 1,
  item: { ariaLabel: `${id} status`, label: id, value: "readonly" },
  inline: ({ controlRef }) => (
    <button ref={controlRef} type="button" aria-label={`${id} status`}>
      {id}
    </button>
  ),
});
const layout = (controls: readonly ComposerToolbarControl[], inlineIds: string[]) => ({
  inlineIds,
  overflowIds: controls.map(({ id }) => id).filter((id) => !inlineIds.includes(id)),
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
beforeEach(() => {
  settleBlocking = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});
const renderToolbar = async (next = controls) => {
  controls = next;
  await act(async () =>
    root.render(<ComposerToolbar model={createComposerToolbarModel(next)} ariaLabel="Options" />),
  );
};
const button = (name: string) => {
  const node = [...document.querySelectorAll("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
  );
  if (!(node instanceof HTMLButtonElement)) throw new Error(`missing ${name}`);
  return node;
};
const press = async (node: HTMLElement) => {
  await act(async () => {
    node.focus();
    node.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    node.click();
  });
};
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

describe("ComposerToolbar visible ownership", () => {
  it("uses one stable mounted content ID and exposes it only from the visible owner", async () => {
    const agent = panelControl("agent");
    controls = [agent];
    measuredLayout = layout(controls, ["agent"]);
    await renderToolbar();
    const trigger = button("agent");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.hasAttribute("aria-controls")).toBe(false);
    await press(trigger);
    const id = dialog()?.id;
    expect(id).toBeTruthy();
    expect(trigger.getAttribute("aria-controls")).toBe(id);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await press(trigger);
    expect(trigger.hasAttribute("aria-controls")).toBe(false);
    await press(trigger);
    expect(dialog()?.id).toBe(id);
  });

  it("keeps expanded ownership and refusal truth while locked without native disabling", async () => {
    const agent = panelControl("agent");
    controls = [agent];
    measuredLayout = layout(controls, ["agent"]);
    await renderToolbar();
    await press(button("agent"));
    await press(button("Lock agent"));
    const trigger = button("agent");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(trigger.disabled).toBe(false);
    await press(trigger);
    expect(dialog()).not.toBeNull();
  });

  it("keeps one content and its inline host until a locked width change settles", async () => {
    const work = panelControl("work");
    controls = [work];
    measuredLayout = layout(controls, ["work"]);
    await renderToolbar();
    await press(button("work"));
    await press(button("Lock work"));
    work.primary.current?.focus();
    const focused = document.activeElement;

    work.priority = 2;
    measuredLayout = layout(controls, []);
    await renderToolbar([work]);
    expect(button("work").getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[aria-label="More composer controls"]')).toBeNull();
    expect(document.activeElement).toBe(focused);

    await act(async () => settleBlocking?.("stay"));
    expect(button("More composer controls")).toBeInstanceOf(HTMLButtonElement);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.activeElement).toBe(focused);
  });

  it("makes busy direct and overflow-row triggers focusable, truthful, and refusing", async () => {
    const busy = panelControl("work", { interaction: "busy" });
    controls = [busy];
    measuredLayout = layout(controls, ["work"]);
    await renderToolbar();
    expect(button("work").getAttribute("aria-busy")).toBe("true");
    expect(button("work").disabled).toBe(false);
    await press(button("work"));
    expect(dialog()).toBeNull();

    const readonly = statusControl("readonly");
    controls = [busy, readonly];
    measuredLayout = layout(controls, []);
    await renderToolbar(controls);
    await press(button("More composer controls"));
    const row = dialog()?.querySelector<HTMLButtonElement>('[aria-label="work"]');
    expect(row?.getAttribute("aria-busy")).toBe("true");
    expect(row?.getAttribute("aria-disabled")).toBe("true");
    expect(row?.disabled).toBe(false);
    row && (await press(row));
    expect(dialog()?.getAttribute("data-page")).toBe("root");
  });

  it("commits panel to status with no invalid dialog frame and returns current-time focus", async () => {
    const agent = panelControl("agent");
    controls = [agent];
    measuredLayout = layout(controls, ["agent"]);
    await renderToolbar();
    await press(button("agent"));
    expect(dialog()).not.toBeNull();
    const readonly = statusControl("agent");
    measuredLayout = layout([readonly], ["agent"]);
    await renderToolbar([readonly]);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button("agent status"));
    expect(button("agent status").hasAttribute("aria-haspopup")).toBe(false);
  });
});

describe("ComposerToolbar focus execution", () => {
  it("tries ordered candidates then Content and never acknowledges a disabled target", async () => {
    const agent = panelControl("agent", { primaryDisabled: true });
    controls = [agent];
    measuredLayout = layout(controls, ["agent"]);
    await renderToolbar();
    await press(button("agent"));
    expect(document.activeElement).toBe(agent.secondary.current);

    const noCandidates = panelControl("empty", { primaryDisabled: true, showPrimary: false });
    noCandidates.panel.focus = {
      ...noCandidates.panel.focus,
      candidates: [{ key: "missing", ref: createRef() }],
    };
    controls = [noCandidates];
    measuredLayout = layout(controls, ["empty"]);
    await renderToolbar();
    await press(button("empty"));
    expect(document.activeElement).toBe(dialog());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("preserves valid in-content focus on same-page repair", async () => {
    let agent = panelControl("agent", { repair: "a" });
    controls = [agent];
    measuredLayout = layout(controls, ["agent"]);
    await renderToolbar();
    await press(button("agent"));
    agent.secondary.current?.focus();
    const focused = document.activeElement;
    agent = {
      ...agent,
      panel: { ...agent.panel, focus: { ...agent.panel.focus, repairRevision: "b" } },
    };
    await renderToolbar([agent]);
    expect(document.activeElement).toBe(focused);
  });

  it("repairs a removed focused candidate and preserves focus across host migration", async () => {
    let agent = panelControl("agent", { repair: "a" });
    controls = [agent];
    measuredLayout = layout(controls, ["agent"]);
    await renderToolbar();
    await press(button("agent"));
    const focused = agent.primary.current;
    expect(document.activeElement).toBe(focused);

    agent = panelControl("agent", { repair: "b", showPrimary: false });
    measuredLayout = layout([agent], ["agent"]);
    await renderToolbar([agent]);
    expect(document.activeElement).toBe(agent.secondary.current);

    const beforeMigration = document.activeElement;
    measuredLayout = layout([agent], []);
    await renderToolbar([agent]);
    expect(document.activeElement).toBe(beforeMigration);
    expect(dialog()).not.toBeNull();
  });

  it("repositions from the current semantic host across open migrations", async () => {
    const calls: string[] = [];
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      const label = this.getAttribute("aria-label") ?? "other";
      calls.push(label);
      if (label === "agent") return new DOMRect(40, 80, 120, 32);
      if (label === "More composer controls") return new DOMRect(240, 80, 44, 44);
      return original.call(this);
    };
    try {
      const agent = panelControl("agent");
      controls = [agent];
      measuredLayout = layout(controls, ["agent"]);
      await renderToolbar();
      await press(button("agent"));
      expect(calls).toContain("agent");

      calls.length = 0;
      agent.priority = 2;
      measuredLayout = layout(controls, []);
      await renderToolbar([agent]);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(button("More composer controls")).toBeInstanceOf(HTMLButtonElement);
      expect(calls).toContain("More composer controls");

      calls.length = 0;
      agent.priority = 3;
      measuredLayout = layout(controls, ["agent"]);
      await renderToolbar([agent]);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(calls).toContain("agent");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
});
