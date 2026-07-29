/**
 * The code block's chip cluster — `[language ▾ | copy | ⋮]` inside the block's
 * top-right bounds (ruling 15, `refs/notion-code-block.png`).
 *
 * A code block is the partial exception to object physics: its rendering IS its
 * source, so a click places a caret and there is no hidden mode to fall into.
 * Its controls follow the same inside-corner physics as the object rows, but
 * they are one cluster rather than separate chips: the language is a labeled
 * control, and a labeled control standing alone over code would read as part of
 * the code.
 *
 * The block's own context surface, so no prose formatting verb appears here
 * (law 4): the caret is in code, and the persistent toolbar keeps its own fixed
 * geometry rather than growing a contextual segment. A right-click inside the
 * fence reaches the same verbs as one list — both doors read
 * [`fence-menu-items.tsx`](./fence-menu-items.tsx).
 *
 * Every control here is the dense `xs` size, including the language: the
 * cluster may not stand taller than one line of the code it decorates (see
 * overlay-icon-row.css), and the label is what drives that height.
 *
 * It is rendered INSIDE the fence's own node view, so a scroll or a reflow
 * moves the cluster and the code as one piece rather than as a rect and a
 * chaser (`chrome/object-overlay.ts`).
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { ChevronDown, Copy, MoreVertical } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { editorChromeAttributes } from "@/core/editor/chrome";
import {
  EditorMenu,
  useChromeSuppressed,
  useEditorChrome,
  useObjectOverlayCorner,
} from "@/features/editor/chrome";
import {
  FenceLanguageItems,
  FenceShapeItems,
  fenceLanguage,
  fenceLanguageLabel,
} from "./fence-menu-items";
import type { ObjectSurfaceTarget } from "./object-anchors";
import { copyText } from "./object-commands";
import type { RunVerb } from "./verb-feedback";

export type CodeBlockChipsProps = {
  editor: Editor;
  target: ObjectSurfaceTarget;
  visible: boolean;
  /** Raised while a menu here is open, so the cluster holds its ground. */
  onMenuOpenChange: (open: boolean) => void;
  /** Copy reaches a clipboard the browser can refuse; the answer comes back. */
  run: RunVerb;
};

export function CodeBlockChips({
  editor,
  target,
  visible,
  onMenuOpenChange,
  run,
}: CodeBlockChipsProps) {
  const chrome = useEditorChrome(editor);
  const suppressed = useChromeSuppressed(editor);
  const placement = useObjectOverlayCorner(editor, { inside: target.container });
  const [languageOpen, setLanguageOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);

  useEffect(() => {
    onMenuOpenChange(languageOpen || overflowOpen);
  }, [languageOpen, overflowOpen, onMenuOpenChange]);

  if (!placement || !chrome) return null;

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the mousedown only keeps the caret where it was; every control inside is a button
    <div
      className="meridian-object-overlay meridian-code-chips"
      data-code-chips=""
      data-state={visible && !suppressed ? "open" : "closed"}
      data-placement={placement.placement}
      // Chrome, never text ProseMirror owns: the cluster lives inside the
      // fence's own node view so it travels with it.
      contentEditable={false}
      // Right-clicks on chrome route through the claim ladder like right-clicks
      // on the block itself, rather than falling through to the browser. The
      // mark carries the kernel's id, so two editors on one page never claim
      // each other's overlays.
      {...editorChromeAttributes(chrome)}
      style={placement.style}
      // A press on the cluster must not move the caret out of the block the
      // cluster belongs to.
      onMouseDown={(event) => event.preventDefault()}
    >
      <EditorMenu
        editor={editor}
        id="code-language"
        open={languageOpen}
        onOpenChange={setLanguageOpen}
        align="end"
        trigger={
          <Button type="button" size="xs" variant="ghost" className="meridian-code-chip-language">
            {fenceLanguageLabel(fenceLanguage(target))}
            <ChevronDown aria-hidden />
          </Button>
        }
      >
        <FenceLanguageItems editor={editor} target={target} />
      </EditorMenu>

      <span className="meridian-code-chip-divider" aria-hidden />

      <IconButton
        type="button"
        size="xs"
        variant="ghost"
        aria-label={t`Copy code`}
        onClick={() => run(copyText(target.node.textContent), t`Code copied`)}
      >
        <Copy aria-hidden />
      </IconButton>

      <EditorMenu
        editor={editor}
        id="code-overflow"
        open={overflowOpen}
        onOpenChange={setOverflowOpen}
        align="end"
        trigger={
          <IconButton type="button" size="xs" variant="ghost" aria-label={t`More`}>
            <MoreVertical aria-hidden />
          </IconButton>
        }
      >
        <FenceShapeItems editor={editor} target={target} />
      </EditorMenu>
    </div>,
    placement.container,
  );
}
