/**
 * useEditorWikiLinks - Wiki-link extensions, state, and callbacks for EditorPanel.
 *
 * Extracted from EditorPanel (SRP) to isolate wiki-link concerns:
 * - @-mention detection and popover positioning
 * - Wiki-link click navigation
 * - Clipboard interop
 * - Create-from-broken-link popover
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CodeMirrorEditorRef } from "@/core/editor/codemirror";
import { useProjectStore } from "@/core/stores/useProjectStore";
import { useTreeStore } from "@/core/stores/useTreeStore";
import { api } from "@/core/lib/api";
import { makeLogger } from "@/core/lib/logger";
import { openDocument } from "@/core/lib/panelHelpers";
import {
  atMentionField,
  type AtMentionState,
} from "@/features/threads/composer/atDetection";
import {
  createWikiLinkClickHandler,
  createWikiLinkClipboardHandler,
  insertWikiLink,
} from "@/core/editor/codemirror/wikiLinks";
import { usePillNavigation } from "@/shared/reference-pill";
import type { MentionResult } from "@/features/threads/components/DocumentMentionPopover";

const log = makeLogger("editor-wiki-links");

// =============================================================================
// TYPES
// =============================================================================

interface CreatePopoverState {
  path: string;
  displayName: string;
  position: { top: number; left: number };
  refType: "document" | "folder";
}

export interface UseEditorWikiLinksResult {
  /** CodeMirror extensions for wiki-link features */
  extensions: Extension[];
  /** Current @-mention state for popover rendering */
  atMention: AtMentionState | null;
  /** Popover position relative to editor container */
  popoverPosition: { top: number; left: number } | null;
  /** Handle @-mention selection */
  handleWikiLinkSelect: (result: MentionResult) => void;
  /** Close the @-mention popover */
  closeAtMention: () => void;
  /** Create-from-broken-link popover state */
  createPopover: CreatePopoverState | null;
  /** Whether a create-from-broken-link operation is in progress */
  isCreating: boolean;
  /** Handle creating a document or folder from a broken wiki-link */
  handleCreateFromBrokenLink: () => Promise<void>;
  /** Close the create popover */
  closeCreatePopover: () => void;
  /** Folder content popover element (from usePillNavigation) */
  folderPopover: React.ReactNode;
}

// =============================================================================
// HOOK
// =============================================================================

export function useEditorWikiLinks(
  editorRef: React.MutableRefObject<CodeMirrorEditorRef | null>,
  editorContentRef: React.MutableRefObject<HTMLDivElement | null>,
): UseEditorWikiLinksResult {
  const [atMention, setAtMention] = useState<AtMentionState | null>(null);
  const [popoverPosition, setPopoverPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [createPopover, setCreatePopover] =
    useState<CreatePopoverState | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const navigate = useNavigate();
  const projectSlug = useProjectStore((s) => s.currentProject()?.slug) ?? "";
  const { handlePillClick, folderPopover } = usePillNavigation();

  // Compute popover position when atMention changes
  useEffect(() => {
    if (!atMention?.isActive) {
      setPopoverPosition(null);
      return;
    }
    const view = editorRef.current?.getView();
    if (!view) return;
    const coords = view.coordsAtPos(atMention.atPos);
    if (!coords) return;
    const editorRect =
      editorContentRef.current?.getBoundingClientRect() ??
      view.dom.getBoundingClientRect();
    // Guard against element not in DOM yet (zero-size rect)
    if (editorRect.width === 0) {
      setPopoverPosition(null);
      return;
    }
    setPopoverPosition({
      top: coords.bottom - editorRect.top,
      left: coords.left - editorRect.left,
    });
  }, [atMention, editorRef, editorContentRef]);

  // Wiki-link extensions: @-detection, click navigation, clipboard + broken-link create
  const extensions = useMemo(
    () => [
      atMentionField,
      // Bridge at-mention StateField to React state
      EditorView.updateListener.of((update) => {
        if (!update.docChanged && !update.selectionSet) return;
        const mentionState = update.state.field(atMentionField, false);
        setAtMention(mentionState ?? null);
      }),
      createWikiLinkClipboardHandler(),
      createWikiLinkClickHandler(
        handlePillClick,
        (docPath, displayName, clickCoords, refType) => {
          // Convert client coords to editor-relative coords for absolute positioning
          const editorEl = editorRef.current
            ?.getView()
            ?.dom?.closest(".relative");
          const rect = editorEl?.getBoundingClientRect();
          setCreatePopover({
            path: docPath,
            displayName,
            position: {
              top: rect ? clickCoords.y - rect.top : clickCoords.y,
              left: rect ? clickCoords.x - rect.left : clickCoords.x,
            },
            refType,
          });
        },
      ),
    ],
    [handlePillClick, editorRef],
  );

  // Handle wiki-link @-mention selection -> insert @[[path | name]] syntax
  const handleWikiLinkSelect = useCallback(
    (result: MentionResult) => {
      const view = editorRef.current?.getView();
      if (!view || !atMention) return;
      insertWikiLink(
        view,
        atMention.atPos,
        atMention.cursorPos,
        result.path,
        result.name,
      );
      setAtMention(null);
    },
    [atMention, editorRef],
  );

  // Handle creating a document or folder from a broken wiki-link
  const handleCreateFromBrokenLink = useCallback(async () => {
    if (!createPopover) return;
    const projectId = useProjectStore.getState().currentProject()?.id;
    if (!projectId) return;

    setIsCreating(true);
    try {
      if (createPopover.refType === "folder") {
        await useTreeStore
          .getState()
          .createFolderByPath(projectId, createPopover.path);
        setCreatePopover(null);
      } else {
        const wikiPath = createPopover.path;
        const lastSlash = wikiPath.lastIndexOf("/");
        const filename =
          lastSlash >= 0 ? wikiPath.slice(lastSlash + 1) : wikiPath;
        const folderPath =
          lastSlash >= 0 ? wikiPath.slice(0, lastSlash) : undefined;
        const dotIndex = filename.lastIndexOf(".");
        const name = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;
        const extension = dotIndex >= 0 ? filename.slice(dotIndex) : ".md";

        const newDoc = await api.documents.create(
          projectId,
          null,
          name,
          extension,
          { folderPath },
        );

        // Refresh sidebar tree to show the new document (and any created folders)
        await useTreeStore.getState().loadTree(projectId);

        setCreatePopover(null);

        // Navigate to the newly created document
        openDocument(newDoc.id, newDoc.path, projectSlug, navigate);
      }
    } catch (err) {
      log.error("Failed to create from broken wiki-link:", err);
    } finally {
      setIsCreating(false);
    }
  }, [createPopover, projectSlug, navigate]);

  return {
    extensions,
    atMention,
    popoverPosition,
    handleWikiLinkSelect,
    closeAtMention: useCallback(() => setAtMention(null), []),
    createPopover,
    isCreating,
    handleCreateFromBrokenLink,
    closeCreatePopover: useCallback(() => setCreatePopover(null), []),
    folderPopover,
  };
}
