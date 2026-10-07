// @vitest-environment jsdom
/**
 * The pieces every surface shows a change with: the row, the bar, the stepper
 * and the toast. They take no controller, so these tests drive them with props.
 */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatThreadNavigationProvider } from "@/features/chat/ChatThreadNavigation";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ReviewChangeBar } from "./ReviewChangeBar";
import { ReviewChangeRow } from "./ReviewChangeRow";
import { ReviewStepper } from "./ReviewStepper";
import { ReviewToast } from "./ReviewToast";
import type { ReviewChange } from "./review-changes";

function change(overrides: Partial<ReviewChange> = {}): ReviewChange {
  return {
    classId: "c1",
    operations: [],
    operationIds: ["1"],
    anchorOperationId: "1",
    tone: "ai",
    includesWriterEdits: false,
    merged: false,
    change: { removed: "his", added: "one withered" },
    attribution: { kind: "ai" },
    ...overrides,
  };
}

function render(node: React.ReactNode, run: () => Promise<void>, openThread = vi.fn()) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  return withReactRoot(
    <I18nProvider i18n={i18n}>
      <TooltipProvider>
        <ChatThreadNavigationProvider onOpenThread={openThread}>
          {node}
        </ChatThreadNavigationProvider>
      </TooltipProvider>
    </I18nProvider>,
    run,
  );
}

const button = (name: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) =>
      (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").trim() === name,
  );

const rowProps = (overrides: Partial<React.ComponentProps<typeof ReviewChangeRow>> = {}) => ({
  change: change(),
  focused: false,
  disabled: false,
  canApply: true,
  failure: null,
  onFocus: vi.fn(),
  onApply: vi.fn(),
  onDiscard: vi.fn(),
  ...overrides,
});

describe("ReviewChangeRow", () => {
  it("is one line: the excerpt, who made it, and Discard and Apply named for assistive tech", async () => {
    await render(
      <ul>
        <ReviewChangeRow {...rowProps()} />
      </ul>,
      async () => {
        const row = document.querySelector("[data-review-change-row]");
        expect(row?.textContent).toContain("his");
        expect(row?.textContent).toContain("one withered");
        expect(row?.textContent).toContain("AI");
        expect(button("Discard")).toBeDefined();
        expect(button("Apply")).toBeDefined();
      },
    );
  });

  it("focuses the change on a click, and Apply or Discard act without also focusing", async () => {
    const props = rowProps();
    await render(
      <ul>
        <ReviewChangeRow {...props} />
      </ul>,
      async () => {
        await act(async () => document.querySelector<HTMLElement>("li")?.click());
        expect(props.onFocus).toHaveBeenCalledTimes(1);
        await act(async () => button("Apply")?.click());
        await act(async () => button("Discard")?.click());
        expect(props.onApply).toHaveBeenCalledTimes(1);
        expect(props.onDiscard).toHaveBeenCalledTimes(1);
        expect(props.onFocus).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("is reachable from the keyboard: the excerpt is a button", async () => {
    const props = rowProps();
    await render(
      <ul>
        <ReviewChangeRow {...props} focused />
      </ul>,
      async () => {
        const excerpt = document.querySelector<HTMLButtonElement>("button[aria-current='true']");
        expect(excerpt).not.toBeNull();
        await act(async () => excerpt?.click());
        expect(props.onFocus).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("says Discard with your edits when the writer's edits are inside, and shows You for their own change", async () => {
    await render(
      <ul>
        <ReviewChangeRow
          {...rowProps({
            change: change({ includesWriterEdits: true, attribution: { kind: "you" } }),
          })}
        />
      </ul>,
      async () => {
        expect(button("Discard with your edits")).toBeDefined();
        expect(document.querySelector("li")?.textContent).toContain("You");
      },
    );
  });

  it("disables both commands while one is in flight, and hides Apply for a new document", async () => {
    await render(
      <ul>
        <ReviewChangeRow {...rowProps({ disabled: true })} />
      </ul>,
      async () => {
        expect(button("Apply")?.disabled).toBe(true);
        expect(button("Discard")?.disabled).toBe(true);
      },
    );
    await render(
      <ul>
        <ReviewChangeRow {...rowProps({ canApply: false })} />
      </ul>,
      async () => {
        expect(button("Apply")).toBeUndefined();
      },
    );
  });

  it("opens the chat that wrote it without acting on the change", async () => {
    const props = rowProps({
      change: change({ attribution: { kind: "chat", threadId: "t-9", title: "Line edit" } }),
    });
    const openThread = vi.fn();
    await render(
      <ul>
        <ReviewChangeRow {...props} />
      </ul>,
      async () => {
        const link = Array.from(document.querySelectorAll("button")).find((b) =>
          b.textContent?.includes("Line edit"),
        );
        await act(async () => link?.click());
        expect(openThread).toHaveBeenCalledWith("t-9");
        expect(props.onFocus).not.toHaveBeenCalled();
      },
      openThread,
    );
  });

  it("calls an untitled chat what the chat list calls it, and still opens it", async () => {
    const props = rowProps({
      change: change({ attribution: { kind: "chat", threadId: "t-3", title: null } }),
    });
    const openThread = vi.fn();
    await render(
      <ul>
        <ReviewChangeRow {...props} />
      </ul>,
      async () => {
        const link = Array.from(document.querySelectorAll("button")).find((b) =>
          b.textContent?.includes("New chat"),
        );
        expect(link).toBeDefined();
        await act(async () => link?.click());
        expect(openThread).toHaveBeenCalledWith("t-3");
      },
      openThread,
    );
  });

  it("shows why a command did not land, on the row", async () => {
    await render(
      <ul>
        <ReviewChangeRow
          {...rowProps({ failure: { phase: "failed", mode: "apply", code: "offline" } })}
        />
      </ul>,
      async () => {
        expect(document.querySelector("li")?.textContent).toContain(
          "Couldn't apply. Check your connection and try again.",
        );
      },
    );
  });
});

describe("touch forms", () => {
  const targets = (selector: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((node) =>
      node.className.includes("size-11"),
    );

  it("raises the row's Discard and Apply to 44px targets", async () => {
    await render(
      <ul>
        <ReviewChangeRow {...rowProps()} touch />
      </ul>,
      async () => {
        expect(button("Discard")?.className).toContain("size-11");
        expect(button("Apply")?.className).toContain("size-11");
        expect(document.querySelector("li button[aria-current], li button")?.className).toContain(
          "min-h-11",
        );
      },
    );
  });

  it("keeps the bar's accessible Discard name in full while showing only Discard", async () => {
    const props = {
      change: change({ includesWriterEdits: true }),
      disabled: false,
      canApply: true,
      failure: null,
      onApply: vi.fn(),
      onDiscard: vi.fn(),
    };
    await render(<ReviewChangeBar {...props} touch />, async () => {
      const discard = button("Discard with your edits");
      expect(discard?.textContent).toBe("Discard");
      expect(discard?.className).toContain("h-11");
      expect(button("Apply")?.className).toContain("h-11");
      expect(document.body.textContent).toContain("Includes your edits");
      await act(async () => discard?.click());
      expect(props.onDiscard).toHaveBeenCalledOnce();
    });
  });

  it("makes both stepper arrows 44px", async () => {
    await render(
      <ReviewStepper count={6} focusedIndex={2} disabled={false} onStep={vi.fn()} touch />,
      async () => {
        expect(targets("button")).toHaveLength(2);
        expect(document.body.textContent).toContain("3 of 6");
      },
    );
  });

  it("places the toast where the host asks", async () => {
    await render(
      <ReviewToast
        toast={{ id: 1, code: "applied", tone: "success" } as never}
        onDismiss={vi.fn()}
        className="bottom-24"
      />,
      async () => {
        expect(document.querySelector("[data-review-toast]")?.className).toContain("bottom-24");
      },
    );
  });
});

describe("ReviewChangeBar", () => {
  const barProps = (overrides: Partial<React.ComponentProps<typeof ReviewChangeBar>> = {}) => ({
    change: change(),
    disabled: false,
    canApply: true,
    failure: null,
    onApply: vi.fn(),
    onDiscard: vi.fn(),
    ...overrides,
  });

  it("offers Discard and Apply, and says AI when the preview cannot name the chat", async () => {
    const props = barProps();
    await render(<ReviewChangeBar {...props} />, async () => {
      expect(document.body.textContent).toContain("AI");
      await act(async () => button("Apply")?.click());
      await act(async () => button("Discard")?.click());
      expect(props.onApply).toHaveBeenCalledOnce();
      expect(props.onDiscard).toHaveBeenCalledOnce();
    });
  });

  it("calls an untitled chat what the chat list calls it", async () => {
    const openThread = vi.fn();
    await render(
      <ReviewChangeBar
        {...barProps({
          change: change({ attribution: { kind: "chat", threadId: "t-3", title: null } }),
        })}
      />,
      async () => {
        const link = Array.from(document.querySelectorAll("button")).find((b) =>
          b.textContent?.includes("New chat"),
        );
        await act(async () => link?.click());
        expect(openThread).toHaveBeenCalledWith("t-3");
      },
      openThread,
    );
  });

  it("names a mixed change: Includes your edits, and Discard with your edits", async () => {
    await render(
      <ReviewChangeBar {...barProps({ change: change({ includesWriterEdits: true }) })} />,
      async () => {
        expect(document.body.textContent).toContain("Includes your edits");
        expect(button("Discard with your edits")).toBeDefined();
        expect(button("Discard")).toBeUndefined();
      },
    );
  });

  it("links the chat that wrote it, and shows You for the writer's own change", async () => {
    const openThread = vi.fn();
    await render(
      <ReviewChangeBar
        {...barProps({
          change: change({ attribution: { kind: "chat", threadId: "t-1", title: "Pacing" } }),
        })}
      />,
      async () => {
        const link = Array.from(document.querySelectorAll("button")).find((b) =>
          b.textContent?.includes("Pacing"),
        );
        await act(async () => link?.click());
        expect(openThread).toHaveBeenCalledWith("t-1");
      },
      openThread,
    );
    await render(
      <ReviewChangeBar
        {...barProps({ change: change({ attribution: { kind: "you" }, tone: "writer" }) })}
      />,
      async () => expect(document.body.textContent).toContain("You"),
    );
  });

  it("hides Apply for a new document, disables while in flight, and shows each refusal on the bar", async () => {
    await render(<ReviewChangeBar {...barProps({ canApply: false })} />, async () => {
      expect(button("Apply")).toBeUndefined();
    });
    await render(<ReviewChangeBar {...barProps({ disabled: true })} />, async () => {
      expect(button("Apply")?.disabled).toBe(true);
    });
    const messages = [
      ["stale", "This change was updated. Check it and apply again."],
      ["offline", "Couldn't apply. Check your connection and try again."],
    ] as const;
    for (const [code, text] of messages) {
      await render(
        <ReviewChangeBar {...barProps({ failure: { phase: "failed", mode: "apply", code } })} />,
        async () => expect(document.body.textContent).toContain(text),
      );
    }
  });
});

describe("ReviewStepper", () => {
  it("steps both ways with named buttons, and reads the position", async () => {
    const onStep = vi.fn();
    await render(
      <ReviewStepper count={6} focusedIndex={1} disabled={false} onStep={onStep} />,
      async () => {
        expect(document.body.textContent).toContain("2 of 6");
        await act(async () => button("Next change")?.click());
        await act(async () => button("Previous change")?.click());
        expect(onStep.mock.calls).toEqual([[1], [-1]]);
      },
    );
  });

  it("reads the count before any change is focused", async () => {
    await render(
      <ReviewStepper count={6} focusedIndex={-1} disabled={false} onStep={vi.fn()} />,
      async () => expect(document.body.textContent).toContain("6 changes"),
    );
  });
});

describe("ReviewToast", () => {
  it("says what happened, offers no Undo, and dismisses itself", async () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    try {
      await render(
        <ReviewToast toast={{ id: 3, code: "applied", tone: "info" }} onDismiss={onDismiss} />,
        async () => {
          expect(document.querySelector("[role=status]")?.textContent).toBe("Applied");
          expect(document.querySelector("button")).toBeNull();
          await act(async () => {
            vi.advanceTimersByTime(4000);
          });
          expect(onDismiss).toHaveBeenCalledWith(3);
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
