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
 * geometry rather than growing a contextual segment.
 *
 * Every control here is the dense `xs` size, including the language: the
 * cluster may not stand taller than one line of the code it decorates (see
 * overlay-icon-row.css), and the label is what drives that height.
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { ChevronDown, Copy, CopyPlus, MoreVertical, Trash2, WrapText } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { editorChromeAttributes } from "@/core/editor/chrome";
import {
  EditorMenu,
  EditorMenuCheckboxItem,
  EditorMenuItem,
  EditorMenuRadioGroup,
  EditorMenuRadioItem,
  EditorMenuSeparator,
  objectOverlayStyle,
  useAnchorRect,
  useChromeSuppressed,
  useEditorChrome,
} from "@/features/editor/chrome";
import type { RunVerb } from "./ObjectControls";
import type { ObjectSurfaceTarget } from "./object-anchors";
import { copyText, deleteObject, duplicateObject, setFenceLanguage } from "./object-commands";

const PLAIN_LANGUAGE = "plain";

/**
 * The languages a fiction writer's manuscript actually carries, plus mermaid
 * as the door into a diagram. A full lowlight roster would be a scrolling list
 * of grammars nobody in this product writes.
 *
 * Only `plain` is translated: the rest are the names of the languages
 * themselves, which do not change with the reader.
 */
const LANGUAGE_IDS = [
  PLAIN_LANGUAGE,
  "mermaid",
  "bash",
  "css",
  "diff",
  "json",
  "markdown",
  "python",
  "sql",
  "typescript",
  "yaml",
] as const;

const PROPER_NAMES: Record<string, string> = {
  mermaid: "Mermaid",
  bash: "Bash",
  css: "CSS",
  diff: "Diff",
  json: "JSON",
  markdown: "Markdown",
  python: "Python",
  sql: "SQL",
  typescript: "TypeScript",
  yaml: "YAML",
};

function languageLabel(language: unknown): string {
  const id = typeof language === "string" && language ? language : PLAIN_LANGUAGE;
  return id === PLAIN_LANGUAGE ? t`Plain text` : (PROPER_NAMES[id] ?? id);
}

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
  const rect = useAnchorRect(target.element);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const wrapped = useWrappedLines(target.element);

  useEffect(() => {
    onMenuOpenChange(languageOpen || overflowOpen);
  }, [languageOpen, overflowOpen, onMenuOpenChange]);

  if (!rect || !chrome || typeof document === "undefined") return null;

  const language =
    typeof target.node.attrs.language === "string" && target.node.attrs.language
      ? target.node.attrs.language
      : PLAIN_LANGUAGE;

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the mousedown only keeps the caret where it was; every control inside is a button
    <div
      className="meridian-object-overlay meridian-code-chips"
      data-code-chips=""
      data-state={visible && !suppressed ? "open" : "closed"}
      // Right-clicks on chrome route through the claim ladder like right-clicks
      // on the block itself, rather than falling through to the browser. The
      // mark carries the kernel's id, so two editors on one page never claim
      // each other's overlays.
      {...editorChromeAttributes(chrome)}
      style={objectOverlayStyle(rect)}
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
            {languageLabel(language)}
            <ChevronDown aria-hidden />
          </Button>
        }
      >
        <EditorMenuRadioGroup
          value={language}
          onValueChange={(next) =>
            setFenceLanguage(editor, target.pos, next === PLAIN_LANGUAGE ? "" : next)
          }
        >
          {LANGUAGE_IDS.map((id) => (
            <EditorMenuRadioItem key={id} value={id}>
              {languageLabel(id)}
            </EditorMenuRadioItem>
          ))}
        </EditorMenuRadioGroup>
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
        <EditorMenuCheckboxItem
          checked={wrapped}
          onCheckedChange={(next) => setWrappedLines(target.element, next)}
        >
          <WrapText aria-hidden />
          {t`Wrap lines`}
        </EditorMenuCheckboxItem>
        <EditorMenuSeparator />
        <EditorMenuItem onSelect={() => duplicateObject(editor, target.pos)}>
          <CopyPlus aria-hidden />
          {t`Duplicate`}
        </EditorMenuItem>
        <EditorMenuItem variant="destructive" onSelect={() => deleteObject(editor, target.pos)}>
          <Trash2 aria-hidden />
          {t`Delete`}
        </EditorMenuItem>
      </EditorMenu>
    </div>,
    // Portalled for the same reason the object rows are: a fixed element inside
    // a transformed ancestor is positioned against that ancestor, not the
    // viewport, and the manuscript column is not promised to stay untransformed.
    document.body,
  );
}

/**
 * Line wrapping is view state on the element, not an attribute in the
 * document: how a writer chooses to read one fence on one screen is nobody
 * else's business, least of all a collaborator's. It lives exactly as long as
 * the rendered block does, which is the same lifetime the diagram viewer's pan
 * and zoom get.
 */
function useWrappedLines(element: HTMLElement): boolean {
  const [wrapped, setWrapped] = useState(element.dataset.wrap === "on");

  useEffect(() => {
    setWrapped(element.dataset.wrap === "on");
  }, [element]);

  useEffect(() => {
    const observer = new MutationObserver(() => setWrapped(element.dataset.wrap === "on"));
    observer.observe(element, { attributeFilter: ["data-wrap"] });
    return () => observer.disconnect();
  }, [element]);

  return wrapped;
}

function setWrappedLines(element: HTMLElement, wrapped: boolean): void {
  if (wrapped) element.dataset.wrap = "on";
  else delete element.dataset.wrap;
}
