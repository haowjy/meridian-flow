import { useEffect, useState, useRef, useMemo } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { useLayoutStrategy } from "@/core/hooks/useLayoutStrategy";
import {
  useUIStore,
  selectEffectiveRightCollapsed,
} from "@/core/stores/useUIStore";
import { DocumentPanel } from "@/features/documents/components/DocumentPanel";
import { ThreadListPanel } from "@/features/threads/components/ThreadListPanel";
import { ActiveThreadView } from "@/features/threads/components/ActiveThreadView";
import { ProjectSettingsPanel } from "@/features/projects/components/ProjectSettingsPanel";
import { ProjectCollabProvider } from "@/features/documents/contexts/ProjectCollabContext";
import { useTreeStore } from "@/core/stores/useTreeStore";
import { useProjectStore } from "@/core/stores/useProjectStore";
import { useSkillStore } from "@/core/stores/useSkillStore";
import { api } from "@/core/lib/api";
import { makeLogger } from "@/core/lib/logger";
import { decodeDocumentPath } from "@/core/lib/panelHelpers";
import type { PanelDefinitions } from "@/shared/components/layout/types";

const logger = makeLogger("workspace-layout");

interface WorkspaceLayoutProps {
  /** Project identifier - can be UUID or slug (backend resolver handles both) */
  projectIdentifier: string;
  /** Document path from URL - resolved to ID once tree is loaded */
  initialDocumentPath?: string;
  /** Skill name from URL - resolved to ID once skills are loaded */
  initialSkillName?: string;
}

export default function WorkspaceLayout({
  projectIdentifier,
  initialDocumentPath,
  initialSkillName,
}: WorkspaceLayoutProps) {
  const navigate = useNavigate();
  // Resolved project ID (UUID) and slug - set once project is fetched/found
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectSlug, setProjectSlug] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const previousDocumentIdRef = useRef<string | undefined>(undefined);
  const previousProjectIdRef = useRef<string | undefined>(undefined);
  const isFirstMountRef = useRef(true);
  const previousResolvedProjectIdRef = useRef<string | null>(null);

  // Get left panel view from store (set by WorkspaceRail in _authenticated.tsx)
  const leftPanelView = useUIStore((s) => s.leftPanelView);
  const activeSkillId = useUIStore((s) => s.activeSkillId);

  // Get layout strategy based on viewport (TwoPanelLayout for desktop, MobileLayout for mobile)
  const LayoutStrategy = useLayoutStrategy();

  // Ensure document tree is loaded when deep-linking to a document URL
  const { isTreeLoading, documentsCount, documents, loadTree } = useTreeStore(
    useShallow((s) => ({
      isTreeLoading: s.isLoading,
      documentsCount: s.documents.length,
      documents: s.documents,
      loadTree: s.loadTree,
    })),
  );

  // Ensure skills are loaded when deep-linking to a skill URL
  const { skills, isLoadingSkills, loadSkills, skillsStatus } = useSkillStore(
    useShallow((s) => ({
      skills: s.skills,
      isLoadingSkills: s.isLoadingSkills,
      loadSkills: s.loadSkills,
      skillsStatus: s.skillsStatus,
    })),
  );

  // Projects store to centralize current project for the workspace
  const { projects, currentProjectId, setCurrentProject } = useProjectStore(
    useShallow((s) => ({
      projects: s.projects,
      currentProjectId: s.currentProjectId,
      setCurrentProject: s.setCurrentProject,
    })),
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  const location = useLocation();

  // Derive the document path from the current URL.
  // This is intentionally decoupled from route components so that:
  // - Direct URL navigation (deep links)
  // - Browser back/forward
  // still drive the editor/tree state correctly even if the document route
  // component itself does not render (e.g., due to nesting or Outlet usage).
  //
  // Path format: captures ALL segments after /documents/ and decodes them.
  // Example: /documents/Characters/Heroes/Aria.md -> "Characters/Heroes/Aria.md"
  const urlDocumentPath = useMemo(() => {
    const segments = location.pathname.split("/").filter(Boolean);
    const documentsIndex = segments.indexOf("documents");
    if (documentsIndex === -1) return undefined;
    // Get ALL segments after 'documents' and join with '/'
    const pathSegments = segments.slice(documentsIndex + 1);
    if (pathSegments.length === 0) return undefined;
    // Use decodeDocumentPath for robust decoding (handles double-encoded URLs)
    return decodeDocumentPath(pathSegments.join("/"));
  }, [location.pathname]);

  // Prefer explicit prop when provided (e.g., from a dedicated document route),
  // but fall back to URL parsing so that deep links and browser navigation
  // still work correctly.
  const effectiveDocumentPath = initialDocumentPath ?? urlDocumentPath;

  // Resolve document path to document ID using the tree store
  // Returns the UUID if found by path (or ID for backwards compat), undefined otherwise
  const effectiveDocumentId = useMemo(() => {
    if (!effectiveDocumentPath) return undefined;
    // Try to find document by path first, then by ID (for backwards compatibility)
    const doc = documents.find(
      (d) => d.path === effectiveDocumentPath || d.id === effectiveDocumentPath,
    );
    return doc?.id;
  }, [effectiveDocumentPath, documents]);

  // Parse skill name from URL (similar to document path parsing)
  // Path: /projects/{slug}/skills/{skillName}
  const urlSkillName = useMemo(() => {
    const segments = location.pathname.split("/").filter(Boolean);
    const skillsIndex = segments.indexOf("skills");
    if (skillsIndex === -1 || skillsIndex === segments.length - 1)
      return undefined;
    const skillSegment = segments[skillsIndex + 1];
    // Decode URL-encoded skill name (handles special chars like spaces, ampersands)
    return skillSegment ? decodeURIComponent(skillSegment) : undefined;
  }, [location.pathname]);

  const effectiveSkillName = initialSkillName ?? urlSkillName;

  // ADD THIS LOG
  logger.debug("[SKILL-DEEPLINK] effectiveSkillName parsed from URL", {
    effectiveSkillName,
    urlSkillName,
    initialSkillName,
    pathname: location.pathname,
  });

  // Resolve skill name to skill ID using the skill store
  // Returns the UUID if found by name, undefined otherwise
  const effectiveSkillId = useMemo(() => {
    if (!effectiveSkillName) {
      logger.debug(
        "[SKILL-DEEPLINK] effectiveSkillId memo: no skill name in URL",
      );
      return undefined;
    }
    const skill = skills.find((s) => s.name === effectiveSkillName);
    logger.debug("[SKILL-DEEPLINK] effectiveSkillId memo recalculated", {
      effectiveSkillName,
      skillsCount: skills.length,
      foundSkill: skill ? { id: skill.id, name: skill.name } : null,
      effectiveSkillId: skill?.id,
      allSkillNames: skills.map((s) => s.name),
    });
    return skill?.id;
  }, [effectiveSkillName, skills]);

  // Resolve project identifier (UUID or slug) to actual project
  // Sets projectId state once resolved
  useEffect(() => {
    // Prevent duplicate work for the same identifier
    if (previousProjectIdRef.current === projectIdentifier) return;
    previousProjectIdRef.current = projectIdentifier;

    let ignore = false;
    const abortController = new AbortController();

    async function resolveProject() {
      // Try to find the project in the existing list first (by ID or slug)
      const existing = projects.find(
        (p) => p.id === projectIdentifier || p.slug === projectIdentifier,
      );

      let project = existing;
      if (!project) {
        try {
          // API accepts both UUID and slug (backend resolver handles it)
          project = await api.projects.get(projectIdentifier, {
            signal: abortController.signal,
          });
        } catch (error) {
          // Non-fatal for the layout; header will fallback until projects page refreshes.
          // Errors are surfaced elsewhere when listing projects; we still log for debuggability.
          if ((error as Error)?.name === "AbortError") {
            logger.debug(
              "Project fetch aborted in workspace layout (expected during unmount/StrictMode)",
            );
          } else {
            logger.warn("Failed to resolve project in workspace layout", error);
            navigate({ to: "/projects" });
          }
        }
      }

      if (!ignore && project) {
        // Set resolved project ID and slug for use in child components
        setProjectId(project.id);
        setProjectSlug(project.slug);
        // Switch context only if different to avoid unnecessary editor cache clears
        if (currentProjectId !== project.id) {
          setCurrentProject(project);
        }
      }
    }

    resolveProject();
    return () => {
      ignore = true;
      abortController.abort();
      // Reset ref so StrictMode re-mount can retry the API call
      previousProjectIdRef.current = undefined;
    };
    // Intentionally depend only on projectIdentifier and stable setters to avoid constant re-runs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIdentifier]);

  // Reset UI state when switching between projects to prevent context leakage
  // Skip on first project load (null -> UUID) to preserve deep-link state
  useEffect(() => {
    logger.debug("[SKILL-DEEPLINK] Project reset effect triggered", {
      projectId,
      previousResolvedProjectId: previousResolvedProjectIdRef.current,
      isFirstLoad:
        previousResolvedProjectIdRef.current === null && projectId !== null,
      willSkipReset:
        previousResolvedProjectIdRef.current === null && projectId !== null,
    });

    const store = useUIStore.getState();

    // First project load: projectId goes from null to a UUID
    // Skip reset - no previous project to leak state from, sync effects will set initial state
    if (previousResolvedProjectIdRef.current === null && projectId !== null) {
      logger.debug("[SKILL-DEEPLINK] Skipping reset - first project load");
      previousResolvedProjectIdRef.current = projectId;
      return;
    }

    // Project switch: projectId changes from one UUID to another
    // Run reset to prevent state leakage from previous project
    if (
      projectId !== null &&
      projectId !== previousResolvedProjectIdRef.current
    ) {
      logger.debug("[SKILL-DEEPLINK] Running reset - project switched", {
        from: previousResolvedProjectIdRef.current,
        to: projectId,
      });
      store.setActiveDocument(null);
      store.setActiveSkill(null);
      // Clear thread ephemeral state — these are project-scoped and must not survive navigation
      store.clearPendingThreadReferences();
      store.setPendingProposalId(null);
      useSkillStore.getState().clearSkills(); // Clear stale skills from previous project
      store.setRightPanelState("documents");
      // Reset panel ready state for new project - panels will collapse until new data loads
      store.setLeftPanelReady(false);
      store.setRightPanelReady(false);
      // Note: Do NOT reset userOverride - user's collapse/expand preference should persist across projects
      previousDocumentIdRef.current = undefined; // Reset ref so next URL is treated as changed
      previousResolvedProjectIdRef.current = projectId;
      logger.debug("[SKILL-DEEPLINK] Reset complete");
    }
  }, [projectId]);

  // Sync URL document ID to UI state (for direct URL navigation, bookmarks, browser back/forward)
  // Uses getState() to read current values without subscribing (prevents unnecessary re-runs)
  // Effect only runs when document URL param changes, not when UI state changes
  // This allows future thread effects to run independently without interfering
  useEffect(() => {
    logger.debug("[SKILL-DEEPLINK] Document sync effect triggered", {
      effectiveDocumentId,
      previousDocId: previousDocumentIdRef.current,
      isFirstMount: isFirstMountRef.current,
      pathname: location.pathname,
    });

    const urlChanged = previousDocumentIdRef.current !== effectiveDocumentId;
    const isFirstMount = isFirstMountRef.current;

    previousDocumentIdRef.current = effectiveDocumentId;
    isFirstMountRef.current = false;

    // Skip only if NOT first mount AND URL didn't change
    if (!isFirstMount && !urlChanged) {
      logger.debug("URL unchanged (not first mount), skipping sync");
      return;
    }

    logger.debug("URL changed, syncing UI state to match URL...");

    // Read current state without subscribing (no re-renders when state changes)
    const store = useUIStore.getState();

    if (effectiveDocumentId) {
      // Document URL - open editor with this document and ensure sidebar open
      if (store.activeDocumentId !== effectiveDocumentId) {
        logger.debug("Setting active document:", effectiveDocumentId);
        store.setActiveDocument(effectiveDocumentId);
      }
      if (store.rightPanelState !== "editor") {
        logger.debug("Setting panel state: editor");
        store.setRightPanelState("editor");
      }
      // Check effective collapsed state (considers ready state + user override)
      if (selectEffectiveRightCollapsed(store)) {
        logger.debug("Expanding right panel");
        store.setRightPanelCollapsed(false);
      }
    } else {
      // Tree URL - show tree view
      if (store.activeDocumentId !== null) {
        logger.debug("Clearing active document");
        store.setActiveDocument(null);
      }
      if (store.rightPanelState !== "documents") {
        logger.debug("Setting panel state: documents");
        store.setRightPanelState("documents");
      }
    }
    // location.pathname is only used for debug logging, intentionally not in deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveDocumentId]);

  // For deep links: load the tree once in the background if empty
  // Uses effectiveDocumentPath (not effectiveDocumentId) since we need tree loaded to resolve path -> ID
  useEffect(() => {
    if (!effectiveDocumentPath) return;
    if (projectId === null) return; // Wait for project to be resolved
    if (documentsCount !== 0 || isTreeLoading) return;

    const abortController = new AbortController();
    loadTree(projectId, abortController.signal);
    return () => abortController.abort();
  }, [
    projectId,
    effectiveDocumentPath,
    documentsCount,
    isTreeLoading,
    loadTree,
  ]);

  // After the tree loads, ensure the active document selection reflects the tree entry
  useEffect(() => {
    if (!effectiveDocumentId) return;
    if (documentsCount === 0) return;

    const existsInTree = documents.some((d) => d.id === effectiveDocumentId);
    const store = useUIStore.getState();
    if (existsInTree && store.activeDocumentId !== effectiveDocumentId) {
      logger.debug(
        "Tree loaded, syncing active document to URL:",
        effectiveDocumentId,
      );
      store.setActiveDocument(effectiveDocumentId);
    }
  }, [documentsCount, documents, effectiveDocumentId]);

  // For deep links: load skills once in the background if empty
  // Uses effectiveSkillName (not effectiveSkillId) since we need skills loaded to resolve name -> ID
  useEffect(() => {
    logger.debug("[SKILL-DEEPLINK] Skill loading effect check", {
      effectiveSkillName,
      projectId,
      skillsCount: skills.length,
      isLoadingSkills,
      willLoadSkills:
        effectiveSkillName &&
        projectId &&
        skills.length === 0 &&
        !isLoadingSkills,
    });

    if (!effectiveSkillName) return;
    if (projectId === null) return; // Wait for project to be resolved
    if (skills.length !== 0 || isLoadingSkills) return;

    logger.debug("[SKILL-DEEPLINK] Loading skills for deep-link...");
    const abortController = new AbortController();
    loadSkills(projectId, abortController.signal);
    return () => abortController.abort();
  }, [
    projectId,
    effectiveSkillName,
    skills.length,
    isLoadingSkills,
    loadSkills,
  ]);

  // Sync URL skill ID to UI state (for direct URL navigation, bookmarks, browser back/forward)
  // Uses getState() to read current values without subscribing (prevents unnecessary re-runs)
  useEffect(() => {
    const store = useUIStore.getState();

    logger.debug("[SKILL-DEEPLINK] Skill sync effect triggered", {
      effectiveSkillId,
      currentActiveSkillId: store.activeSkillId,
      currentActiveDocumentId: store.activeDocumentId,
      currentRightPanelState: store.rightPanelState,
      willSetSkill: !!effectiveSkillId,
    });

    if (!effectiveSkillId) {
      logger.debug("[SKILL-DEEPLINK] No effectiveSkillId, skipping sync");
      return;
    }

    logger.debug("[SKILL-DEEPLINK] Setting active skill and opening editor...");

    if (store.activeSkillId !== effectiveSkillId) {
      logger.debug("[SKILL-DEEPLINK] Calling setActiveSkill", {
        effectiveSkillId,
      });
      store.setActiveSkill(effectiveSkillId);
    }
    // Note: setActiveSkill already clears activeDocumentId for mutual exclusivity
    store.setRightPanelState("editor");
    store.setRightPanelCollapsed(false);

    logger.debug("[SKILL-DEEPLINK] After setting state", {
      activeSkillId: useUIStore.getState().activeSkillId,
      activeDocumentId: useUIStore.getState().activeDocumentId,
      rightPanelState: useUIStore.getState().rightPanelState,
    });
  }, [effectiveSkillId]);

  // Handle skill not found
  useEffect(() => {
    // Guard against project not yet resolved
    if (!projectSlug) return;

    // 'new' is a reserved name for skill creation - skip lookup
    if (effectiveSkillName === "new") return;

    if (effectiveSkillName && !effectiveSkillId && skillsStatus === "success") {
      // If we have an active skill ID, check if it's still valid
      if (activeSkillId) {
        const activeSkill = skills.find((s) => s.id === activeSkillId);
        if (activeSkill) {
          // Active skill exists - check if URL needs correction (rename case)
          if (activeSkill.name !== effectiveSkillName) {
            logger.debug("[SKILL-DEEPLINK] Skill URL stale, replacing", {
              effectiveSkillName,
              activeSkillId,
              activeSkillName: activeSkill.name,
            });
            navigate({
              to: "/projects/$slug/skills/$skillName",
              params: { slug: projectSlug, skillName: activeSkill.name },
              replace: true,
            });
          }
          // Either way (rename or re-click), we have a valid active skill - don't clear
          // This handles re-clicking the same skill where timing can cause effectiveSkillId
          // to briefly be undefined during memo recalculation
          return;
        }
      }

      // Skill name in URL but not found in loaded skills
      logger.warn("Skill not found:", effectiveSkillName);
      useUIStore.getState().setActiveSkill(null);
      navigate({ to: "/projects/$slug", params: { slug: projectSlug } });
    }
  }, [
    activeSkillId,
    effectiveSkillName,
    effectiveSkillId,
    skills,
    skillsStatus,
    navigate,
    projectSlug,
  ]);

  // Wait for mount and project resolution before rendering workspace
  if (!mounted || projectId === null || projectSlug === null) {
    return <div className="bg-background h-dvh w-full" />;
  }

  // Define panel content (what to show) - layout strategy decides how to arrange them
  // Layout Philosophy (Desktop TwoPanelLayout):
  // - LEFT (42%): Thread panel - Primary AI interaction, prominent position emphasizes AI-native nature
  // - RIGHT (58%): Document workspace - Tree + Editor unified, substantial space for writing
  const panels: PanelDefinitions = {
    threadList: <ThreadListPanel projectId={projectId} />,
    activeThread: <ActiveThreadView projectId={projectId} />,
    documentPanel: (
      <DocumentPanel
        projectId={projectId}
        projectSlug={projectSlug}
        isLoadingSkills={isLoadingSkills}
        effectiveSkillName={effectiveSkillName}
        isResolvingDocument={!!effectiveDocumentPath && !effectiveDocumentId}
      />
    ),
    projectSettings: <ProjectSettingsPanel projectId={projectId} />,
  };

  return (
    <ProjectCollabProvider key={projectId} projectId={projectId}>
      <LayoutStrategy panels={panels} leftPanelView={leftPanelView} />
    </ProjectCollabProvider>
  );
}
