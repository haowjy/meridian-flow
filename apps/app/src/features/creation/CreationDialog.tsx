/**
 * CreationDialog — the one way to create a named thing (a Work, a project).
 *
 * Questions as labels and one text size (text-sm, 16px on phones so iOS does
 * not zoom) for labels, fields and placeholders, in the Dialog's default padding
 * with default-size buttons: Cancel beside Create at the bottom right. Create
 * is ready once the name has text; Enter in the name field or Ctrl/Cmd+Enter
 * in the details field creates. Creating closes the dialog at once and hands
 * off to the caller, which navigates first and lets the server catch up.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// One size for labels, fields and placeholders: 16px below md, as the ui
// Input does, because iOS zooms into smaller fields on focus; text-sm above.
const textClass = "text-base md:text-sm";
const labelClass = `${textClass} font-medium`;
const fieldClass = `bg-card ${textClass}`;
const buttonClass = "[@media(pointer:coarse)]:min-h-11";

export type CreationValues = { name: string; details: string };

export function CreationDialog({
  title,
  nameLabel,
  namePlaceholder,
  details,
  submitLabel,
  onClose,
  onCreate,
}: {
  title: string;
  nameLabel: string;
  namePlaceholder: string;
  /** The optional second question; omitted when the thing has only a name. */
  details?: { label: string; placeholder: string };
  submitLabel: string;
  onClose: () => void;
  onCreate: (values: CreationValues) => void;
}) {
  const [name, setName] = useState("");
  const [detailsText, setDetailsText] = useState("");
  const nameId = useId();
  const detailsId = useId();
  const ready = name.trim().length > 0;
  const create = () => {
    if (!ready) return;
    onCreate({ name: name.trim(), details: detailsText.trim() });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl gap-5">
        <DialogHeader className="text-left sm:text-left">
          <DialogTitle className="text-lg leading-tight font-semibold tracking-tight">
            {title}
          </DialogTitle>
          <DialogDescription className="sr-only">{nameLabel}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
          noValidate
        >
          <div className="grid gap-2">
            <label htmlFor={nameId} className={labelClass}>
              {nameLabel}
            </label>
            <Input
              id={nameId}
              autoFocus
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={namePlaceholder}
              className={fieldClass}
            />
          </div>
          {details ? (
            <div className="grid gap-2">
              <label htmlFor={detailsId} className={labelClass}>
                {details.label}
              </label>
              <Textarea
                id={detailsId}
                value={detailsText}
                onChange={(event) => setDetailsText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    create();
                  }
                }}
                placeholder={details.placeholder}
                className={`min-h-24 resize-y ${fieldClass}`}
              />
            </div>
          ) : null}
          <DialogFooter className="gap-2 sm:gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline" className={buttonClass}>
                <Trans>Cancel</Trans>
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={!ready}
              aria-label={ready ? undefined : t`${submitLabel} (enter a name first)`}
              className={buttonClass}
            >
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
