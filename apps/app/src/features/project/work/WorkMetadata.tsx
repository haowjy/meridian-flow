/** Display-first, field-local Work metadata editing. */
import { Trans } from "@lingui/react/macro";
import type { UpdateWorkRequest, Work } from "@meridian/contracts/works";
import { Pencil } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Field = "name" | "goal" | "description";
export function WorkMetadata({
  work,
  save,
  onDirtyChange,
}: {
  work: Work;
  save: (data: UpdateWorkRequest) => Promise<Work>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [active, setActive] = useState<Field | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editor = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const baseline = active ? (work[active] ?? "") : "";
  const dirty = active !== null && draft !== baseline;
  useLayoutEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useLayoutEffect(() => {
    if (active) {
      editor.current?.focus();
      if (active === "name" && editor.current instanceof HTMLInputElement) editor.current.select();
    }
  }, [active]);
  const begin = (field: Field) => {
    if (dirty) return;
    setActive(field);
    setDraft(work[field] ?? "");
    setError(null);
  };
  const cancel = () => {
    setActive(null);
    setError(null);
  };
  const commit = async () => {
    if (!active || saving) return;
    if (active === "name" && !draft.trim()) {
      setError("Work name is required");
      return;
    }
    if (draft === baseline) {
      cancel();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await save({ [active]: draft });
      setActive(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
    if (
      (active === "name" && event.key === "Enter") ||
      (active !== "name" && event.key === "Enter" && (event.metaKey || event.ctrlKey))
    ) {
      event.preventDefault();
      void commit();
    }
  };
  return (
    <section className="space-y-7" aria-label="Work identity">
      <div>
        {active === "name" ? (
          <div className="max-w-xl">
            <Input
              ref={editor as React.Ref<HTMLInputElement>}
              value={draft}
              disabled={saving}
              aria-invalid={Boolean(error)}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={keyDown}
              onBlur={() => {
                if (!error) void commit();
              }}
            />
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <h1 tabIndex={-1} className="text-2xl font-semibold">
              {work.name}
            </h1>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Edit Work name"
              onClick={() => begin("name")}
            >
              <Pencil className="size-4" />
            </Button>
          </div>
        )}
        {active === "name" ? (
          <Feedback saving={saving} error={error} retry={commit} cancel={cancel} />
        ) : null}
      </div>
      <MetadataField
        label="Goal"
        field="goal"
        value={work.goal}
        prominent
        active={active}
        draft={draft}
        saving={saving}
        error={error}
        editor={editor}
        begin={begin}
        setDraft={setDraft}
        commit={commit}
        cancel={cancel}
        keyDown={keyDown}
      />
      <MetadataField
        label="Description"
        field="description"
        value={work.description}
        active={active}
        draft={draft}
        saving={saving}
        error={error}
        editor={editor}
        begin={begin}
        setDraft={setDraft}
        commit={commit}
        cancel={cancel}
        keyDown={keyDown}
      />
    </section>
  );
}
function MetadataField(props: {
  label: string;
  field: "goal" | "description";
  value: string | null;
  prominent?: boolean;
  active: Field | null;
  draft: string;
  saving: boolean;
  error: string | null;
  editor: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  begin: (field: Field) => void;
  setDraft: (value: string) => void;
  commit: () => Promise<void>;
  cancel: () => void;
  keyDown: (event: React.KeyboardEvent) => void;
}) {
  const editing = props.active === props.field;
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium">{props.label}</h2>
      {editing ? (
        <>
          <Textarea
            ref={props.editor as React.Ref<HTMLTextAreaElement>}
            value={props.draft}
            disabled={props.saving}
            aria-invalid={Boolean(props.error)}
            className="min-h-24 resize-none"
            onInput={(event) => {
              const node = event.currentTarget;
              node.style.height = "auto";
              node.style.height = `${node.scrollHeight}px`;
            }}
            onChange={(event) => props.setDraft(event.target.value)}
            onKeyDown={props.keyDown}
          />
          <Feedback
            saving={props.saving}
            error={props.error}
            retry={props.commit}
            cancel={props.cancel}
            save={() => void props.commit()}
            label={props.label.toLowerCase()}
          />
        </>
      ) : (
        <button
          type="button"
          className={`focus-ring max-w-3xl rounded-sm text-left whitespace-pre-line ${props.prominent ? "text-base text-foreground" : "text-sm text-muted-foreground"}`}
          onClick={() => props.begin(props.field)}
        >
          {props.value || `Add a ${props.field}`}
        </button>
      )}
    </div>
  );
}
function Feedback({
  saving,
  error,
  retry,
  cancel,
  save,
  label,
}: {
  saving: boolean;
  error: string | null;
  retry: () => Promise<void>;
  cancel: () => void;
  save?: () => void;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {saving ? (
        <span role="status" className="text-sm text-muted-foreground">
          <Trans>Saving…</Trans>
        </span>
      ) : null}
      {error ? (
        <>
          <span role="alert" className="text-sm text-destructive">
            {error}
          </span>
          <Button size="sm" variant="outline" onClick={() => void retry()}>
            <Trans>Retry save</Trans>
          </Button>
        </>
      ) : save ? (
        <Button size="sm" onClick={save}>
          Save {label}
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onClick={cancel}>
        <Trans>Cancel</Trans>
      </Button>
    </div>
  );
}
