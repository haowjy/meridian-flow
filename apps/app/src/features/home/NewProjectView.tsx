/** Project creation destination: name a project, then enter its Chat landing. */
import { Trans } from "@lingui/react/macro";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { createProject, getProject } from "@/client/api/projects-api";
import { useProjectActions } from "@/client/stores";
import { MeridianMark } from "@/components/app/MeridianMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function NewProjectView() {
  const navigate = useNavigate();
  const router = useRouter();
  const { ensureProject } = useProjectActions();
  const [projectId] = useState(() => crypto.randomUUID());
  const active = useRef(true);
  const [title, setTitle] = useState("");
  const [submittedTitle, setSubmittedTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true);
    setError(false);
    try {
      let slug = createdSlug;
      if (!slug) {
        const name = submittedTitle ?? title.trim();
        setSubmittedTitle(name);
        const project = await createProject({ id: projectId, title: name }).catch(() =>
          getProject(projectId),
        );
        ensureProject(project);
        slug = project.slug;
        if (active.current) setCreatedSlug(slug);
      }
      if (active.current && router.history.location.pathname === "/projects/new") {
        await navigate({ to: "/p/$projectSlug/$", params: { projectSlug: slug, _splat: "" } });
      }
    } catch {
      if (active.current) {
        setError(true);
        setBusy(false);
      }
    }
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
              disabled={busy || submittedTitle !== null}
              onChange={(event) => setTitle(event.target.value)}
              className="mt-2 h-11 bg-card"
              required
            />
            {error && (
              <p className="mt-3 text-sm text-destructive" role="alert">
                {createdSlug ? (
                  <Trans>Project created, but it couldn’t open. Try again.</Trans>
                ) : (
                  <Trans>Project wasn’t confirmed. Retry creation.</Trans>
                )}
              </p>
            )}
            <Button
              type="submit"
              size="sm"
              className="mt-6 [@media(pointer:coarse)]:min-h-11"
              disabled={busy || !title.trim()}
            >
              {busy ? (
                <Trans>Creating project…</Trans>
              ) : createdSlug ? (
                <Trans>Open project</Trans>
              ) : (
                <Trans>Create project</Trans>
              )}
            </Button>
          </form>
        </div>
      </div>
    </main>
  );
}
