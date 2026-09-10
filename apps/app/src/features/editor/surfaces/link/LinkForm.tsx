/** Destination and display-text editing over the anchored link commands. */

import { t } from "@lingui/core/macro";
import { formatWikilink } from "@meridian/markup";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { Unlink } from "lucide-react";
import {
  type FormEvent,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createDomInputSuggestionTransport,
  createReferenceBrowserController,
} from "@/core/completion";
import {
  classifyLinkTarget,
  commitLinkDraft,
  type LinkDraft,
  type LinkFormRequest,
  type LinkSurface,
  linkInputStepsAsideFromReferences,
  linkTargetLabel,
  mapLinkDraft,
  normalizeLinkHref,
  resolveLinkDraft,
} from "@/core/editor/links";
import { editorSuggestionHost } from "@/core/editor/suggestion-host";
import { EditorPopover } from "@/features/editor/chrome";
import { useEditorScope } from "@/features/editor/editor-scope";
import { useReferenceBrowserCatalog } from "@/features/editor/references/useReferenceBrowserCatalog";
import { ReferenceSuggestionMenu } from "./AtReferenceMenu";
import { useLinkResolution } from "./useLinkResolution";

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
  const [query, setQuery] = useState("");
  const [choosing, setChoosing] = useState(!draft.href);
  const [selectedDestination, setSelectedDestination] = useState<{
    label: string;
    location: string;
  } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [refused, setRefused] = useState(false);
  const resolution = useLinkResolution(editor, href || null);
  const target = classifyLinkTarget(href);
  const destinationLabel =
    selectedDestination?.label ??
    (resolution?.state === "resolved"
      ? resolution.document.title
      : target
        ? linkTargetLabel(target)
        : href);
  const fieldId = useId();
  const textInputRef = useRef<HTMLInputElement>(null);
  const hrefInputRef = useRef<HTMLInputElement>(null);
  const [hrefInput, setHrefInput] = useState<HTMLInputElement | null>(null);
  const attachHrefInput = useCallback((node: HTMLInputElement | null) => {
    hrefInputRef.current = node;
    setHrefInput(node);
  }, []);
  const referenceOwnerId = "link-reference-menu";
  const { projectId, workId } = useEditorScope();
  const referenceCatalog = useReferenceBrowserCatalog(projectId, workId, t`Link a file`);
  const referenceDriver = useMemo(
    () =>
      referenceCatalog
        ? createReferenceBrowserController({
            catalog: referenceCatalog.port,
            openContext: referenceCatalog.openContext,
            label: () => referenceCatalog.label,
            onCompleteSegment: ({ prefix }) => setQuery(prefix),
            onSelect: ({ row }) => {
              setHref(formatWikilink(row.action.reference.uri));
              setSelectedDestination({ label: row.label, location: row.location });
              setText((current) => current || row.label);
              setChoosing(false);
              setInvalid(false);
              textInputRef.current?.focus();
            },
          })
        : null,
    [referenceCatalog],
  );

  useEffect(() => {
    const input = hrefInput;
    const host = editorSuggestionHost(editor, "chrome");
    if (!input || !host || !referenceDriver) return;
    const transport = createDomInputSuggestionTransport({
      input,
      driver: referenceDriver,
      suggestionHost: host,
      hostLeaseId: referenceOwnerId,
      match: ({ value, selection }) => {
        if (selection.from !== selection.to || selection.to !== value.length) return null;
        if (linkInputStepsAsideFromReferences(value)) return null;
        return { query: value, text: value, triggerRange: { from: 0, to: value.length } };
      },
    });
    transport.sync();
    return transport.destroy;
  }, [editor, hrefInput, referenceDriver]);

  useEffect(() => {
    hrefInput?.focus();
  }, [hrefInput]);

  useEffect(() => {
    const input = hrefInputRef.current;
    if (!input || document.activeElement !== input) return;
    input.setSelectionRange(query.length, query.length);
    input.dispatchEvent(new Event("select"));
  }, [query]);

  useEffect(() => {
    // The first empty field is where the writer has something to say.
    const textInput = textInputRef.current;
    const input = hrefInputRef.current ?? textInput;
    input?.focus();
    input?.select();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const address = choosing ? query.trim() : href;
    // Search words are not destinations. Explicit pasted addresses still use the core normalizer.
    if (
      choosing &&
      !(
        linkInputStepsAsideFromReferences(address) ||
        /[./]/.test(address) ||
        address.startsWith("[[")
      )
    ) {
      setInvalid(true);
      return;
    }
    const normalized = normalizeLinkHref(address);
    if (!normalized) {
      setInvalid(true);
      return;
    }
    const destination = classifyLinkTarget(normalized);
    const result = commitLinkDraft(editor, readDraft(), {
      text,
      href: destination?.kind === "scheme" ? formatWikilink(destination.uri) : normalized,
    });
    if (result === "invalid") {
      setInvalid(true);
      return;
    }
    if (result === "refused") {
      setRefused(true);
      return;
    }
    onClose();
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <LinkField
        id={`${fieldId}-text`}
        ref={textInputRef}
        label={t`Display text`}
        value={text}
        placeholder={t`Link text`}
        onChange={setText}
      />
      {choosing ? (
        <LinkField
          id={`${fieldId}-href`}
          ref={attachHrefInput}
          label={t`Destination`}
          value={query}
          placeholder={t`Search documents or paste a web link`}
          inputMode="url"
          invalid={invalid}
          describedBy={invalid ? `${fieldId}-error` : undefined}
          onChange={(next) => {
            setQuery(next);
            setInvalid(false);
          }}
        />
      ) : (
        <div className="flex flex-col gap-1">
          <span className="text-meta text-muted-foreground">{t`Destination`}</span>
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 break-words">{destinationLabel}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setQuery(target?.kind === "external" ? href : "");
                setChoosing(true);
              }}
            >{t`Change`}</Button>
          </div>
          {selectedDestination || resolution?.state === "resolved" ? (
            <span className="text-xs text-muted-foreground">
              {selectedDestination?.location ??
                (resolution?.state === "resolved" ? resolution.document.path : "")}
            </span>
          ) : null}
          {resolution?.state === "unresolved" ? (
            <span className="text-xs text-muted-foreground">{t`No document with this name yet`}</span>
          ) : null}
        </div>
      )}
      {refused ? (
        <p
          role="alert"
          className="text-destructive text-xs"
        >{t`This link can no longer be edited. Close the form and try again.`}</p>
      ) : null}
      {invalid ? (
        <p id={`${fieldId}-error`} className="text-destructive text-xs" role="alert">
          {t`Choose a document or enter a web address or document path.`}
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
              const result = commitLinkDraft(editor, readDraft(), { text, href: "" });
              if (result === "refused") setRefused(true);
              else onClose();
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
          {t`Save link`}
        </Button>
      </div>
      {referenceDriver && hrefInput ? (
        <ReferenceSuggestionMenu
          editor={editor}
          menu={referenceDriver.menu}
          ownerId={referenceOwnerId}
          typingElement={hrefInput}
        />
      ) : null}
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
