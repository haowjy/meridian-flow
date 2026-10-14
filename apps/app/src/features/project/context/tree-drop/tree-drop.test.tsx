/**
 * The drop target lifecycle: a folder row and the rows inside it are one target,
 * a target always gives back what it lit (whatever the verdict is by then), a
 * drag ending anywhere cancels a pending spring-open, and an inner target that
 * ignores a drag never lets its group take it.
 */
import { act, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { MERIDIAN_ENTRIES_MIME } from "./drag-payload";
import {
  type EntriesVerdict,
  TreeDropScope,
  type TreeDropTarget,
  useTreeDropTarget,
} from "./tree-drop";

afterEach(() => vi.useRealTimers());

const folder: TreeDropTarget = {
  scheme: "manuscript",
  catalogRootId: "root",
  folder: { entryId: "act", path: "Act 2", name: "Act 2" },
};
const area: TreeDropTarget = { ...folder, folder: null };
const accept: EntriesVerdict = { kind: "accept", label: "Move to Act 2" };

function Row({
  id,
  target,
  onSpring,
}: {
  id: string;
  target: TreeDropTarget;
  onSpring?: () => void;
}) {
  const drop = useTreeDropTarget(target, { onSpring });
  return <div id={id} data-state={drop.dropState} {...drop.dropProps} />;
}

function scope(verdict: (target: TreeDropTarget) => EntriesVerdict | null, children: ReactNode) {
  return <TreeDropScope route={{ verdict, drop: () => {} }}>{children}</TreeDropScope>;
}

async function fire(id: string, type: string) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing ${id}`);
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { dataTransfer: { types: [MERIDIAN_ENTRIES_MIME], dropEffect: "none" } });
  await act(async () => {
    element.dispatchEvent(event);
  });
  return event;
}

const state = (id: string) => document.getElementById(id)?.getAttribute("data-state");

it("keeps a folder lit while the drag moves from its row onto a row inside it", async () => {
  await withReactRoot(
    scope(
      () => accept,
      <>
        <Row id="folder" target={folder} />
        <Row id="child" target={folder} />
      </>,
    ),
    async () => {
      await fire("folder", "dragenter");
      await fire("child", "dragenter");
      await fire("folder", "dragleave");
      expect(state("folder")).toBe("over");
      await fire("child", "dragleave");
      expect(state("folder")).toBe("idle");
    },
  );
});

it("gives the target back when its verdict goes quiet while hovering", async () => {
  let verdict: EntriesVerdict | null = accept;
  await withReactRoot(
    scope(() => verdict, <Row id="folder" target={folder} />),
    async () => {
      await fire("folder", "dragenter");
      verdict = null;
      await fire("folder", "dragover");
      expect(state("folder")).toBe("idle");
      await fire("folder", "dragleave");
      expect(state("folder")).toBe("idle");
    },
  );
});

it("cancels a pending spring-open when the drag ends elsewhere", async () => {
  vi.useFakeTimers();
  const spring = vi.fn();
  await withReactRoot(
    scope(() => accept, <Row id="folder" target={folder} onSpring={spring} />),
    async () => {
      await fire("folder", "dragenter");
      await act(async () => {
        window.dispatchEvent(new window.Event("dragend"));
      });
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(spring).not.toHaveBeenCalled();
      expect(state("folder")).toBe("idle");
    },
  );
});

it("never lets a group take a drag its row ignored", async () => {
  function Nested() {
    const outer = useTreeDropTarget(area);
    const inner = useTreeDropTarget(folder);
    return (
      <div id="group" data-state={outer.dropState} {...outer.dropProps}>
        <div id="row" data-state={inner.dropState} {...inner.dropProps} />
      </div>
    );
  }
  await withReactRoot(
    // The area would take it; the row it sits in says nothing.
    scope((target) => (target.folder ? null : accept), <Nested />),
    async () => {
      const event = await fire("row", "dragenter");
      expect(event.defaultPrevented).toBe(false);
      expect(state("group")).toBe("idle");
    },
  );
});
