import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { Code2, Copy, CopyPlus, Trash2, WrapText } from "lucide-react";
import { useEffect, useState } from "react";

import { diagramProviderForLanguage, EDITOR_DIAGRAM_PROVIDERS } from "@/core/editor/diagrams";
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
import type { ObjectSurfaceTarget } from "./object-anchors";
import { copyText, deleteObject, duplicateObject, setFenceLanguage } from "./object-commands";
import type { RunVerb } from "./verb-feedback";

const PLAIN_LANGUAGE = "plain";

const CODE_LANGUAGE_NAMES: Record<string, string> = {
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

const LANGUAGE_IDS: readonly string[] = [
  PLAIN_LANGUAGE,
  ...EDITOR_DIAGRAM_PROVIDERS.map((provider) => provider.language),
  ...Object.keys(CODE_LANGUAGE_NAMES),
];

export function fenceLanguageLabel(language: unknown): string {
  const id = typeof language === "string" && language ? language : PLAIN_LANGUAGE;
  if (id === PLAIN_LANGUAGE) return t`Plain text`;
  return diagramProviderForLanguage(id)?.name ?? CODE_LANGUAGE_NAMES[id] ?? id;
}

export function fenceLanguage(target: ObjectSurfaceTarget): string {
  const attribute = target.node.attrs.language;
  return typeof attribute === "string" && attribute ? attribute : PLAIN_LANGUAGE;
}

type FenceMenuProps = {
  editor: Editor;
  target: ObjectSurfaceTarget;
};

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

export function FenceMenuItems({
  editor,
  target,
  run,
}: FenceMenuProps & {
  run: RunVerb;
}) {
  const [languageOpen, setLanguageOpen] = useState(false);

  return (
    <>
      <EditorMenuSub open={languageOpen} onOpenChange={setLanguageOpen}>
        <EditorMenuSubTrigger data-fence-submenu="language">
          <Code2 aria-hidden />
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
      <EditorMenuItem onSelect={() => run(copyText(target.node.textContent), "copy")}>
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
