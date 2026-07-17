/** Link bubble registration, content, and fixed-toolbar entry point. */
import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { ExternalLink, Link, Unlink } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type BubbleContext, type BubbleMatch, useEditorBubble } from "./EditorBubbleHost";
import { linkAttributesAtSelection } from "./link-selection";
import { normalizeLinkHref } from "./link-url";

type LinkBubbleData = { attributes: Record<string, unknown> | null };

export const linkBubbleContext: BubbleContext = {
  id: "link",
  anchor: "selection",
  match(editor) {
    const { from, to, empty } = editor.state.selection;
    const attributes = linkAttributesAtSelection(editor);
    if (empty && !attributes) return null;
    return { from, to, data: { attributes } satisfies LinkBubbleData };
  },
  Component: LinkBubble,
};

export function LinkToolbarButton({
  editor,
  bubbleOpen,
  bubbleId,
  onOpen,
}: {
  editor: Editor | null;
  bubbleOpen: boolean;
  bubbleId: string;
  onOpen: () => void;
}) {
  const active = Boolean(editor && linkAttributesAtSelection(editor));
  const canOpen = Boolean(editor && (!editor.state.selection.empty || active));

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={t`Link`}
      aria-pressed={active || undefined}
      aria-haspopup="dialog"
      aria-expanded={bubbleOpen}
      aria-controls={bubbleId}
      data-state={bubbleOpen ? "open" : "closed"}
      disabled={!canOpen}
      onClick={onOpen}
      className={active ? "bg-primary/10 text-primary hover:text-primary" : undefined}
    >
      <Link className="size-3.5" aria-hidden />
    </Button>
  );
}

function LinkBubble({ editor, match }: { editor: Editor; match: BubbleMatch }) {
  const data = match.data as LinkBubbleData;
  const existingAttributes = data.attributes;
  const existingHref = normalizeLinkHref(String(existingAttributes?.href ?? ""));
  const [href, setHref] = useState(String(existingAttributes?.href ?? ""));
  const [invalid, setInvalid] = useState(false);
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const { close } = useEditorBubble();

  const removeLink = () => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    close();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedHref = normalizeLinkHref(href);

    if (!href.trim() && existingAttributes) {
      removeLink();
      return;
    }
    if (!normalizedHref) {
      setInvalid(true);
      return;
    }

    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: normalizedHref, title: null })
      .run();
    close();
  };

  return (
    <form className="flex w-80 items-start gap-1.5 p-2" onSubmit={submit}>
      <div className="min-w-0 flex-1">
        <label className="visually-hidden" htmlFor={inputId}>
          {t`Link URL`}
        </label>
        <Input
          data-bubble-autofocus
          id={inputId}
          type="text"
          inputMode="url"
          value={href}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          placeholder={t`Paste or type a link`}
          className="h-8"
          onChange={(event) => {
            setHref(event.target.value);
            setInvalid(false);
          }}
        />
        {invalid ? (
          <p id={errorId} className="px-1 pt-1 text-destructive text-xs" role="alert">
            {t`Enter an http, https, or mailto link.`}
          </p>
        ) : null}
      </div>
      <Button type="submit" size="sm" className="h-8">
        {existingAttributes ? t`Update link` : t`Add link`}
      </Button>
      {existingHref ? (
        <Button asChild variant="ghost" size="icon-sm" className="size-8">
          <a
            href={existingHref}
            target="_blank"
            rel="noreferrer"
            aria-label={t`Open link`}
            onClick={() => close()}
          >
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </Button>
      ) : null}
      {existingAttributes ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-8"
          aria-label={t`Remove link`}
          onClick={removeLink}
        >
          <Unlink className="size-3.5" aria-hidden />
        </Button>
      ) : null}
    </form>
  );
}
