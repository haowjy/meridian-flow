// @ts-nocheck
/**
 * InlineInspector — alt+click any rendered turn/block to inspect its record.
 *
 * The "inline" half of the debug surface: instead of mirroring the conversation
 * in a side panel, you alt+click the REAL transcript and a small popover shows
 * the domain record (Turn or Block) as JSON, anchored at the cursor.
 *
 * Why this is a DOM-anchor consumer (and why scroll-to-turn is NOT):
 * - This only ever acts on elements that are CURRENTLY RENDERED — you click what
 *   you can see. `react-virtuoso` only mounts visible rows, but a click target
 *   is by definition mounted, so `data-turn-id` / `data-block-id` resolve fine.
 * - scroll-to-turn would need to reach OFF-SCREEN rows, which have no DOM node
 *   under virtualization — so it lives in `TurnList` via `scrollToIndex`, owned
 *   by the chat track, not here. (See archived dom-anchors-contract.)
 *
 * Key decisions:
 * - Mounted only from `DebugOverlay`, so it inherits the dev-only build gate AND
 *   the runtime enable toggle — alt+click does nothing unless the overlay is on.
 * - Capture-phase listener with `preventDefault` + `stopPropagation` so the
 *   inspect gesture never triggers the app's own click handlers.
 * - Read-only: resolves turn/block records from the thread store; model-request
 *   capture is lazy-loaded via owner-gated `GET …/debug/model-requests` (404 when
 *   capture is disabled on the server). Store snapshot is held in a ref so the
 *   stable listener always reads fresh data without re-subscribing.
 * - Block is preferred over turn when both match (most specific wins). When a
 *   record isn't in the store, we still show the DOM attributes so the id is
 *   never a dead end.
 * - i18n exception: DEV-only debug surface; inline English bypasses Lingui.
 */
import type {
  Block,
  ModelRequestDebugRecord,
  Turn,
  TurnContextPreview,
} from "@meridian/contracts/threads";
import { useEffect, useRef, useState } from "react";
import { isMeridianApiError } from "@/client/api/http-client";
import {
  getThreadModelRequestDebugRecords,
  getThreadTurnContextPreview,
} from "@/client/api/threads-api";
import { useThreadStore } from "@/client/stores";
import { cn } from "@/lib/utils";

import { JsonTree } from "./JsonTree";

type Hit = {
  kind: "turn" | "block" | "next-turn";
  label: string;
  record: unknown;
  threadId: string | null;
  turnId: string | null;
  x: number;
  y: number;
};

type TurnContextPreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; preview: TurnContextPreview }
  | { status: "disabled" }
  | { status: "error"; message: string };

type ModelRequestsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; records: ModelRequestDebugRecord[] }
  | { status: "disabled" }
  | { status: "error"; message: string };

const PANEL_W = 384; // w-96
const PANEL_MAX_H = 320;
const MARGIN = 12;

function findTurn(turnsByThread: Record<string, Turn[]>, turnId: string): Turn | null {
  for (const turns of Object.values(turnsByThread)) {
    const hit = turns.find((t) => t.id === turnId);
    if (hit) return hit;
  }
  return null;
}

function findBlock(
  turnsByThread: Record<string, Turn[]>,
  blockId: string,
): { block: Block; turn: Turn } | null {
  for (const turns of Object.values(turnsByThread)) {
    for (const turn of turns) {
      const block = turn.blocks?.find((b) => b.id === blockId);
      if (block) return { block, turn };
    }
  }
  return null;
}

export function InlineInspector() {
  const turnsByThread = useThreadStore((s) => s.turnsByThread);
  const turnsRef = useRef(turnsByThread);
  turnsRef.current = turnsByThread;

  const [hit, setHit] = useState<Hit | null>(null);
  const hitRef = useRef(hit);
  hitRef.current = hit;

  const [copied, setCopied] = useState(false);
  const [modelRequests, setModelRequests] = useState<ModelRequestsState>({ status: "idle" });
  const [turnContextPreview, setTurnContextPreview] = useState<TurnContextPreviewState>({
    status: "idle",
  });
  // Bumped on each new inspect target so in-flight model-request fetches cannot
  // commit results for a superseded {threadId, turnId}.
  const modelRequestFetchGenRef = useRef(0);
  const turnContextPreviewFetchGenRef = useRef(0);

  const copyRecord = () => {
    if (!hit) return;
    try {
      const text =
        hit.kind === "next-turn" && turnContextPreview.status === "loaded"
          ? turnContextPreview.preview.systemPrompt
          : (JSON.stringify(hit.record, null, 2) ?? "");
      void navigator.clipboard?.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard may be unavailable; dev-only, fail silently
    }
  };

  // Capture-phase so the inspect gesture wins before the app's own handlers and
  // can swallow the event. Stable listener (empty deps) reads store via ref.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!event.altKey) return;
      const target = event.target as Element | null;
      if (!target?.closest) return;

      const blockEl = target.closest<HTMLElement>("[data-block-id]");
      const turnEl = target.closest<HTMLElement>("[data-turn-id]");
      const composerEl = target.closest<HTMLElement>("[data-debug-composer]");
      if (!blockEl && !turnEl && !composerEl) return;
      if (composerEl && (blockEl || turnEl)) return;

      event.preventDefault();
      event.stopPropagation();
      setCopied(false);
      modelRequestFetchGenRef.current += 1;
      turnContextPreviewFetchGenRef.current += 1;
      setModelRequests({ status: "idle" });
      setTurnContextPreview({ status: "idle" });

      const x = Math.min(event.clientX, window.innerWidth - PANEL_W - MARGIN);
      const y = Math.min(event.clientY, window.innerHeight - PANEL_MAX_H - MARGIN);
      const tbt = turnsRef.current;

      // Block wins when present — it's the more specific target.
      if (blockEl) {
        const blockId = blockEl.getAttribute("data-block-id") ?? "?";
        const found = findBlock(tbt, blockId);
        const parentTurnId =
          found?.turn.id ?? blockEl.closest("[data-turn-id]")?.getAttribute("data-turn-id") ?? "?";
        setHit({
          kind: "block",
          label: `block ${blockId} · turn ${parentTurnId}`,
          record:
            found?.block ??
            ({
              note: "block id not found in thread store (DOM attributes only)",
              blockId,
              blockType: blockEl.getAttribute("data-block-type"),
              sequence: blockEl.getAttribute("data-block-seq"),
              turnId: parentTurnId,
            } as const),
          threadId: found?.turn.threadId ?? null,
          turnId: found?.turn.id ?? (parentTurnId === "?" ? null : parentTurnId),
          x,
          y,
        });
        return;
      }

      if (turnEl) {
        const turnEl2 = turnEl as HTMLElement;
        const turnId = turnEl2.getAttribute("data-turn-id") ?? "?";
        const found = findTurn(tbt, turnId);
        setHit({
          kind: "turn",
          label: `turn ${turnId}`,
          record:
            found ??
            ({
              note: "turn id not found in thread store (DOM attributes only)",
              turnId,
              role: turnEl2.getAttribute("data-turn-role"),
              status: turnEl2.getAttribute("data-turn-status"),
            } as const),
          threadId: found?.threadId ?? null,
          turnId: found?.id ?? (turnId === "?" ? null : turnId),
          x,
          y,
        });
        return;
      }

      const threadId = composerEl?.getAttribute("data-debug-composer") ?? null;
      setHit({
        kind: "next-turn",
        label: threadId ? `next turn · ${threadId}` : "next turn",
        record: { note: "lazy-loaded turn context preview" },
        threadId,
        turnId: null,
        x,
        y,
      });
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // Escape closes the popover.
  useEffect(() => {
    if (!hit) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHit(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hit]);

  useEffect(() => {
    if (!hit || hit.kind !== "next-turn" || !hit.threadId) return;
    if (turnContextPreview.status !== "idle") return;

    const { threadId } = hit;
    const fetchGen = turnContextPreviewFetchGenRef.current;
    setTurnContextPreview({ status: "loading" });
    void getThreadTurnContextPreview({ data: { threadId } })
      .then((preview) => {
        const current = hitRef.current;
        if (
          fetchGen !== turnContextPreviewFetchGenRef.current ||
          current?.kind !== "next-turn" ||
          current.threadId !== threadId
        ) {
          return;
        }
        setTurnContextPreview({ status: "loaded", preview });
      })
      .catch((error: unknown) => {
        const current = hitRef.current;
        if (
          fetchGen !== turnContextPreviewFetchGenRef.current ||
          current?.kind !== "next-turn" ||
          current.threadId !== threadId
        ) {
          return;
        }
        if (isMeridianApiError(error) && error.code === "not_found") {
          setTurnContextPreview({ status: "disabled" });
          return;
        }
        const message = error instanceof Error ? error.message : "request failed";
        setTurnContextPreview({ status: "error", message });
      });
  }, [hit, turnContextPreview.status]);

  const loadModelRequests = () => {
    if (!hit?.threadId || !hit.turnId || modelRequests.status === "loading") return;
    const { threadId, turnId } = hit;
    const fetchGen = modelRequestFetchGenRef.current;
    setModelRequests({ status: "loading" });
    void getThreadModelRequestDebugRecords({
      data: { threadId, turnId },
    })
      .then((response) => {
        const current = hitRef.current;
        if (
          fetchGen !== modelRequestFetchGenRef.current ||
          current?.threadId !== threadId ||
          current?.turnId !== turnId
        ) {
          return;
        }
        setModelRequests({ status: "loaded", records: response.records });
      })
      .catch((error: unknown) => {
        const current = hitRef.current;
        if (
          fetchGen !== modelRequestFetchGenRef.current ||
          current?.threadId !== threadId ||
          current?.turnId !== turnId
        ) {
          return;
        }
        if (isMeridianApiError(error) && error.code === "not_found") {
          setModelRequests({ status: "disabled" });
          return;
        }
        const message = error instanceof Error ? error.message : "request failed";
        setModelRequests({ status: "error", message });
      });
  };

  if (!hit) return null;

  const canLoadModelRequests =
    hit.kind !== "next-turn" && hit.threadId != null && hit.turnId != null;

  return (
    // z above the pill. Backdrop and popover are SIBLINGS: clicking the popover
    // never reaches the backdrop, so no stopPropagation needed and the backdrop
    // is a real <button> (keyboard-dismissable, a11y-clean) rather than a
    // click-wired <div>.
    <div className="fixed inset-0 z-[60]">
      <button
        type="button"
        aria-label="Close inspector"
        className="absolute inset-0 cursor-default"
        onClick={() => setHit(null)}
      />
      <section
        className={cn(
          "absolute flex max-h-[20rem] w-96 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden",
          "rounded-lg border border-border bg-background text-foreground shadow-rail-left",
        )}
        style={{ left: hit.x, top: hit.y }}
        aria-label="Inline inspector"
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {hit.kind}
            </span>
            <span className="truncate font-mono text-meta text-foreground">{hit.label}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {canLoadModelRequests ? (
              <button
                type="button"
                onClick={loadModelRequests}
                className="focus-ring rounded-sm px-2 py-0.5 text-meta text-muted-foreground hover:text-foreground"
                aria-label="Load model requests for this turn"
              >
                {modelRequests.status === "loading" ? "loading…" : "model requests"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={copyRecord}
              className="focus-ring rounded-sm px-2 py-0.5 text-meta text-muted-foreground hover:text-foreground"
              aria-label={hit.kind === "next-turn" ? "Copy system prompt" : "Copy record JSON"}
            >
              {copied ? "copied" : "copy"}
            </button>
            <button
              type="button"
              onClick={() => setHit(null)}
              className="focus-ring rounded-sm px-2 py-0.5 text-meta text-muted-foreground hover:text-foreground"
              aria-label="Close inspector"
            >
              esc
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {hit.kind === "next-turn" ? (
            <div className="space-y-3">
              {turnContextPreview.status === "disabled" ? (
                <p className="text-meta text-muted-foreground">
                  Model-request capture is disabled on this server.
                </p>
              ) : null}
              {turnContextPreview.status === "error" ? (
                <p className="text-meta text-destructive">{turnContextPreview.message}</p>
              ) : null}
              {turnContextPreview.status === "loading" ? (
                <p className="text-meta text-muted-foreground">loading preview…</p>
              ) : null}
              {turnContextPreview.status === "loaded" ? (
                <>
                  <div className="space-y-1">
                    <p className="text-meta font-semibold uppercase tracking-wide text-muted-foreground">
                      system prompt
                      {turnContextPreview.preview.baked
                        ? " · frozen"
                        : " · will be baked at the first turn attempt"}
                    </p>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border-subtle bg-surface-subtle p-2 font-mono text-meta text-foreground">
                      {turnContextPreview.preview.systemPrompt}
                    </pre>
                  </div>
                  <details className="rounded border border-border-subtle bg-surface-subtle p-2">
                    <summary className="cursor-pointer text-meta font-semibold uppercase tracking-wide text-muted-foreground">
                      tools ({turnContextPreview.preview.tools.length})
                    </summary>
                    <JsonTree
                      value={turnContextPreview.preview.tools}
                      className="mt-2 max-h-none border-0 bg-transparent p-0"
                    />
                  </details>
                  <details className="rounded border border-border-subtle bg-surface-subtle p-2">
                    <summary className="cursor-pointer text-meta font-semibold uppercase tracking-wide text-muted-foreground">
                      gateway params
                    </summary>
                    <JsonTree
                      value={turnContextPreview.preview.gatewayParams}
                      className="mt-2 max-h-none border-0 bg-transparent p-0"
                    />
                  </details>
                  <p className="font-mono text-meta text-muted-foreground">
                    agent: {turnContextPreview.preview.agentSlug ?? "none"}
                  </p>
                </>
              ) : null}
            </div>
          ) : null}
          {modelRequests.status === "disabled" ? (
            <p className="mb-2 text-meta text-muted-foreground">
              Model-request capture is disabled on this server.
            </p>
          ) : null}
          {modelRequests.status === "error" ? (
            <p className="mb-2 text-meta text-destructive">{modelRequests.message}</p>
          ) : null}
          {modelRequests.status === "loaded" ? (
            <div className="mb-3 space-y-2 border-b border-border pb-3">
              <p className="text-meta font-semibold uppercase tracking-wide text-muted-foreground">
                model requests ({modelRequests.records.length})
              </p>
              {modelRequests.records.length === 0 ? (
                <p className="text-meta text-muted-foreground">
                  No captured requests for this turn.
                </p>
              ) : (
                modelRequests.records.map((record) => (
                  <div
                    key={`${record.turnId}:${record.iteration}:${record.requestedAt}`}
                    className="rounded border border-border-subtle bg-surface-subtle p-2"
                  >
                    <p className="mb-1 font-mono text-meta text-foreground">
                      iter {record.iteration} · {record.agentSlug ?? "no agent"} ·{" "}
                      {record.model ?? "default model"}
                    </p>
                    <JsonTree value={record} className="max-h-none border-0 bg-transparent p-0" />
                  </div>
                ))
              )}
            </div>
          ) : null}
          {hit.kind !== "next-turn" ? (
            <JsonTree value={hit.record} className="max-h-none border-0 bg-transparent p-0" />
          ) : null}
        </div>
      </section>
    </div>
  );
}
