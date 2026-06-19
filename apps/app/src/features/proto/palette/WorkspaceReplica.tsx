/**
 * THROWAWAY workspace chrome replica for /proto/palette.
 *
 * Faithful static stand-in for the writing workspace mockup (sidebar / center
 * manuscript / assistant dock) built ONLY out of the existing design-token
 * utility classes (`bg-sidebar`, `bg-background`, `bg-card`, `border-border`,
 * `text-foreground`, …) so that overrides to those CSS vars at `:root` repaint
 * every surface live. Identity tokens (jade, cinnabar, ink, fonts) and copy
 * mirror `work/v3-fullstack-rebuild/mockups/ij-workspace.png`.
 *
 * Disposable. No real data, no router links, no behaviour.
 */

import { MeridianMark } from "@/components/app/MeridianMark";
import { cn } from "@/lib/utils";

const PROJECTS = [
  { name: "The Wandering Flame", active: true },
  { name: "Heaven's Debt", dot: true },
  { name: "Iron Lotus Saga" },
  { name: "Notes & Fragments" },
  { name: "Second Drafts" },
];

const MANUSCRIPT_PARAGRAPHS = [
  "The throne room of the Jade Court stretched before Elara like a canyon carved from emerald and obsidian. Pillars of dark stone rose toward a ceiling lost in shadow, their surfaces etched with characters she could not read.",
  "King Aldric sat upon the Jade Throne, his posture rigid as the stone that cradled him. Even from this distance, Elara could see the threads of silver in his beard that had not been there five years ago.",
  "\u201cYou\u2019ve grown.\u201d The king\u2019s voice echoed through the chamber, resonant and cool. \u201cWhen last you stood before me, you barely reached Master Chen\u2019s shoulder.\u201d",
  "\u201cI\u2019ve learned much since then, Your Majesty.\u201d Elara kept her gaze level, though every instinct screamed at her to look away.",
];

export function WorkspaceReplica({ elevated }: { elevated: boolean }) {
  return (
    <div className="flex h-full min-h-0 w-full bg-background text-foreground">
      <ReplicaSidebar />
      <ReplicaManuscript elevated={elevated} />
      <ReplicaAssistant />
    </div>
  );
}

function ReplicaSidebar() {
  return (
    <aside className="flex w-[220px] shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <MeridianMark className="size-5" />
        <span className="font-heading text-[20px] font-semibold tracking-tight leading-none">
          Meridian
        </span>
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          className="focus-ring w-full rounded-md border border-transparent px-2 py-1.5 text-left text-[13px] font-medium text-primary hover:border-border-subtle hover:bg-sidebar-accent/60"
        >
          + New project
        </button>
      </div>

      <div className="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Projects
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-2">
        {PROJECTS.map((p) => (
          <ProjectRow key={p.name} name={p.name} active={p.active} dot={p.dot} />
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-2 border-t border-border-subtle px-3 py-3">
        <span className="inline-flex w-fit items-center rounded-full border border-border-subtle bg-card px-2.5 py-0.5 text-[11px] text-ink-muted">
          1,240 credits
        </span>
        <span className="truncate text-[12px] text-ink-muted">jimmy@example.com</span>
      </div>
    </aside>
  );
}

function ProjectRow({ name, active, dot }: { name: string; active?: boolean; dot?: boolean }) {
  return (
    <div className="relative">
      {active ? (
        <span
          aria-hidden
          className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r-sm bg-cinnabar"
        />
      ) : null}
      <div
        className={cn(
          "flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px]",
          active ? "text-cinnabar font-medium" : "text-foreground/80",
        )}
      >
        {dot ? (
          <span aria-hidden className="inline-block size-1.5 rounded-full bg-primary" />
        ) : null}
        <span className="truncate">{name}</span>
      </div>
    </div>
  );
}

function ReplicaManuscript({ elevated }: { elevated: boolean }) {
  return (
    <main
      className={cn(
        "flex min-w-0 flex-1 justify-center overflow-y-auto",
        elevated ? "px-10 py-8" : "px-0 py-0",
      )}
    >
      <article
        className={cn(
          "flex w-full max-w-[640px] flex-col",
          elevated
            ? "rounded-2xl border border-border-subtle bg-card px-12 py-10 shadow-card"
            : "px-10 py-8",
        )}
      >
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Chapter 2
        </span>
        <h1 className="mt-1 font-heading text-[36px] font-semibold leading-[1.08] tracking-tight text-foreground">
          The Jade Court
        </h1>
        <div className="mt-1 text-[12px] text-ink-muted">2,847 words · Saved 2 minutes ago</div>
        <hr className="mt-5 border-0 border-t border-border-subtle" />

        <div className="mt-6 space-y-5 font-prose text-[15px] leading-[1.75] text-ink-strong">
          {MANUSCRIPT_PARAGRAPHS.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      </article>
    </main>
  );
}

function ReplicaAssistant() {
  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-border bg-sidebar text-sidebar-foreground">
      <header className="px-4 pt-4 pb-3 text-[13px] font-semibold text-foreground">
        Assistant
      </header>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-3">
        <MessageBlock from="you">
          Check Elara&rsquo;s dialogue against her character doc from Chapter 1.
        </MessageBlock>
        <MessageBlock from="assistant">
          Her reply to King Aldric reads formal but guarded, which matches the doc. In Chapter 1 she
          avoids eye contact; here she holds the king&rsquo;s gaze. That could be growth, or you may
          want a beat of hesitation first.
        </MessageBlock>
        <MessageBlock from="you">Add a beat of hesitation before she meets his eyes.</MessageBlock>
      </div>

      <div className="border-t border-border-subtle p-3">
        <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-warm p-1.5 shadow-input">
          <input
            type="text"
            placeholder="Ask about your story…"
            className="flex-1 bg-transparent px-2 text-[13px] text-foreground outline-none placeholder:text-ink-muted"
          />
          <button
            type="button"
            className="focus-ring rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground shadow-button hover:opacity-95"
          >
            Send message
          </button>
        </div>
      </div>
    </aside>
  );
}

function MessageBlock({
  from,
  children,
}: {
  from: "you" | "assistant";
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span
        className={cn(
          "text-[10px] font-semibold uppercase tracking-[0.14em]",
          from === "assistant" ? "text-primary" : "text-muted-foreground",
        )}
      >
        {from === "assistant" ? "Assistant" : "You"}
      </span>
      <div className="rounded-lg border border-border-subtle bg-card px-3 py-2.5 text-[13px] leading-[1.55] text-ink-strong">
        {children}
      </div>
    </div>
  );
}
