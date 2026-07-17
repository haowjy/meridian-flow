/** Code-block language picker and Mermaid edit/preview control. */
import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { common } from "lowlight";
import { Check, Code2, Eye } from "lucide-react";
import { type KeyboardEvent, useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  codeBlockLanguagesEncountered,
  isMermaidPreviewRequested,
  setMermaidPreviewRequested,
} from "@/core/editor/MermaidCodeBlock";
import { cn } from "@/lib/utils";
import type { BubbleContext, BubbleMatch } from "./EditorBubbleHost";

export const COMMON_CODE_LANGUAGES = Object.keys(common).sort((left, right) =>
  left.localeCompare(right),
);

type CodeBubbleData = {
  language: string;
  preview: boolean;
  encounteredLanguages: readonly string[];
};
type LanguageOption = { value: string; label: string };

export function codeLanguageOptions(
  currentLanguage: string,
  encounteredLanguages: readonly string[],
  plainTextLabel: string,
): LanguageOption[] {
  const options = COMMON_CODE_LANGUAGES.map((language) => ({ value: language, label: language }));
  const customLanguages = new Set(
    [currentLanguage, ...encounteredLanguages].filter(
      (language) => language && !COMMON_CODE_LANGUAGES.includes(language),
    ),
  );
  for (const language of [...customLanguages].reverse()) {
    options.unshift({ value: language, label: language });
  }
  return [{ value: "", label: plainTextLabel }, ...options];
}

export function filterCodeLanguages(
  options: readonly LanguageOption[],
  query: string,
): LanguageOption[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...options];
  return options.filter(
    ({ label, value }) =>
      label.toLocaleLowerCase().includes(needle) || value.toLocaleLowerCase().includes(needle),
  );
}

export function matchCodeBlock(editor: Editor): BubbleMatch | null {
  if (!editor.isEditable || !editor.state.selection.empty) return null;
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== "code_block") continue;
    const nodePos = $from.before(depth);
    return {
      from: nodePos + 1,
      to: nodePos + node.nodeSize - 1,
      nodePos,
      identity: node,
      data: {
        language: typeof node.attrs.language === "string" ? node.attrs.language : "",
        preview: isMermaidPreviewRequested(editor, nodePos),
        encounteredLanguages: codeBlockLanguagesEncountered(editor, nodePos),
      } satisfies CodeBubbleData,
    };
  }
  return null;
}

export const codeBubbleContext: BubbleContext = {
  id: "code",
  anchor: "node-top",
  accessibleName: () => t`Code block options`,
  match: matchCodeBlock,
  Component: CodeBubble,
};

function CodeBubble({ editor, match }: { editor: Editor; match: BubbleMatch }) {
  const data = match.data as CodeBubbleData;
  const nodePos = match.nodePos;
  const [query, setQuery] = useState(data.language);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const plainText = t`Plain text`;
  const options = useMemo(
    () => codeLanguageOptions(data.language, data.encounteredLanguages, plainText),
    [data.encounteredLanguages, data.language, plainText],
  );
  const filtered = filterCodeLanguages(options, query);

  const setLanguage = (language: string) => {
    if (nodePos === undefined || !editor.isEditable) return;
    const node = editor.state.doc.nodeAt(nodePos);
    if (node?.type.name !== "code_block") return;
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(nodePos, undefined, {
        ...node.attrs,
        language: language || null,
      }),
    );
    if (language !== "mermaid") setMermaidPreviewRequested(editor, nodePos, false);
    setQuery(language);
    setOpen(false);
    editor.commands.focus();
  };

  const commitQuery = () => {
    const exact = options.find(
      ({ label, value }) =>
        label.toLocaleLowerCase() === query.trim().toLocaleLowerCase() || value === query.trim(),
    );
    setLanguage(exact?.value ?? query.trim());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitQuery();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      setQuery(data.language);
      setOpen(false);
      editor.commands.focus();
    }
  };

  return (
    <div className="flex items-start gap-1.5 p-2">
      <div className="relative w-52">
        <label className="visually-hidden" htmlFor={`${listId}-input`}>
          {t`Code language`}
        </label>
        <input
          id={`${listId}-input`}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          value={query}
          placeholder={plainText}
          className="h-8 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        {open ? (
          <div
            id={listId}
            role="listbox"
            data-editor-bubble-focus-scope
            className="absolute top-9 z-50 max-h-64 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {filtered.length ? (
              filtered.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === data.language}
                  className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setLanguage(option.value)}
                >
                  <Check
                    className={cn("mr-2 size-3.5", option.value !== data.language && "invisible")}
                    aria-hidden
                  />
                  {option.label}
                </button>
              ))
            ) : (
              <p className="px-2 py-1.5 text-muted-foreground text-sm">{t`Press Enter to use this language`}</p>
            )}
          </div>
        ) : null}
      </div>
      {data.language === "mermaid" && nodePos !== undefined ? (
        <fieldset className="flex rounded-md border p-0.5">
          <legend className="visually-hidden">{t`Diagram view`}</legend>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2"
            aria-pressed={!data.preview}
            onClick={() => setMermaidPreviewRequested(editor, nodePos, false)}
          >
            <Code2 className="size-3.5" aria-hidden />
            {t`Edit`}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2"
            aria-pressed={data.preview}
            onClick={() => setMermaidPreviewRequested(editor, nodePos, true)}
          >
            <Eye className="size-3.5" aria-hidden />
            {t`Preview`}
          </Button>
        </fieldset>
      ) : null}
    </div>
  );
}
