/** Compact, shared shell for writer-facing creation destinations. */
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export function CreationPage({
  backTo,
  backLabel,
  title,
  submitLabel,
  children,
  onSubmit,
}: {
  backTo: string;
  backLabel: string;
  title: string;
  submitLabel: string;
  children: ReactNode;
  onSubmit: () => void;
}) {
  const [validationMessage, setValidationMessage] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = formRef.current?.querySelector<HTMLInputElement>("[name=creation-name]");
    const name = input?.value.trim() ?? "";
    if (!name) {
      setValidationMessage("Enter a name to continue.");
      input?.focus();
      return;
    }
    setValidationMessage("");
    onSubmit();
  }

  return (
    <main className="app-scroll h-full bg-background text-foreground">
      <div className="mx-auto w-full max-w-[520px] px-5 pb-12 pt-6 sm:px-8 sm:pt-8">
        <Link
          to={backTo}
          className="focus-ring inline-flex min-h-8 items-center gap-1.5 rounded-sm text-sm text-jade-text hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {backLabel}
        </Link>
        <h1 className="mt-5 text-xl font-semibold tracking-tight">{title}</h1>
        <form
          ref={formRef}
          className="mt-5"
          onSubmit={submit}
          onKeyDown={(event) => {
            if (
              event.target instanceof HTMLInputElement &&
              event.target.name === "creation-name" &&
              event.key === "Enter"
            ) {
              event.preventDefault();
              event.currentTarget.requestSubmit();
              return;
            }
            if (
              event.target instanceof HTMLTextAreaElement &&
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey)
            ) {
              event.preventDefault();
              event.currentTarget.requestSubmit();
            }
          }}
          noValidate
        >
          <div className="grid gap-3">{children}</div>
          {validationMessage ? (
            <p className="mt-2 text-sm text-destructive" role="alert">
              <Trans>Enter a name to continue.</Trans>
            </p>
          ) : null}
          <Button type="submit" size="sm" className="mt-4 [@media(pointer:coarse)]:min-h-11">
            {submitLabel}
          </Button>
        </form>
      </div>
    </main>
  );
}
