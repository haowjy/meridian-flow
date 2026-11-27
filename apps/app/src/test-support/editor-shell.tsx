import { vi } from "vitest";
import * as threads from "@/client/query/useProjectThreads";
import * as trees from "@/client/query/useProjectTrees";
import * as works from "@/client/query/useWorks";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import * as chrome from "@/features/editor/chrome-surfaces";
import * as references from "@/features/editor/references/useReferenceBrowserCatalog";
import * as status from "@/features/editor/SyncStatus";
import * as links from "@/features/links";
import * as account from "@/features/project/context/account-feature-context";
import { ContextRemovalCoordinator } from "@/features/project/context/context-removal-coordinator";
import * as phoneShell from "@/hooks/use-phone-shell";
import { linkIndexOf } from "./link-trees";

export function installEditorShell(registry: LiveDocumentSessionRegistry) {
  const removal = new ContextRemovalCoordinator();
  const epoch = new AbortController();
  const seams = [
    vi.spyOn(account, "useAccountId").mockReturnValue("writer"),
    vi.spyOn(account, "useAccountEpochSignal").mockReturnValue(epoch.signal),
    vi.spyOn(account, "useProjectStandings").mockReturnValue({
      watch: () => () => undefined,
      standing: () => ({ kind: "waiting" }),
    } as unknown as ReturnType<typeof account.useProjectStandings>),
    vi.spyOn(trees, "useProjectTrees").mockReturnValue({
      ready: false,
      isComplete: false,
      isError: false,
      sources: [],
      tree: () => null,
      find: () => null,
      standing: () => ({ kind: "waiting" }),
    }),
    vi
      .spyOn(threads, "useProjectThreads")
      .mockReturnValue({ threads: [], isError: false, isFetching: false, refetch: () => {} }),
    vi.spyOn(works, "useWorks").mockReturnValue({
      noWork: { id: "no-work", handle: null, archivedAt: null } as NonNullable<
        ReturnType<typeof works.useWorks>["noWork"]
      >,
      works: [],
      deleted: [],
      handleOf: () => null,
      nameOf: (work: { name: string }) => work.name,
      creations: new Map(),
      isError: false,
      isFetching: false,
      status: "empty",
      refetch: () => undefined,
    }),
    vi.spyOn(phoneShell, "usePhoneShell").mockReturnValue(false),
    vi.spyOn(account, "useContextRemovalCoordinator").mockReturnValue(removal),
    vi.spyOn(account, "useLiveDocumentSessionRegistry").mockReturnValue(registry),
    vi
      .spyOn(links, "useLinkableDocuments")
      .mockReturnValue({ ...linkIndexOf([]), revision: "", complete: false }),
    vi.spyOn(references, "useReferenceBrowserCatalog").mockReturnValue(null),
    vi.spyOn(status, "SyncStatus").mockImplementation(() => null),
    vi.spyOn(chrome, "EDITOR_CHROME_SURFACES", "get").mockReturnValue([]),
  ];
  return {
    dispose() {
      for (const seam of seams) seam.mockRestore();
      epoch.abort();
      removal.dispose();
    },
  };
}
