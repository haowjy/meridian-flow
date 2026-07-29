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
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { Check, ChevronDown, Copy, CopyPlus, MoreVertical, Trash2, WrapText } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { EDITOR_CHROME_ATTRIBUTE } from "@/core/editor/chrome";
import {
  EditorMenu,
  EditorMenuCheckboxItem,
  EditorMenuItem,
  EditorMenuRadioGroup,
  EditorMenuRadioItem,
  EditorMenuSeparator,
  useAnchorRect,
  useChromeSuppressed,
} from "@/features/editor/chrome";

import type { ObjectSurfaceTarget } from "./object-anchors";
import { copyText, deleteObject, duplicateObject, setFenceLanguage } from "./object-commands";

/** Matches the object row's inset, so the two surfaces sit on one line. */
const OVERLAY_INSET_PX = 10;

const PLAIN_LANGUAGE = "plain";
const COPIED_RESET_MS = 1500;

/**
 * The languages a fiction writer's manuscript actually carries, plus mermaid
 * as the door into a diagram. A full lowlight roster would be a scrolling list
 * of grammars nobody in this product writes.
 */
const LANGUAGES: ReadonlyArray<{ id: string; label: string }> = [
  { id: PLAIN_LANGUAGE, label: "Plain text" },
  { id: "mermaid", label: "Mermaid" },
  { id: "bash", label: "Bash" },
  { id: "css", label: "CSS" },
  { id: "diff", label: "Diff" },
  { id: "json", label: "JSON" },
  { id: "markdown", label: "Markdown" },
  { id: "python", label: "Python" },
  { id: "sql", label: "SQL" },
  { id: "typescript", label: "TypeScript" },
  { id: "yaml", label: "YAML" },
];

function languageLabel(language: unknown): string {
  const id = typeof language === "string" && language ? language : PLAIN_LANGUAGE;
  return LANGUAGES.find((entry) => entry.id === id)?.label ?? id;
}

export type CodeBlockChipsProps = {
  editor: Editor;
  target: ObjectSurfaceTarget;
  visible: boolean;
  /** Raised while a menu here is open, so the cluster holds its ground. */
  onMenuOpenChange: (open: boolean) => void;
};

export function CodeBlockChips({ editor, target, visible, onMenuOpenChange }: CodeBlockChipsProps) {
  const suppressed = useChromeSuppressed(editor);
  const rect = useAnchorRect(target.element);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapped = useWrappedLines(target.element);

  useEffect(() => {
    onMenuOpenChange(languageOpen || overflowOpen);
  }, [languageOpen, overflowOpen, onMenuOpenChange]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!rect || typeof document === "undefined") return null;

  const language =
    typeof target.node.attrs.language === "string" && target.node.attrs.language
      ? target.node.attrs.language
      : PLAIN_LANGUAGE;

  const copy = () => {
    void copyText(target.node.textContent).then(() => setCopied(true));
  };

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the mousedown only keeps the caret where it was; every control inside is a button
    <div
      className="meridian-code-chips"
      data-code-chips=""
      data-state={visible && !suppressed ? "open" : "closed"}
      // Right-clicks on chrome route through the claim ladder like right-clicks
      // on the block itself, rather than falling through to the browser.
      {...{ [EDITOR_CHROME_ATTRIBUTE]: "" }}
      style={{ top: rect.top + OVERLAY_INSET_PX, left: rect.right - OVERLAY_INSET_PX }}
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
          <Button type="button" size="sm" variant="ghost" className="meridian-code-chip-language">
            {languageLabel(language)}
            <ChevronDown className="size-3" aria-hidden />
          </Button>
        }
      >
        <EditorMenuRadioGroup
          value={language}
          onValueChange={(next) =>
            setFenceLanguage(editor, target.pos, next === PLAIN_LANGUAGE ? "" : next)
          }
        >
          {LANGUAGES.map((entry) => (
            <EditorMenuRadioItem key={entry.id} value={entry.id}>
              {entry.label}
            </EditorMenuRadioItem>
          ))}
        </EditorMenuRadioGroup>
      </EditorMenu>

      <span className="meridian-code-chip-divider" aria-hidden />

      <IconButton
        type="button"
        size="sm"
        variant="ghost"
        aria-label={copied ? t`Copied` : t`Copy code`}
        onClick={copy}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </IconButton>

      <EditorMenu
        editor={editor}
        id="code-overflow"
        open={overflowOpen}
        onOpenChange={setOverflowOpen}
        align="end"
        trigger={
          <IconButton type="button" size="sm" variant="ghost" aria-label={t`More`}>
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
