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
 * Typing in the href field also offers the project's documents, over the same
 * engine as `[[` and `@` — select text, Mod-K, three letters, Enter. The offer
 * steps aside the moment the writer unambiguously starts a URL, and a pick
 * fills the document's canonical URI; the mechanics live in
 * [`useHrefReferences`](./useHrefReferences.ts).
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

import {
  SUGGESTION_MENU_SHELL,
  SuggestionList,
  suggestionOptionId,
} from "@/components/app/SuggestionList";
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
import { cn } from "@/lib/utils";

import { ReferenceRow } from "./reference-rows";
import { type HrefReferences, useHrefReferences } from "./useHrefReferences";

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

  const references = useHrefReferences({
    editor,
    inputRef: hrefInputRef,
    onFill: (uri) => {
      setHref(uri);
      setInvalid(false);
    },
  });
  const menuId = `${fieldId}-references`;

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
      <div className="relative">
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
            references.sync(next);
          }}
          // A field the writer left has no menu. The rows cancel their own
          // mousedown, so choosing one never reaches this.
          onBlur={references.close}
          listbox={{ id: menuId, references }}
        />
        <HrefReferenceMenu id={menuId} references={references} />
      </div>
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

/**
 * The rows under the href field. Anchored by layout rather than by a popper:
 * the field cannot move relative to the form, and a second Radix surface here
 * would be a portal the form's own dismissal listeners read as outside.
 */
function HrefReferenceMenu({ id, references }: { id: string; references: HrefReferences }) {
  const { menu, snapshot } = references;
  if (!snapshot.open) return null;

  return (
    <div
      className={cn(
        SUGGESTION_MENU_SHELL,
        "absolute inset-x-0 top-full z-50 mt-1 rounded-md border bg-popover text-popover-foreground shadow-md",
      )}
      // The shell's own cap reads a popper variable that measured the form,
      // not this dropdown; the list inside caps itself near eight rows.
      style={{ maxHeight: "20rem" }}
    >
      <SuggestionList
        id={id}
        label={snapshot.label}
        activeIndex={snapshot.activeIndex}
        onActivate={(index) => menu.setActiveIndex(index)}
        onChoose={(index) => menu.choose(index)}
        rows={snapshot.items.map((item) => ({
          key: item.key,
          content: <ReferenceRow item={item} />,
        }))}
      />
    </div>
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
  onBlur,
  listbox,
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
  onBlur?: () => void;
  /** The completion offer under this field, when it has one. */
  listbox?: { id: string; references: HrefReferences };
}) {
  const open = listbox?.references.snapshot.open ?? false;
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
        aria-expanded={open || undefined}
        aria-controls={open && listbox ? listbox.id : undefined}
        aria-activedescendant={listbox ? activeOptionId(listbox.id, listbox.references) : undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
    </div>
  );
}

/** The highlighted row's option id, for a screen reader to say out loud. */
function activeOptionId(menuId: string, references: HrefReferences): string | undefined {
  const { open, items, activeIndex } = references.snapshot;
  const active = open ? items[activeIndex] : undefined;
  return active ? suggestionOptionId(menuId, active.key) : undefined;
}
