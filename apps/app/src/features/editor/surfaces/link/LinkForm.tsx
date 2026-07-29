/**
 * The link form: Ctrl+K, the toolbar's Link button, and the menu's Edit link
 * all open this one surface.
 *
 * Law 5, literally: it has no preconditions and refuses nothing. Over a
 * selection it asks for a URL; at a bare caret it asks for text and a URL and
 * inserts a finished link; inside an existing link it arrives pre-filled and
 * an emptied URL removes the link. Every internal spelling is typeable here
 * — a `[[document name]]`, a `manuscript://` URI, a relative path — because
 * the classifier behind the field knows all of them.
 *
 * It hangs at the caret rather than at whatever control opened it: the writer
 * is looking at their own sentence, and the form belongs beside the words it
 * is about (mockup 06 state E).
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { Unlink } from "lucide-react";
import { type FormEvent, type Ref, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  commitLinkDraft,
  type LinkDraft,
  type LinkFormRequest,
  type LinkSurface,
  mapLinkDraft,
  resolveLinkDraft,
} from "@/core/editor/links";
import { EditorPopover } from "@/features/editor/chrome";

export function LinkForm({
  editor,
  surface,
  form,
}: {
  editor: Editor;
  surface: LinkSurface;
  form: LinkFormRequest;
}) {
  // Resolved once, at open: focus moves into the form, and the commit must
  // rewrite the range the writer was looking at, not wherever focus went.
  const [draft] = useState(() => resolveLinkDraft(editor));
  // The commit reads the range from here, never from render state: an open
  // form outlives the positions it was opened with.
  const draftRef = useRef(draft);
  const close = surface.closeForm;

  useEffect(() => {
    const followDocument = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged) return;
      const moved = mapLinkDraft(editor.state, draftRef.current, transaction.mapping);
      draftRef.current = moved ?? draftRef.current;
      // The words this form was opened for are gone. Committing would write
      // the writer's link into whatever a peer put in their place.
      if (!moved) close();
    };
    editor.on("transaction", followDocument);
    return () => {
      editor.off("transaction", followDocument);
    };
  }, [editor, close]);

  return (
    <EditorPopover
      editor={editor}
      id="link-form"
      // Keyed on the open, not the point: floating-ui never sees a fixed
      // anchor move, so a second Ctrl+K at the same caret must remount.
      key={form.seq}
      at={form.at}
      open
      onOpenChange={(next) => {
        if (!next) surface.closeForm();
      }}
      className="w-80 p-3"
    >
      <LinkFields
        editor={editor}
        draft={draft}
        readDraft={() => draftRef.current}
        onClose={() => surface.closeForm()}
      />
    </EditorPopover>
  );
}

function LinkFields({
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
        label={t`Link`}
        value={href}
        placeholder={t`Paste a link or type [[a document name]]`}
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
          {t`Try a web address, a document path, or [[a document name]].`}
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
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t`Cancel`}
        </Button>
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
