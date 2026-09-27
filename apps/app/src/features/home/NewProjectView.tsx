/** Project creation destination: name a project, then open its Work collection. */
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useCreateProject } from "@/client/query/useProjectCreation";
import { MeridianMark } from "@/components/app/MeridianMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";

export function NewProjectView() {
  const userId = useAccountId();
  const accountSignal = useAccountEpochSignal();
  const { create } = useCreateProject(userId, accountSignal);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true);
    create({ title });
  }

  return (
    <main className="app-scroll h-full bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-5 pb-14 sm:px-8">
        <header className="border-b border-border py-4">
          <Link
            to="/"
            className="focus-ring flex w-fit items-center gap-1 rounded-md text-sm font-semibold tracking-tight"
          >
            <MeridianMark className="size-7" />
            Meridian
          </Link>
        </header>
        <div className="mx-auto mt-9 max-w-lg sm:mt-14">
          <Link
            to="/"
            className="focus-ring inline-flex items-center gap-2 rounded-sm text-sm text-jade-text hover:underline"
          >
            <ArrowLeft className="size-4" aria-hidden /> <Trans>View projects</Trans>
          </Link>
          <h1 className="mt-8 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            <Trans>Create a project</Trans>
          </h1>
          <p className="mt-3 text-sm leading-6 text-ink-muted">
            <Trans>A project can hold one book, a whole series, or a story world.</Trans>
          </p>
          <form className="mt-8" onSubmit={(event) => void submit(event)}>
            <label htmlFor="project-title" className="block text-sm font-medium">
              <Trans>Project name</Trans>
            </label>
            <Input
              id="project-title"
              autoFocus
              autoComplete="off"
              maxLength={120}
              value={title}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
              className="mt-2 h-11 bg-card"
              required
            />
            <Button
              type="submit"
              size="sm"
              className="mt-6 [@media(pointer:coarse)]:min-h-11"
              disabled={busy || !title.trim()}
            >
              {busy ? <Trans>Creating project…</Trans> : <Trans>Create project</Trans>}
            </Button>
          </form>
        </div>
      </div>
    </main>
  );
}
