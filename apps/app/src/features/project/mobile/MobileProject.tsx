/**
 * MobileProject — phone-class project shell with one active view at a time.
 *
 * This is a sibling of the desktop ProjectShell, not a conditional branch
 * inside it. It reuses the same route-owned ProjectViewProps and inner content
 * components while replacing the desktop grid/rails with top bar + drawer +
 * stacked single-pane navigation. Context drill-in (scheme → folders → file)
 * is entirely route-driven, so the OS/browser back gesture pops levels;
 * up-navigation in the chrome is the top bar's breadcrumb (ancestor taps),
 * not a back button — the drawer trigger stays on every screen.
 */
import { t } from "@lingui/core/macro";
import { MessageSquare, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { PhoneIconButton } from "@/components/ui/phone-icon-button";
import { CorpusImportPanel } from "@/features/corpus-import/CorpusImportPanel";
import type { ContextCreateKind } from "../context/context-create-kind";
import { schemeLabel } from "../context/context-schemes";
import { useProjectThreadGroups } from "../data/dashboard-data";
import type { ProjectViewProps } from "../ProjectView";
import { folderAncestry, pathLeafName } from "./context-location";
import { MobileBreadcrumb, type MobileBreadcrumbSegment } from "./MobileBreadcrumb";
import { MobileChatHost } from "./MobileChatHost";
import { MobileContextBrowser } from "./MobileContextBrowser";
import { MobileCreateEntryMenu } from "./MobileCreateEntryMenu";
import { MobileDocumentHost } from "./MobileDocumentHost";
import { MobileHomeScreen } from "./MobileHomeScreen";
import { MobileResultsView } from "./MobileResultsView";
import { MobileTopBar } from "./MobileTopBar";
import { NavigationDrawer } from "./NavigationDrawer";

export function MobileProject(props: ProjectViewProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Pending inline create row (file/folder) in the Files browser. Lifted here
  // because the `+` entry point lives in the top bar's trailing slot while the
  // editable row renders inside MobileContextBrowser's folder listing. The
  // create *location* is always "where you are" — the route's scheme+folder —
  // so only the kind needs to be remembered.
  const [creating, setCreating] = useState<ContextCreateKind | null>(null);
  // Any navigation (screen switch, drill in/out, opening a file, Results)
  // abandons an uncommitted create row — the row is location-scoped chrome.
  const contextLocation = `${props.activeScreen}|${props.activeContextScheme ?? ""}|${props.activeContextFolder ?? ""}|${props.activeContextPath ?? ""}|${props.resultsOpen}`;
  useEffect(() => setCreating(null), [contextLocation]);
  const { threadById } = useProjectThreadGroups(props.projectId);
  const activeThread = props.activeThreadId ? (threadById.get(props.activeThreadId) ?? null) : null;
  const crumbs = contextBreadcrumbSegments(props);

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-background text-foreground"
      data-phone-shell="true"
    >
      <MobileTopBar
        activeScreen={props.activeScreen}
        activeThread={activeThread}
        title={
          props.resultsOpen ? t`Results` : props.activeScreen === "import" ? t`Import` : undefined
        }
        onOpenDrawer={() => setDrawerOpen(true)}
        breadcrumb={
          !props.resultsOpen && crumbs.length > 0 ? (
            <MobileBreadcrumb segments={crumbs} />
          ) : undefined
        }
        // One trailing slot, screen-dependent identity — see trailingAction()
        // for the chat ⇄ results toggle and the Files browser's `+` create
        // menu.
        actions={trailingAction(props, setCreating)}
      />
      <main className="main-pane min-h-0 flex-1 overflow-hidden">
        {renderActiveView(props, creating, () => setCreating(null))}
      </main>
      <NavigationDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        projectId={props.projectId}
        activeScreen={props.activeScreen}
        activeThreadId={props.activeThreadId}
        onSelectScreen={props.onSelectScreen}
        onSelectThread={props.onSelectThread}
      />
    </div>
  );
}

/**
 * Top-bar trailing action dispatcher — one slot, screen-dependent identity.
 * Chat is where results get produced, so it carries the Results entry;
 * Results carries the visible way back (edge-swipe works too, but a
 * discoverable affordance shouldn't require knowing the gesture). The Files
 * browser inside a scheme (scheme root or a folder, no file open) carries
 * the `+` create menu — creation lands "where you are", the route's current
 * scheme+folder. The Files root (scheme list) gets no `+`: schemes are
 * sources, not folders, so there is no "here" to create into. All other
 * screens leave the slot empty.
 */
function trailingAction(
  props: ProjectViewProps,
  onRequestCreate: (kind: ContextCreateKind) => void,
) {
  if (props.resultsOpen) {
    return (
      <PhoneIconButton onClick={props.onCloseResults} aria-label={t`Back to chat`}>
        <MessageSquare className="size-5" aria-hidden />
      </PhoneIconButton>
    );
  }
  if (props.activeScreen === "chat") {
    return (
      <PhoneIconButton onClick={props.onOpenResults} aria-label={t`Open results`}>
        <Sparkles className="size-5" aria-hidden />
      </PhoneIconButton>
    );
  }
  // All schemes accept creation when browsing a scheme root, matching the desktop tree's per-scheme `+`.
  if (props.activeScreen === "context" && props.activeContextScheme && !props.activeContextPath) {
    return <MobileCreateEntryMenu onSelect={onRequestCreate} />;
  }
  return undefined;
}

function renderActiveView(
  props: ProjectViewProps,
  creating: ContextCreateKind | null,
  onCreateDone: () => void,
) {
  if (props.resultsOpen) {
    return <MobileResultsView projectId={props.projectId} />;
  }

  switch (props.activeScreen) {
    case "home":
      return <MobileHomeScreen projectId={props.projectId} onSelectThread={props.onSelectThread} />;
    case "chat":
      return (
        <MobileChatHost
          projectId={props.projectId}
          activeThreadId={props.activeThreadId}
          onSelectThread={props.onSelectThread}
        />
      );
    case "context":
      return props.activeContextPath ? (
        <MobileDocumentHost
          projectId={props.projectId}
          activeContextScheme={props.activeContextScheme}
          activeContextPath={props.activeContextPath}
        />
      ) : (
        <MobileContextBrowser
          projectId={props.projectId}
          activeContextScheme={props.activeContextScheme}
          activeContextFolder={props.activeContextFolder}
          onSelectContextScheme={props.onSelectContextScheme}
          onSelectContextFolder={props.onSelectContextFolder}
          onSelectContextPath={props.onSelectContextPath}
          creating={creating}
          onCreateDone={onCreateDone}
        />
      );
    case "import":
      return <CorpusImportPanel projectId={props.projectId} compact />;
  }
}

/**
 * Top-bar breadcrumb for the whole context screen: Files › scheme › folders
 * › file. "Files" is the root crumb and navigates to the scheme list; deeper
 * ancestors navigate to the Files browser at that location (`""` = scheme
 * root). The last segment is the current location and stays non-interactive —
 * at the Files root itself the trail is just a lone "Files". Home, chat, and
 * routed Results auxiliary state suppresses the trail so the top bar shows its
 * plain centered title instead — Results is not part of the Files hierarchy.
 */
function contextBreadcrumbSegments(props: ProjectViewProps): MobileBreadcrumbSegment[] {
  if (props.activeScreen !== "context") return [];
  // `t` resolves at render time (this runs per render), matching how
  // schemeLabel localizes — both produce plain strings for the segment.
  const filesLabel = t`Files`;
  if (!props.activeContextScheme) {
    // Files root: nothing is drilled in, so "Files" is the current location.
    return [{ label: filesLabel }];
  }
  const segments: MobileBreadcrumbSegment[] = [
    { label: filesLabel, onSelect: () => props.onExitContextScheme() },
    {
      label: schemeLabel(props.activeContextScheme),
      onSelect: () => props.onSelectContextFolder(""),
    },
  ];
  // Route invariant: `folder === dirname(path)` whenever a file is open, so
  // the folder ancestry doubles as the document screen's ancestor trail.
  for (const folder of folderAncestry(props.activeContextFolder)) {
    segments.push({ label: folder.name, onSelect: () => props.onSelectContextFolder(folder.path) });
  }
  if (props.activeContextPath) {
    segments.push({ label: pathLeafName(props.activeContextPath) });
  } else {
    // No file open — the deepest folder (or the scheme itself) is the
    // current location, so strip its navigation affordance.
    const last = segments[segments.length - 1];
    segments[segments.length - 1] = { label: last.label };
  }
  return segments;
}
