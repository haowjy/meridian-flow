/**
 * DockTabsShell — throwaway mockup for tabbed right dock with work-scoped Changes.
 * Route: /proto/dock-tabs. Hardcoded fixtures; delete when direction is settled.
 */
import { FileText, MessageSquare, PanelRightClose, Sparkles, Upload } from "lucide-react";
import { type ReactNode, type Ref, useCallback, useEffect, useRef, useState } from "react";

import { SectionLabel } from "@/components/ui/section-label";
import { cn } from "@/lib/utils";

import "@/features/editor/editor.css";

import {
  type ChangeRow,
  DOCUMENT_CHANGES,
  type DockTabId,
  PENDING_CHANGE_COUNT,
  type ProtoArrangement,
} from "./fixtures";

const DOCK_WIDTH = 360;

export function DockTabsShell() {
  const [arrangement, setArrangement] = useState<ProtoArrangement>("chat-main");
  const [badgeOn, setBadgeOn] = useState(true);
  const [dockTab, setDockTab] = useState<DockTabId>("context");
  const [activeChangeId, setActiveChangeId] = useState<string | null>(null);
  const [pulseChangeId, setPulseChangeId] = useState<string | null>(null);
  const manuscriptRef = useRef<HTMLDivElement>(null);

  const dockTabs: DockTabId[] =
    arrangement === "chat-main" ? ["context", "changes"] : ["chat", "changes"];

  useEffect(() => {
    if (!dockTabs.includes(dockTab)) {
      setDockTab(arrangement === "chat-main" ? "context" : "chat");
    }
  }, [arrangement, dockTab, dockTabs]);

  const scrollToChange = useCallback((changeId: string) => {
    const root = manuscriptRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>(`[data-change-id="${changeId}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setActiveChangeId(changeId);
    setPulseChangeId(changeId);
    window.setTimeout(() => setPulseChangeId(null), 1200);
  }, []);

  const openChange = useCallback(
    (changeId: string) => {
      if (arrangement === "chat-main") {
        setArrangement("context-main");
        setDockTab("changes");
      }
      requestAnimationFrame(() => scrollToChange(changeId));
    },
    [arrangement, scrollToChange],
  );

  const reviewFromDock = useCallback(() => {
    setArrangement("context-main");
    setDockTab("changes");
  }, []);

  return (
    <div className="flex h-svh w-full flex-col bg-background text-foreground">
      <ProtoChrome
        arrangement={arrangement}
        badgeOn={badgeOn}
        onArrangementChange={setArrangement}
        onBadgeChange={setBadgeOn}
      />

      <div className="mx-auto flex min-h-0 w-full max-w-[1280px] flex-1 border-x border-border-subtle">
        <LeftRailStub />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-border-subtle">
          {arrangement === "chat-main" ? (
            <ChatMainCenter onReview={reviewFromDock} />
          ) : (
            <ContextMainCenter
              manuscriptRef={manuscriptRef}
              activeChangeId={activeChangeId}
              pulseChangeId={pulseChangeId}
            />
          )}
        </main>
        <aside
          className="flex min-h-0 shrink-0 flex-col border-l border-border-subtle bg-background"
          style={{ width: DOCK_WIDTH }}
          aria-label="Right dock"
        >
          <DockTabStrip
            tabs={dockTabs}
            activeTab={dockTab}
            badgeOn={badgeOn}
            onSelect={setDockTab}
          />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {dockTab === "context" ? <ContextDockContent /> : null}
            {dockTab === "chat" ? <ChatDockContent /> : null}
            {dockTab === "changes" ? (
              <ChangesDockContent
                activeChangeId={activeChangeId}
                onReviewDocument={() => {
                  setArrangement("context-main");
                  setDockTab("changes");
                }}
                onSelectChange={openChange}
              />
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

function ProtoChrome({
  arrangement,
  badgeOn,
  onArrangementChange,
  onBadgeChange,
}: {
  arrangement: ProtoArrangement;
  badgeOn: boolean;
  onArrangementChange: (value: ProtoArrangement) => void;
  onBadgeChange: (value: boolean) => void;
}) {
  return (
    <div className="shrink-0 border-b border-dashed border-primary/40 bg-surface-subtle px-4 py-2">
      <p className="mb-2 text-meta text-muted-foreground">
        Proto chrome — not product UI. Toggle arrangement and Changes-tab badge.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">Arrangement</legend>
          <span className="text-caption font-medium text-ink-muted">Arrangement</span>
          <ProtoToggle
            pressed={arrangement === "chat-main"}
            onClick={() => onArrangementChange("chat-main")}
          >
            Chat-main
          </ProtoToggle>
          <ProtoToggle
            pressed={arrangement === "context-main"}
            onClick={() => onArrangementChange("context-main")}
          >
            Context-main
          </ProtoToggle>
        </fieldset>
        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">Changes badge</legend>
          <span className="text-caption font-medium text-ink-muted">Badge</span>
          <ProtoToggle pressed={badgeOn} onClick={() => onBadgeChange(true)}>
            on
          </ProtoToggle>
          <ProtoToggle pressed={!badgeOn} onClick={() => onBadgeChange(false)}>
            off
          </ProtoToggle>
        </fieldset>
      </div>
    </div>
  );
}

function ProtoToggle({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={cn(
        "focus-ring rounded-md border px-2.5 py-1 text-caption transition-colors",
        pressed
          ? "border-primary bg-primary/10 font-semibold text-foreground"
          : "border-border bg-card text-muted-foreground hover:bg-sidebar-accent/40",
      )}
    >
      {children}
    </button>
  );
}

function LeftRailStub() {
  return (
    <div className="flex w-[220px] shrink-0 flex-col border-r border-border-subtle bg-sidebar">
      <div className="flex h-10 items-center border-b border-border-subtle px-3">
        <SectionLabel>Chats</SectionLabel>
      </div>
      <div className="flex flex-col gap-1 p-2">
        <div className="rounded-md bg-surface-subtle px-2 py-1.5 text-caption font-medium text-foreground">
          Refine opening chapters
        </div>
        <div className="rounded-md px-2 py-1.5 text-caption text-muted-foreground">
          Character voice pass
        </div>
      </div>
    </div>
  );
}

function ChatMainCenter({ onReview }: { onReview: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-border-subtle px-3">
        <span className="text-sm font-medium text-foreground">Refine opening chapters</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-[640px] flex-col gap-4">
          <div className="rounded-lg bg-surface-subtle px-3 py-2 text-caption text-ink-muted">
            You · Tighten the river-gate scene and seed Chapter 2.
          </div>
          <div className="flex flex-col gap-2 text-caption text-foreground">
            <p>
              I rewrote the apprentice&apos;s oath at the river gate and drafted a new opening for
              Chapter 2. Five pending changes across two chapters.
            </p>
            <p className="text-ink-muted">Edited Chapter 1, Chapter 2</p>
          </div>
        </div>
      </div>
      <div className="shrink-0 border-t border-border-subtle">
        <MockDraftDock onReview={onReview} />
        <div className="border-t border-border-subtle bg-card px-3 py-2">
          <div className="mx-auto flex max-w-[640px] items-center gap-2 rounded-lg border border-border-subtle bg-background px-3 py-2 text-caption text-muted-foreground">
            Message Meridian…
          </div>
        </div>
      </div>
    </div>
  );
}

function MockDraftDock({ onReview }: { onReview: () => void }) {
  return (
    <div className="bg-card" data-draft-dock="settled">
      <div className="flex min-h-7 items-center gap-1.5 border-b border-border-subtle px-2.5 text-caption text-ink-strong">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-jade-text" />
        <span className="min-w-0 flex-1 truncate">2 documents</span>
        <span className="shrink-0 tabular-nums whitespace-nowrap">
          <span className="text-ink-subtle" aria-hidden>
            ·{" "}
          </span>
          <span className="text-jade-text">+137</span> <span className="text-ink-subtle">−103</span>
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onReview}
            className="focus-ring inline-flex h-5 shrink-0 items-center rounded-sm bg-primary px-2.5 text-caption font-semibold text-primary-foreground"
          >
            Review
          </button>
          <button
            type="button"
            className="focus-ring shrink-0 rounded-sm px-1.5 py-0.5 text-ink-muted hover:text-foreground"
          >
            Apply all
          </button>
          <button
            type="button"
            className="focus-ring shrink-0 rounded-sm px-1.5 py-0.5 text-ink-muted hover:text-foreground"
          >
            Discard all
          </button>
        </div>
      </div>
    </div>
  );
}

function ContextMainCenter({
  manuscriptRef,
  activeChangeId,
  pulseChangeId,
}: {
  manuscriptRef: Ref<HTMLDivElement>;
  activeChangeId: string | null;
  pulseChangeId: string | null;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate text-sm font-medium text-foreground">
          Chapter 1 — The Waste Who Would Be Immortal
        </span>
      </div>
      <div ref={manuscriptRef} className="min-h-0 flex-1 overflow-y-auto px-8 py-8">
        <article className="meridian-editor mx-auto max-w-[65ch]">
          <div className="ProseMirror text-[15px] leading-7 text-foreground">
            <p className="mb-4 text-pretty">
              The elders called him waste, yet the river remembered every name he had been denied.{" "}
              <span
                data-change-id="ch1-c4"
                className={cn(
                  "meridian-review-added",
                  (activeChangeId === "ch1-c4" || pulseChangeId === "ch1-c4") &&
                    "meridian-review-emphasized",
                )}
              >
                He stood at the cracked stair with river-mist on his sleeves, listening for the tone
                that would unlock the outer gate.
              </span>
            </p>
            <p className="mb-4 text-pretty">
              <span
                data-change-id="ch1-c2"
                className={cn(
                  "meridian-review-added",
                  (activeChangeId === "ch1-c2" || pulseChangeId === "ch1-c2") &&
                    "meridian-review-emphasized",
                )}
              >
                Morning mist clung to the broken stair like a second skin.
              </span>{" "}
              Below, the sect disciples filed past without looking up. None of them would meet his
              eyes before the trial began.
            </p>
            <p className="mb-4 text-pretty">
              At the gate, the apprentice knelt on wet stone.{" "}
              <span
                data-change-id="ch1-c1"
                className={cn(
                  "meridian-review-added",
                  (activeChangeId === "ch1-c1" || pulseChangeId === "ch1-c1") &&
                    "meridian-review-emphasized",
                )}
              >
                The apprentice whispers RIVERSTONE before the gate, the syllables tasting of cold
                jade and old vows.
              </span>{" "}
              The ward flickered, then held.
            </p>
            <p className="text-pretty">
              When the bell tolled, he understood at last why the river had never let him drown: it
              was waiting to hear what he would become.
            </p>
          </div>
        </article>
      </div>
    </div>
  );
}

function DockTabStrip({
  tabs,
  activeTab,
  badgeOn,
  onSelect,
}: {
  tabs: DockTabId[];
  activeTab: DockTabId;
  badgeOn: boolean;
  onSelect: (tab: DockTabId) => void;
}) {
  const labels: Record<DockTabId, string> = {
    context: "Context",
    chat: "Chat",
    changes: "Changes",
  };
  const icons: Record<DockTabId, ReactNode> = {
    context: <FileText className="size-3.5" aria-hidden />,
    chat: <MessageSquare className="size-3.5" aria-hidden />,
    changes: null,
  };

  return (
    <div
      role="tablist"
      aria-label="Dock tabs"
      className="flex h-10 shrink-0 items-stretch border-b border-border-subtle"
    >
      {tabs.map((tab) => {
        const active = tab === activeTab;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(tab)}
            className={cn(
              "focus-ring relative flex h-full min-w-0 flex-1 items-center justify-center gap-1.5 border-r border-border px-3 text-caption font-medium transition-colors last:border-r-0",
              active
                ? "bg-surface-subtle text-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground",
            )}
          >
            {icons[tab]}
            <span>{labels[tab]}</span>
            {tab === "changes" && badgeOn ? (
              <span className="tabular-nums text-ink-muted">({PENDING_CHANGE_COUNT})</span>
            ) : null}
          </button>
        );
      })}
      <div className="flex shrink-0 items-center px-1.5">
        <button
          type="button"
          aria-label="Collapse dock"
          className="focus-ring grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground"
        >
          <PanelRightClose className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

function ContextDockContent() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
      <RailSectionStub title="Uploads" icon={<Upload className="size-3.5" />} defaultOpen>
        <RailRowStub name="sect-map.png" meta="240 KB" />
      </RailSectionStub>
      <RailSectionStub title="Recent" icon={<FileText className="size-3.5" />}>
        <RailRowStub name="Chapter 1 — The Waste Who Would Be Immortal" meta="edited" />
        <RailRowStub name="Chapter 2 — Ash on the Jade Steps" meta="edited" />
      </RailSectionStub>
      <RailSectionStub title="Results" icon={<Sparkles className="size-3.5" />} defaultOpen>
        <RailRowStub name="Character voice notes" meta="result" />
      </RailSectionStub>
    </div>
  );
}

function ChatDockContent() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-center border-b border-border-subtle px-2">
        <SectionLabel>Refine opening chapters</SectionLabel>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-caption text-ink-muted">
        <p className="mb-3 text-foreground">
          I rewrote the apprentice&apos;s oath at the river gate and drafted a new opening for
          Chapter 2.
        </p>
        <p>Docked transcript stub — same thread, read-only while editing.</p>
      </div>
    </div>
  );
}

function ChangesDockContent({
  activeChangeId,
  onReviewDocument,
  onSelectChange,
}: {
  activeChangeId: string | null;
  onReviewDocument: () => void;
  onSelectChange: (changeId: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
      {DOCUMENT_CHANGES.map((doc) => (
        <DocumentChangeGroup
          key={doc.documentId}
          doc={doc}
          activeChangeId={activeChangeId}
          onReview={onReviewDocument}
          onSelectChange={onSelectChange}
        />
      ))}
    </div>
  );
}

function DocumentChangeGroup({
  doc,
  activeChangeId,
  onReview,
  onSelectChange,
}: {
  doc: (typeof DOCUMENT_CHANGES)[number];
  activeChangeId: string | null;
  onReview: () => void;
  onSelectChange: (changeId: string) => void;
}) {
  return (
    <section className="mb-3">
      <div className="group flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-sidebar-accent/40">
        <button
          type="button"
          onClick={onReview}
          className="focus-ring min-w-0 flex-1 truncate text-left text-xs font-semibold text-foreground"
        >
          {doc.title}
        </button>
        <span className="shrink-0 tabular-nums text-meta text-muted-foreground">
          <span className="text-jade-text">+{doc.added}</span>{" "}
          <span className="text-ink-subtle">−{doc.removed}</span>
        </span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onReview();
          }}
          className="focus-ring shrink-0 rounded-sm px-1.5 py-0.5 text-caption font-semibold text-primary opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
        >
          Review
        </button>
      </div>
      <ol className="flex flex-col gap-0.5 pl-1">
        {doc.changes.map((change) => (
          <ChangeRowButton
            key={change.id}
            change={change}
            active={activeChangeId === change.id}
            onSelect={() => onSelectChange(change.id)}
          />
        ))}
      </ol>
    </section>
  );
}

function ChangeRowButton({
  change,
  active,
  onSelect,
}: {
  change: ChangeRow;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "focus-ring flex w-full items-baseline gap-1.5 rounded-md px-2 py-1.5 text-left text-caption transition-colors",
          active
            ? "bg-surface-subtle text-foreground"
            : "text-ink-muted hover:bg-sidebar-accent/40 hover:text-foreground",
        )}
      >
        <span className="shrink-0 font-medium text-foreground">{change.verb}</span>
        <span className="min-w-0 flex-1 truncate text-ink-muted">
          <span aria-hidden>· </span>
          &ldquo;{change.excerpt}&rdquo;
        </span>
        <span className="shrink-0 tabular-nums text-meta">
          {change.added > 0 ? <span className="text-jade-text">+{change.added}</span> : null}
          {change.added > 0 && change.removed > 0 ? " " : null}
          {change.removed > 0 ? <span className="text-ink-subtle">−{change.removed}</span> : null}
        </span>
      </button>
    </li>
  );
}

function RailSectionStub({
  title,
  icon,
  defaultOpen,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <section className="mb-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="focus-ring flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-semibold text-foreground transition-colors hover:bg-sidebar-accent"
      >
        <span className={cn("text-muted-foreground transition-transform", !open && "-rotate-90")}>
          ▾
        </span>
        <span className="text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
      {open ? <div className="flex flex-col gap-0.5 pb-1 pl-2">{children}</div> : null}
    </section>
  );
}

function RailRowStub({ name, meta }: { name: string; meta: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-caption hover:bg-sidebar-accent/40">
      <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
      <span className="shrink-0 text-meta text-muted-foreground">{meta}</span>
    </div>
  );
}
