/**
 * CreationDialog — the one way to create a named thing (a Work, a project).
 *
 * Questions as labels, one body text size for labels, fields and
 * placeholders, and Cancel beside Create at the bottom right. Create is ready
 * once the name has text; Enter in the name field or Ctrl/Cmd+Enter in the
 * description creates. Creating closes the dialog at once and hands off to the
 * caller, which navigates first and lets the server catch up.
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

const fieldClass = "bg-card text-body placeholder:text-body md:text-body";
const buttonClass = "h-10 px-4 text-body [@media(pointer:coarse)]:min-h-11";

export type CreationValues = { name: string; description: string };

export function CreationDialog({
  title,
  nameLabel,
  namePlaceholder,
  description,
  submitLabel,
  onClose,
  onCreate,
}: {
  title: string;
  nameLabel: string;
  namePlaceholder: string;
  /** The optional second question; omitted when the thing has only a name. */
  description?: { label: string; placeholder: string };
  submitLabel: string;
  onClose: () => void;
  onCreate: (values: CreationValues) => void;
}) {
  const [name, setName] = useState("");
  const [details, setDetails] = useState("");
  const nameId = useId();
  const detailsId = useId();
  const ready = name.trim().length > 0;
  const create = () => {
    if (!ready) return;
    onCreate({ name: name.trim(), description: details.trim() });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl gap-6 p-6 sm:p-7">
        <DialogHeader className="text-left sm:text-left">
          <DialogTitle className="text-xl leading-tight font-semibold tracking-tight">
            {title}
          </DialogTitle>
          <DialogDescription className="sr-only">{nameLabel}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
          noValidate
        >
          <div className="grid gap-2">
            <label htmlFor={nameId} className="text-body font-medium">
              {nameLabel}
            </label>
            <Input
              id={nameId}
              autoFocus
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={namePlaceholder}
              className={`h-10 ${fieldClass}`}
            />
          </div>
          {description ? (
            <div className="grid gap-2">
              <label htmlFor={detailsId} className="text-body font-medium">
                {description.label}
              </label>
              <Textarea
                id={detailsId}
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    create();
                  }
                }}
                placeholder={description.placeholder}
                className={`min-h-28 resize-y ${fieldClass}`}
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
