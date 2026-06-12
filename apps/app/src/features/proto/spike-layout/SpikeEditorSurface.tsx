// @ts-nocheck
/**
 * SpikeEditorSurface — the REAL production TipTap editor mounted with the REAL
 * extension set (`createEditorConfig` from `@/core/editor/config`), but bound
 * to a fully LOCAL DocumentSession (no WS, no IndexedDB).
 *
 * Per the integration report (p1506) FALLBACK path: this gives us pixel-identical
 * pointer surface to the production EditorView (same StarterKit config, same
 * Meridian marks/nodes, same Collaboration/CollaborationCursor extensions, same
 * contenteditable behavior) without needing a live WS session.
 *
 * The instance is created ONCE per mount, and seeded with scrollable content so
 * gate #1 (portal survival) can prove scroll position + caret state survive
 * being moved between grid slots.
 *
 * NOTE on path choice: we did NOT use the production `EditorView` directly
 * because it calls `getDocumentSessionRegistry().get(documentId)`, which would
 * open a real WS session against the dev stack. Sync correctness is
 * irrelevant to this spike — only pointer-event behavior. The fallback path is
 * what the spike spec explicitly endorses for that reason.
 */
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo, useRef } from "react";

import { createEditorConfig } from "@/core/editor/config";
import { DocumentSession } from "@/core/editor/document-session";

const SEED_PARAGRAPHS = [
  "This is the live contenteditable surface — Gate #2 is testing that a resize drag swept across THIS region does not steal the drag, move the caret, select text, or steal focus.",
  "Try it: press the vertical handle to the left of this card, drag the pointer deep into this paragraph, sweep around, then release. Width should track continuously, no caret should move, and pointerup should complete the drag even when released here.",
  "When NOT dragging, normal interactions must work: click anywhere to place the caret, drag-select to highlight, type to insert text. The drag-time shield must exist only mid-drag.",
  "We deliberately include a lot of paragraphs so there's something to scroll. Gate #1 reuses this exact mounted instance — after toggling the layout mode, scroll position and editor instance must survive (reverse-portal moves the DOM node; React never reparents the component).",
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.",
  "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.",
  "Curabitur pretium tincidunt lacus. Nulla gravida orci a odio. Nullam varius, turpis et commodo pharetra, est eros bibendum elit, nec luctus magna felis sollicitudin mauris.",
  "Integer in mauris eu nibh euismod gravida. Duis ac tellus et risus vulputate vehicula. Donec lobortis risus a elit. Etiam tempor. Ut ullamcorper, ligula eu tempor congue, eros est euismod turpis.",
  "Aenean massa. Cum sociis natoque penatibus et magnis dis parturient montes, nascetur ridiculus mus. Donec quam felis, ultricies nec, pellentesque eu, pretium quis, sem.",
  "Nulla consequat massa quis enim. Donec pede justo, fringilla vel, aliquet nec, vulputate eget, arcu. In enim justo, rhoncus ut, imperdiet a, venenatis vitae, justo.",
  "Nullam dictum felis eu pede mollis pretium. Integer tincidunt. Cras dapibus. Vivamus elementum semper nisi. Aenean vulputate eleifend tellus.",
  "Aenean leo ligula, porttitor eu, consequat vitae, eleifend ac, enim. Aliquam lorem ante, dapibus in, viverra quis, feugiat a, tellus.",
];

function buildSeedDoc() {
  return {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: "Spike Editor — Gate #1 + #2 surface" }],
      },
      ...SEED_PARAGRAPHS.map((p) => ({
        type: "paragraph",
        content: [{ type: "text", text: p }],
      })),
    ],
  };
}

export function SpikeEditorSurface({
  documentId = "spike-layout-proto-1",
  onMount,
}: {
  documentId?: string;
  /** Gate #6: called exactly once if the surface is never remounted. */
  onMount?: () => void;
}) {
  // Local-only session — no transportFactory, no IndexedDB.
  const session = useMemo(
    () => new DocumentSession({ documentId, enableIndexedDb: false }),
    [documentId],
  );

  // One-shot mount counter (gate #6). Fires after mount, not during render,
  // so it doesn't setState in a parent during a child's render phase.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Gate #6 counts first mount only; onMount identity changes are not remounts.
  useEffect(() => {
    onMount?.();
  }, []);

  // We seed content via a one-shot effect after editor creation.
  const seededRef = useRef(false);

  const editor = useEditor(
    {
      ...createEditorConfig({
        document: session.document,
        awareness: session.awareness,
        user: { name: "Spike user", color: "var(--color-primary)" },
        editorProps: {
          attributes: {
            class: "prose-tokens focus-ring min-h-full px-6 py-6 md:px-10 md:py-8",
            "aria-label": "Spike editor — contenteditable surface for Gate #2",
          },
        },
      }),
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
      onCreate({ editor }) {
        if (seededRef.current) return;
        seededRef.current = true;
        // Seed only if the doc is empty (it is — local-only, fresh Y.Doc).
        if (editor.isEmpty) {
          editor.commands.setContent(buildSeedDoc(), false);
        }
      },
    },
    [session],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-4 py-2 text-meta text-muted-foreground">
        <span className="uppercase tracking-wide">Editor surface</span>
        <span className="font-mono text-[10px] tracking-wide">documentId: {documentId}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" data-spike-editor-scroll>
        <EditorContent editor={editor} className="min-h-full" />
      </div>
    </div>
  );
}
