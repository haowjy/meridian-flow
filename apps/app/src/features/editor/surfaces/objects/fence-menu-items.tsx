/**
 * What a code fence offers, in one place for its two doors.
 *
 * The chip cluster spreads the same verbs across three controls — a labeled
 * language button, a copy icon, and a ⋮ — because a fence's language is worth
 * a label of its own in the corner (ruling 15). A right-click has one list to
 * put them in, so it nests the language and keeps the rest flat. Same verbs,
 * same wording, same commands: a second copy of them would be two answers
 * within a week.
 *
 * Line wrapping is view state on the element rather than an attribute in the
 * document: how a writer chooses to read one fence on one screen is nobody
 * else's business, least of all a collaborator's. It lives exactly as long as
 * the rendered block does.
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { ChevronDown, Copy, CopyPlus, Trash2, WrapText } from "lucide-react";
import { useEffect, useState } from "react";

import {
  EditorMenuCheckboxItem,
  EditorMenuItem,
  EditorMenuRadioGroup,
  EditorMenuRadioItem,
  EditorMenuSeparator,
  EditorMenuSub,
  EditorMenuSubContent,
  EditorMenuSubTrigger,
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

export function fenceLanguageLabel(language: unknown): string {
  const id = typeof language === "string" && language ? language : PLAIN_LANGUAGE;
  return id === PLAIN_LANGUAGE ? t`Plain text` : (PROPER_NAMES[id] ?? id);
}

/** The language the fence carries now, spelled the way the menu spells it. */
export function fenceLanguage(target: ObjectSurfaceTarget): string {
  const attribute = target.node.attrs.language;
  return typeof attribute === "string" && attribute ? attribute : PLAIN_LANGUAGE;
}

type FenceMenuProps = {
  editor: Editor;
  target: ObjectSurfaceTarget;
};

/** The language list, radio-grouped: a fence has exactly one. */
export function FenceLanguageItems({ editor, target }: FenceMenuProps) {
  return (
    <EditorMenuRadioGroup
      value={fenceLanguage(target)}
      onValueChange={(next) =>
        setFenceLanguage(editor, target.pos, next === PLAIN_LANGUAGE ? "" : next)
      }
    >
      {LANGUAGE_IDS.map((id) => (
        <EditorMenuRadioItem key={id} value={id}>
          {fenceLanguageLabel(id)}
        </EditorMenuRadioItem>
      ))}
    </EditorMenuRadioGroup>
  );
}

/** What the ⋮ holds: how the fence reads, and what becomes of it. */
export function FenceShapeItems({ editor, target }: FenceMenuProps) {
  const wrapped = useWrappedLines(target.element);

  return (
    <>
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
    </>
  );
}

/**
 * The whole fence in one list, for the right-click at a caret inside it. The
 * language nests because it is eleven rows; everything else stays flat, in the
 * order the cluster reads left to right.
 */
export function FenceMenuItems({
  editor,
  target,
  run,
}: FenceMenuProps & {
  /** Copy reaches a clipboard the browser can refuse; the answer comes back. */
  run: RunVerb;
}) {
  const [languageOpen, setLanguageOpen] = useState(false);

  return (
    <>
      <EditorMenuSub open={languageOpen} onOpenChange={setLanguageOpen}>
        <EditorMenuSubTrigger data-fence-submenu="language">
          <ChevronDown aria-hidden />
          {t`Language`}
        </EditorMenuSubTrigger>
        <EditorMenuSubContent
          className="min-w-44"
          // Radix answers Escape inside a submenu by closing the whole menu,
          // which spends two steps of the walk home on one key (law 3).
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            setLanguageOpen(false);
          }}
        >
          <FenceLanguageItems editor={editor} target={target} />
        </EditorMenuSubContent>
      </EditorMenuSub>
      <EditorMenuItem onSelect={() => run(copyText(target.node.textContent), t`Code copied`)}>
        <Copy aria-hidden />
        {t`Copy code`}
      </EditorMenuItem>
      <EditorMenuSeparator />
      <FenceShapeItems editor={editor} target={target} />
    </>
  );
}

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
