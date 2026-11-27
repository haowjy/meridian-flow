import { createContext, useContext, useSyncExternalStore } from "react";
import type { RequestAccount } from "@/client/api/http-client";
import type { DraftCommandOwner } from "@/client/draft-commands/draft-command-owner";
import type { ContextRemovalCoordinator } from "@/client/project-shell/context-removal-coordinator";
import type { PresentedDocuments } from "@/client/project-shell/presented-documents";
import type { OpenDocument } from "@/client/stores";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type { ProjectStandings } from "@/core/tree-list/project-standings";
import type { TreeListRegistry } from "@/core/tree-list/tree-list-registry";

export const RequestAccountContext = createContext<RequestAccount | null>(null);
export const AccountEpochContext = createContext<AbortSignal | null>(null);
export const SignOutContext = createContext<(() => Promise<string>) | null>(null);
export const TreeListsAccountContext = createContext<TreeListRegistry | null>(null);
export const ContextRemovalAccountContext = createContext<ContextRemovalCoordinator | null>(null);
export const ProjectStandingsAccountContext = createContext<ProjectStandings | null>(null);
export const LiveDocumentRegistryAccountContext = createContext<LiveDocumentSessionRegistry | null>(
  null,
);
export const DraftCommandsContext = createContext<DraftCommandOwner | null>(null);
export const PresentedContext = createContext<PresentedDocuments | null>(null);

export function useRequestAccount(): RequestAccount {
  const account = useContext(RequestAccountContext);
  if (!account) throw new Error("AccountLifetimeProvider is required");
  return account;
}

export function useAccountId(): string {
  return useRequestAccount().id;
}

export function useAccountEpochSignal(): AbortSignal {
  const signal = useContext(AccountEpochContext);
  if (!signal) throw new Error("AccountLifetimeProvider is required");
  return signal;
}

export function useOptionalAccountEpochSignal(): AbortSignal | null {
  return useContext(AccountEpochContext);
}

export function useOptionalSignOutCleanup(): (() => Promise<string>) | null {
  return useContext(SignOutContext);
}

export function useOptionalTreeLists(): TreeListRegistry | null {
  return useContext(TreeListsAccountContext);
}

export function useProjectStandings(): ProjectStandings {
  const standings = useContext(ProjectStandingsAccountContext);
  if (!standings) throw new Error("AccountLifetimeProvider is required");
  return standings;
}

export function useContextRemovalCoordinator(): ContextRemovalCoordinator {
  const coordinator = useContext(ContextRemovalAccountContext);
  if (!coordinator) throw new Error("AccountLifetimeProvider is required");
  return coordinator;
}

export function useOptionalContextRemovalCoordinator(): ContextRemovalCoordinator | null {
  return useContext(ContextRemovalAccountContext);
}

export function useLiveDocumentSessionRegistry(): LiveDocumentSessionRegistry {
  const registry = useContext(LiveDocumentRegistryAccountContext);
  if (!registry) throw new Error("AccountLifetimeProvider is required");
  return registry;
}

export function useOptionalLiveDocumentSessionRegistry(): LiveDocumentSessionRegistry | null {
  return useContext(LiveDocumentRegistryAccountContext);
}

export function useDraftCommandOwner(): DraftCommandOwner {
  const owner = useContext(DraftCommandsContext);
  if (!owner) throw new Error("AccountLifetimeProvider is required");
  return owner;
}

export function useOptionalDraftCommandOwner(): DraftCommandOwner | null {
  return useContext(DraftCommandsContext);
}

export function useOptionalPresentedDocuments(): PresentedDocuments | null {
  return useContext(PresentedContext);
}

const NOTHING_PRESENTED: readonly OpenDocument[] = [];

export function useShownDocuments(projectId: string): readonly OpenDocument[] {
  const presented = useContext(PresentedContext);
  return useSyncExternalStore(
    presented?.subscribe ?? noSubscription,
    () => presented?.shown(projectId) ?? NOTHING_PRESENTED,
    () => NOTHING_PRESENTED,
  );
}

function noSubscription(): () => void {
  return () => undefined;
}
