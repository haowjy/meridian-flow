/**
 * The toolbar's link control: the button and the small form it opens.
 *
 * One field over a selection, two fields (text and link) at a bare caret, so
 * creating a link from nothing needs no preconditions (§5.5, law 5). The
 * caret inside an existing link lights the button and pre-fills the form;
 * emptying the URL removes the link. Closing always hands the caret back to
 * the prose — the writer opened this from the middle of a sentence, and the
 * next keystroke belongs to that sentence. Deliberately no Ctrl+K binding:
 * that key belongs to the later link lane, which absorbs this popover.
 *
 * `useLinkDraft` and `LinkForm` are the reusable half: the formatting menu's
 * "Add link" opens the same form at the pointer instead of under a button, and
 * a second copy of the draft lifecycle would be a second answer to "which
 * range does the commit rewrite".
 */
import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { Link as LinkIcon, Unlink } from "lucide-react";
import { type FormEvent, type Ref, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { commitLinkDraft, type LinkDraft, mapLinkDraft, resolveLinkDraft } from "./link-commands";
import { ToolbarButton, ToolbarControlTooltip, toolbarControlClass } from "./ToolbarButton";
import type { ToolbarControlState } from "./toolbar-commands";
import { blockedReasonMessage, toolbarControlLabel } from "./toolbar-copy";

/**
 * The draft an open link form is editing: resolved from the selection the
 * moment the surface opens, and kept pointing at that range afterwards.
 *
 * Both halves matter. Resolving at open time is what lets focus move into the
 * form without losing the words the writer chose; `readDraft` is what the
 * commit reads, because an open form outlives the positions it opened with —
 * a peer types above the selection, an AI write lands — and render state would
 * address whatever slid into their place.
 */
export function useLinkDraft(
  editor: Editor | null,
  open: boolean,
): { draft: LinkDraft | null; readDraft: () => LinkDraft | null } {
  const [draft, setDraft] = useState<LinkDraft | null>(null);
  const draftRef = useRef<LinkDraft | null>(null);

  useEffect(() => {
    if (!open || !editor || editor.isDestroyed) {
      draftRef.current = null;
      setDraft(null);
      return;
    }

    const resolved = resolveLinkDraft(editor);
    draftRef.current = resolved;
    setDraft(resolved);

    const followDocument = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged || !draftRef.current) return;
      draftRef.current = mapLinkDraft(draftRef.current, transaction.mapping);
    };
    editor.on("transaction", followDocument);
    return () => {
      editor.off("transaction", followDocument);
    };
  }, [open, editor]);

  return { draft, readDraft: () => draftRef.current };
}

export function LinkControl({
  editor,
  state,
}: {
  editor: Editor | null;
  state: ToolbarControlState;
}) {
  const [open, setOpen] = useState(false);
  const { draft, readDraft } = useLinkDraft(editor, open);
  const label = toolbarControlLabel("link");
  // Without an editor the matrix already says "still opening"; naming it here
  // is what lets the rest of this component assume one.
  const blockedReason = blockedReasonMessage("link", editor ? state.blockedBy : "editor-loading");

  if (!editor || blockedReason) {
    return (
      <ToolbarButton label={label} blockedReason={blockedReason} active={state.active}>
        <LinkIcon className="size-3.5" aria-hidden />
      </ToolbarButton>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ToolbarControlTooltip label={label}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            aria-pressed={state.active || undefined}
            className={toolbarControlClass({ active: state.active })}
          >
            <LinkIcon className="size-3.5" aria-hidden />
          </Button>
        </PopoverTrigger>
      </ToolbarControlTooltip>
      <PopoverContent
        align="start"
        className="w-80 p-2"
        onCloseAutoFocus={(event) => {
          // Radix would hand focus back to the button, where the next Space
          // reopens the popover the writer just dismissed. The caret is still
          // in the prose; the focus goes with it.
          event.preventDefault();
          if (!editor.isDestroyed) editor.commands.focus();
        }}
      >
        {draft ? (
          <LinkForm
            editor={editor}
            draft={draft}
            readDraft={() => readDraft() ?? draft}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function LinkForm({
  editor,
  draft,
  readDraft,
  onClose,
}: {
  editor: Editor;
  draft: LinkDraft;
  readDraft: () => LinkDraft;
  onClose: () => void;
}) {
  const [text, setText] = useState(draft.text);
  const [href, setHref] = useState(draft.href);
  const [invalid, setInvalid] = useState(false);
  const fieldId = useId();
  const textInputRef = useRef<HTMLInputElement>(null);
  const hrefInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // The first empty field is where the writer has something to say.
    const textInput = textInputRef.current;
    const input = textInput && !textInput.value ? textInput : hrefInputRef.current;
    input?.focus();
    input?.select();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = commitLinkDraft(editor, readDraft(), { text, href });
    if (result === "invalid") {
      setInvalid(true);
      return;
    }
    onClose();
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      {draft.needsText ? (
        <LinkField
          id={`${fieldId}-text`}
          ref={textInputRef}
          label={t`Text`}
          value={text}
          placeholder={t`Link text`}
          onChange={setText}
        />
      ) : null}
      <LinkField
        id={`${fieldId}-href`}
        ref={hrefInputRef}
        label={draft.needsText ? t`Link` : t`Link URL`}
        value={href}
        placeholder={t`Paste a link`}
        inputMode="url"
        invalid={invalid}
        describedBy={invalid ? `${fieldId}-error` : undefined}
        onChange={(next) => {
          setHref(next);
          setInvalid(false);
        }}
      />
      {invalid ? (
        <p id={`${fieldId}-error`} className="text-destructive text-xs" role="alert">
          {t`Enter an http, https, or mailto link.`}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-1.5">
        {draft.existing ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mr-auto"
            onClick={() => {
              commitLinkDraft(editor, readDraft(), { text, href: "" });
              onClose();
            }}
          >
            <Unlink className="size-3.5" aria-hidden />
            {t`Remove link`}
          </Button>
        ) : null}
        <Button type="submit" size="sm">
          {draft.existing ? t`Update link` : t`Add link`}
        </Button>
      </div>
    </form>
  );
}

function LinkField({
  id,
  ref,
  label,
  value,
  placeholder,
  inputMode,
  invalid = false,
  describedBy,
  onChange,
}: {
  id: string;
  ref: Ref<HTMLInputElement>;
  label: string;
  value: string;
  placeholder: string;
  inputMode?: "url";
  invalid?: boolean;
  describedBy?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-meta text-muted-foreground" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        ref={ref}
        type="text"
        className="h-8"
        value={value}
        inputMode={inputMode}
        placeholder={placeholder}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
