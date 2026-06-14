// @ts-nocheck
/**
 * SpikeLayoutShell — the stable-identity project proto root.
 *
 * Architecture (the thing the spike is proving):
 *   - Every surface (editor, chat, rail) is mounted ONCE inside a
 *     `react-reverse-portal` `InPortal`. The InPortal subtree owns the React
 *     identity AND the DOM identity of the surface forever.
 *   - The project has a static CSS grid of named slots. Each slot renders
 *     an `OutPortal` for whichever surface state says lives there.
 *   - Moving a surface = a state change (`assignment[surface] = slot`). React
 *     never re-parents the InPortal; reverse-portal moves the underlying DOM
 *     node to the new OutPortal location.
 *   - The mode toggle (context ↔ chat) reassigns multiple slots at once;
 *     slot containers animate via Motion `layout`.
 *   - The editor / sibling boundary is resized by a custom ResizeHandle that
 *     mutates `grid-template-columns` imperatively with a drag-time shield
 *     (Gate #2 — the GO/NO-GO).
 *
 * What this file owns:
 *   - The single InPortal mounts (mount-once invariant for gate #1, #6).
 *   - The slot grid + the OutPortal wiring (the "stable identity" claim).
 *   - The resize handle's target ref + commit handler.
 *   - The mode toggle and "move editor to dock" affordance for gate #1.
 *   - Mount counters (gate #6) and a render-count probe per slot.
 */
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createHtmlPortalNode,
  type HtmlPortalNode,
  InPortal,
  OutPortal,
} from "react-reverse-portal";

import { cn } from "@/lib/utils";

import { ResizeHandle } from "./ResizeHandle";
import { SpikeChatSurface } from "./SpikeChatSurface";
import { SpikeEditorSurface } from "./SpikeEditorSurface";
import { SpikeRailSurface } from "./SpikeRailSurface";
import type { SlotId, SurfaceId } from "./types";
import { useSpikeState } from "./use-spike-state";

const DEFAULT_LEFT_WIDTH = 560;

export function SpikeLayoutShell() {
  // -------- Portal nodes (mount-once identity per surface) --------
  // `createHtmlPortalNode` touches document — client-only via useState init in
  // an effect.
  const [editorNode, setEditorNode] = useState<HtmlPortalNode | null>(null);
  const [chatNode, setChatNode] = useState<HtmlPortalNode | null>(null);
  const [railNode, setRailNode] = useState<HtmlPortalNode | null>(null);
  useEffect(() => {
    // The portal's wrapper element is a real DOM node that wraps the moved
    // subtree — we want it to behave like a flex/min-h-0 container so the
    // scroll-y nested elements actually clip at the slot's height instead of
    // letting their intrinsic content height escape the slot.
    const containerAttrs = {
      attributes: {
        style: "display:flex;flex:1 1 0;min-height:0;min-width:0;height:100%;",
      },
    };
    setEditorNode(createHtmlPortalNode(containerAttrs));
    setChatNode(createHtmlPortalNode(containerAttrs));
    setRailNode(createHtmlPortalNode(containerAttrs));
  }, []);

  // -------- Mount counters (gate #6) --------
  const editorMountsRef = useRef(0);
  const chatMountsRef = useRef(0);
  const railMountsRef = useRef(0);
  const [, force] = useState(0);
  const bumpEditorMounts = useCallback(() => {
    editorMountsRef.current += 1;
    force((n) => n + 1);
    // eslint-disable-next-line no-console
    console.log("[spike] EDITOR MOUNT", editorMountsRef.current);
  }, []);
  const bumpChatMounts = useCallback(() => {
    chatMountsRef.current += 1;
    force((n) => n + 1);
    // eslint-disable-next-line no-console
    console.log("[spike] CHAT MOUNT", chatMountsRef.current);
  }, []);
  const bumpRailMounts = useCallback(() => {
    railMountsRef.current += 1;
    force((n) => n + 1);
    // eslint-disable-next-line no-console
    console.log("[spike] RAIL MOUNT", railMountsRef.current);
  }, []);

  // -------- Project state --------
  const mode = useSpikeState((s) => s.mode);
  const assignment = useSpikeState((s) => s.assignment);
  const toggleMode = useSpikeState((s) => s.toggleMode);
  const assign = useSpikeState((s) => s.assign);

  // -------- Resize: imperative grid-template-columns ----------
  const gridRef = useRef<HTMLDivElement | null>(null);
  const leftWidthRef = useRef(DEFAULT_LEFT_WIDTH);
  const formatGridTemplate = useCallback((leftWidthPx: number) => {
    // [left][handle][center 1fr][right rail 320px]
    return `${leftWidthPx}px 8px minmax(320px, 1fr) 320px`;
  }, []);
  const initialGridTemplate = useMemo(
    () => formatGridTemplate(DEFAULT_LEFT_WIDTH),
    [formatGridTemplate],
  );

  // -------- Manual move buttons (gate #1) --------
  const moveEditorTo = useCallback(
    (slot: SlotId) => {
      assign("editor", slot);
    },
    [assign],
  );

  return (
    <div className="flex h-svh min-h-0 w-full flex-col overflow-hidden bg-background text-foreground">
      {/* InPortal: each surface is mounted ONCE here, regardless of where it's */}
      {/* shown. */}
      {editorNode ? (
        <InPortal node={editorNode}>
          <SpikeEditorSurface onMount={bumpEditorMounts} />
        </InPortal>
      ) : null}
      {chatNode ? (
        <InPortal node={chatNode}>
          <SpikeChatSurface onMount={bumpChatMounts} />
        </InPortal>
      ) : null}
      {railNode ? (
        <InPortal node={railNode}>
          <SpikeRailSurface onMount={bumpRailMounts} />
        </InPortal>
      ) : null}

      {/* Header / controls */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-4 py-2">
        <span className="text-meta uppercase tracking-[0.18em] text-muted-foreground">
          Spike: stable-identity layout
        </span>
        <div className="ml-2 flex gap-1">
          <ModeButton
            active={mode === "context"}
            onClick={() => mode !== "context" && toggleMode()}
            label="Context mode"
          />
          <ModeButton
            active={mode === "chat"}
            onClick={() => mode !== "chat" && toggleMode()}
            label="Chat mode"
          />
        </div>

        <div className="ml-2 flex items-center gap-1 text-meta text-muted-foreground">
          <span className="font-mono">editor →</span>
          {(["left", "center", "dock-right"] as SlotId[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => moveEditorTo(s)}
              className={cn(
                "focus-ring rounded-md border px-1.5 py-0.5 font-mono text-[10px] uppercase transition-colors",
                assignment.editor === s
                  ? "border-primary bg-chip-primary-bg text-foreground"
                  : "border-border text-muted-foreground hover:border-border-focus",
              )}
              data-testid={`assign-editor-${s}`}
            >
              {s}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-3 text-meta text-muted-foreground">
          <MountReadout
            editor={editorMountsRef.current}
            chat={chatMountsRef.current}
            rail={railMountsRef.current}
          />
        </div>
      </header>

      {/* The grid. Its `grid-template-columns` is mutated by the resize handle
          imperatively — we set it once via inline style for the initial value,
          and the handle owns subsequent updates. */}
      <div
        ref={gridRef}
        className="grid min-h-0 flex-1"
        style={{
          gridTemplateColumns: initialGridTemplate,
          gridTemplateRows: "1fr",
        }}
        data-spike-grid
      >
        {/* Left slot */}
        <Slot
          id="left"
          assignment={assignment}
          portalsBySurface={{
            editor: editorNode,
            chat: chatNode,
            rail: railNode,
          }}
        />

        {/* Resize handle column */}
        <div className="relative h-full">
          <ResizeHandle
            gridRef={gridRef}
            formatGridTemplate={formatGridTemplate}
            initialLeftWidthPx={leftWidthRef.current}
            onCommit={(w) => {
              leftWidthRef.current = w;
            }}
          />
        </div>

        {/* Center slot */}
        <Slot
          id="center"
          assignment={assignment}
          portalsBySurface={{
            editor: editorNode,
            chat: chatNode,
            rail: railNode,
          }}
        />

        {/* Right rail column — split into rail + dock-right vertically */}
        <div className="grid h-full min-h-0 grid-rows-[1fr_minmax(180px,40%)]">
          <Slot
            id="rail-top"
            assignment={assignment}
            portalsBySurface={{
              editor: editorNode,
              chat: chatNode,
              rail: railNode,
            }}
          />
          <DockSlot
            id="dock-right"
            assignment={assignment}
            portalsBySurface={{
              editor: editorNode,
              chat: chatNode,
              rail: railNode,
            }}
          />
        </div>
      </div>

      {/* Footer / gate notes */}
      <SpikeStatusBar />
    </div>
  );
}

function MountReadout({ editor, chat, rail }: { editor: number; chat: number; rail: number }) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  if (!hydrated) return <span className="font-mono">mounts: …</span>;
  return (
    <span className="font-mono">
      mounts: editor={editor} · chat={chat} · rail={rail}
    </span>
  );
}

function ModeButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "focus-ring rounded-lg px-2.5 py-1 text-body font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      data-testid={`mode-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      {label}
    </button>
  );
}

/**
 * Slot — renders the surface currently assigned to it via OutPortal. Uses
 * Motion `layout` so when the assignment table changes, the slot animates.
 *
 * Includes a tiny render-count probe overlay (gate #6) that ticks each render
 * of THIS slot child — proving the resize drag (handled imperatively) does NOT
 * cause per-pointermove React renders of the slot child.
 */
function Slot({
  id,
  assignment,
  portalsBySurface,
}: {
  id: SlotId;
  assignment: Record<SurfaceId, SlotId>;
  portalsBySurface: Record<SurfaceId, HtmlPortalNode | null>;
}) {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const surface = (Object.keys(assignment) as SurfaceId[]).find((s) => assignment[s] === id);
  const portal = surface ? portalsBySurface[surface] : null;

  return (
    <motion.div
      layout
      transition={{
        type: "tween",
        ease: [0.33, 1, 0.68, 1],
        duration: 0.32,
      }}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-border bg-card",
        id === "rail-top" && "border-r-0 border-b",
      )}
      data-spike-slot={id}
    >
      <SlotProbe slotId={id} renderCountRef={renderCountRef} />
      {portal ? (
        <OutPortal node={portal} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-meta text-muted-foreground">
          (empty)
        </div>
      )}
    </motion.div>
  );
}

/**
 * SlotProbe — client-only render-count overlay (gate #6). Suspended during SSR
 * to avoid hydration mismatches (the parent re-renders before mount, so the
 * count diverges from the server's value).
 */
function SlotProbe({
  slotId,
  renderCountRef,
}: {
  slotId: SlotId;
  renderCountRef: React.RefObject<number>;
}) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  if (!hydrated) return null;
  return (
    <div className="pointer-events-none absolute right-2 top-1.5 z-20 rounded-full bg-background/80 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground shadow-sm">
      slot:{slotId} · render#{renderCountRef.current}
    </div>
  );
}

/**
 * DockSlot — gate #4: coplanar overlay aesthetic. Sits inside the right rail
 * column but visually "floats" with rounded inside edge + shadow-through.
 */
function DockSlot({
  id,
  assignment,
  portalsBySurface,
}: {
  id: SlotId;
  assignment: Record<SurfaceId, SlotId>;
  portalsBySurface: Record<SurfaceId, HtmlPortalNode | null>;
}) {
  const surface = (Object.keys(assignment) as SurfaceId[]).find((s) => assignment[s] === id);
  const portal = surface ? portalsBySurface[surface] : null;

  return (
    <motion.div
      layout
      transition={{
        type: "tween",
        ease: [0.33, 1, 0.68, 1],
        duration: 0.32,
      }}
      className={cn(
        "relative m-2 flex min-h-0 min-w-0 flex-col overflow-hidden",
        "rounded-tl-2xl rounded-bl-2xl rounded-tr-md rounded-br-md",
        "border border-border bg-background",
      )}
      style={{
        // Coplanar overlay aesthetic: a soft drop shadow under the card +
        // a thin inset "edge highlight" along the rounded inside edge to
        // hint at depth (the dock is "lifted" off the rail behind it).
        boxShadow:
          "0 10px 30px -16px rgba(0, 0, 0, 0.35), inset 1px 0 0 0 rgba(255, 255, 255, 0.04)",
      }}
      data-spike-slot={id}
    >
      <div className="pointer-events-none absolute right-2 top-1.5 z-20 rounded-full bg-card/80 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground shadow-sm">
        dock-slot
      </div>
      {portal ? (
        <OutPortal node={portal} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-meta text-muted-foreground">
          (empty)
        </div>
      )}
    </motion.div>
  );
}

function SpikeStatusBar() {
  return (
    <div className="shrink-0 border-t border-border bg-card px-4 py-2 text-meta text-muted-foreground">
      <span className="font-mono">
        Gate #2 = press the vertical bar between left & center, drag DEEP into the editor, release
        over it. Width tracks; no caret moves; no selection; pointerup completes. When NOT dragging,
        click-to-caret + drag-select still work.
      </span>
    </div>
  );
}
