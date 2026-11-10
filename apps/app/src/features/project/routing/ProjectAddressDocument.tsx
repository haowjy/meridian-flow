/** Publish an authorized address into the workspace; the document host owns live-session binding. */
import { contextOwner, type DocumentAddressResult } from "@meridian/contracts/protocol";
import { resourceForDocumentIdentity } from "@meridian/resource-replica";
import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import { projectCatalogFile } from "@/client/query/useContextCatalog";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import {
  type ContextTab,
  matchesReviewItem,
  useContextTabs,
  useContextTabsActions,
} from "@/client/stores";
import { useAccountResourceProjection } from "../context/account-feature-context";
import { contextTabFromDraftGroup } from "../context/context-tab-from-draft";
import { contextTabFromFile } from "../context/context-tab-from-file";
import { useContextRemovalProject } from "../context/use-context-removal-project";
import { canonicalDocumentAddress, canonicalReviewTabPatch } from "./document-address-canonical";
import { addressReviewOwner } from "./document-address-review";
import { mergeLocalResourceState } from "./local-document-address";
import type { ProjectRouteIssue } from "./ProjectRouteBoundary";
import { type ProjectAddress, projectAddressHref } from "./project-address";
import type { createProjectNavigation } from "./project-navigation";

export type AddressAdmission = {
  key: string;
  documentId: string;
  href: string;
  issue: ProjectRouteIssue | undefined;
};

/**
 * The address stays on a removed document, and its lookup may still hold the answer from
 * before the removal. Admission must not install the tab again from that answer: the removal
 * closes it at once, in a loop. Two things show the answer is stale. The removal fence names
 * the document until a read taken after the removal arrives (a restore invalidates the
 * lookup). Then the replica's terminal record, which outlives the restore
 * until the catalog republishes the document.
 *
 * A document the workspace still holds a tab for is exempt: admission does nothing for it, and
 * a draft held over a document deleted live keeps painting.
 */
export function useAddressResultAfterRemoval(
  projectId: string,
  result: DocumentAddressResult | undefined,
  updatedAt: number,
  held: (documentId: string) => boolean,
): DocumentAddressResult | undefined {
  const { removalFence } = useContextRemovalProject(projectId);
  const { records } = useAccountResourceProjection(projectId);
  const fencedAt = useRef<number | null>(null);
  const documentId = result && result.kind !== "unavailable" ? result.document.documentId : null;
  const fenced = documentId !== null && removalFence?.removedDocumentIds.includes(documentId);
  if (!fenced) fencedAt.current = null;
  else fencedAt.current ??= Date.now();
  if (documentId === null || held(documentId)) return result;
  const terminal =
    resourceForDocumentIdentity(records, documentId)?.resource.lifecycle.kind === "terminal";
  return terminal || (fenced && updatedAt <= (fencedAt.current ?? 0)) ? undefined : result;
}

export function ProjectAddressDocument({
  projectId,
  href,
  entryKey,
  address,
  result,
  localFile,
  reviewItemKey,
  draftOnly,
  workId,
  noWorkId,
  navigation,
  onAdmission,
}: {
  projectId: string;
  href: string;
  entryKey: string;
  address: ProjectAddress;
  result: DocumentAddressResult | undefined;
  localFile?: CatalogFile;
  /** An explicit selector (or hidden create) never publishes a live representation. */
  reviewItemKey?: string;
  /** The Work's draft row when the addressed document exists only in the draft. */
  draftOnly?: ReviewFileTarget;
  workId: string | null;
  noWorkId: string | null;
  navigation: ReturnType<typeof createProjectNavigation> | null;
  onAdmission: Dispatch<SetStateAction<AddressAdmission | null>>;
}) {
  const { openTab } = useContextTabsActions();
  const { tabs } = useContextTabs(projectId);
  // A hidden create can name its item through `draftOnly` rather than the address.
  const reviewOwner = reviewItemKey
    ? addressReviewOwner({ lineage: address.lineage, itemKey: reviewItemKey }, workId)
    : null;
  const reviewTab = tabs.find(
    (tab): tab is Extract<ContextTab, { kind: "tracked" }> =>
      tab.kind === "tracked" &&
      !!reviewItemKey &&
      !!result &&
      result.kind !== "unavailable" &&
      tab.documentId === result.document.documentId &&
      matchesReviewItem(tab, { reviewOwner: reviewOwner ?? "", reviewItemKey }),
  );
  const reviewLocatorFingerprint = JSON.stringify(
    reviewTab ? { scheme: reviewTab.scheme, path: reviewTab.path, name: reviewTab.name } : null,
  );
  const opened =
    result !== undefined &&
    result.kind !== "unavailable" &&
    tabs.some((tab) => tab.documentId === result.document.documentId);
  const admissionInput = useRef({ address, result, localFile, reviewItemKey, draftOnly, opened });
  admissionInput.current = { address, result, localFile, reviewItemKey, draftOnly, opened };
  // Address/catalog projections are rebuilt from JSON snapshots. Their object
  // identity is not an admission event; only their serialized meaning is.
  const admissionFingerprint = JSON.stringify({ result, localFile, reviewItemKey });
  useEffect(() => {
    const { address, result, localFile, reviewItemKey, draftOnly, opened } = admissionInput.current;
    if (!workId || !navigation || !result || result.kind === "unavailable") return;
    const ticket = navigation.captureForEntry(entryKey);
    if (!ticket) return;
    const canonical = canonicalDocumentAddress(address, result.document.entry, workId, noWorkId);
    if (!canonical) {
      onAdmission({
        key: entryKey,
        href,
        documentId: result.document.documentId,
        issue: "unavailable",
      });
      return;
    }
    const document = result.document.entry;
    const scope = document.scope;
    const liveTab = () =>
      contextTabFromFile(
        canonical.destination.scheme,
        mergeLocalResourceState(projectCatalogFile(document), localFile),
        contextOwner(
          scope.kind === "work" ? scope.workId : undefined,
          scope.kind === "lineage" ? scope.rootThreadId : undefined,
        ),
      );
    if (reviewItemKey) {
      // An arriving review address is an open command: with no tab for the document it installs
      // one, and the pin sync and ReviewAddressOwner take it from there. A hidden review has no
      // live catalog to refresh its labels, so the server's canonical locator repairs its tab here.
      if (!opened) {
        const tab = !draftOnly
          ? liveTab()
          : reviewOwner
            ? contextTabFromDraftGroup({
                ownerKey: reviewOwner,
                documentId: result.document.documentId,
                itemKey: reviewItemKey,
                contextLocation: draftOnly.contextLocation,
                documentName: draftOnly.documentName,
                draftOnly: true,
              })
            : null;
        if (tab) openTab(projectId, tab, () => navigation.isCurrent(ticket), workId);
      } else if (reviewTab) {
        const patch = canonicalReviewTabPatch(
          reviewTab,
          canonical.destination,
          result.document.entry.name,
        );
        if (patch)
          openTab(projectId, { ...reviewTab, ...patch }, () => navigation.isCurrent(ticket));
      }
      const next = { ...canonical, itemKey: reviewItemKey };
      if (projectAddressHref(next) !== href) void navigation.replaceIfCurrent(ticket, next);
      return;
    }
    const identity = { href, key: entryKey, documentId: result.document.documentId };
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && navigation.isCurrent(ticket);
    const publish = (issue: ProjectRouteIssue | undefined) => onAdmission({ ...identity, issue });
    publish("loading");
    void (async () => {
      const installed = openTab(projectId, liveTab(), isCurrent);
      if (controller.signal.aborted || !navigation.isCurrent(ticket)) return;
      if (installed.kind !== "opened") {
        publish("unavailable");
        return;
      }
      const next = canonical;
      if (projectAddressHref(next) !== href) {
        const replacement = await navigation.replaceIfCurrent(ticket, next);
        if (
          replacement.kind === "failed" &&
          !controller.signal.aborted &&
          navigation.isCurrent(replacement.ticket)
        )
          publish("error");
      } else {
        publish(undefined);
      }
    })().catch(() => {
      if (!controller.signal.aborted && navigation.isCurrent(ticket)) publish("error");
    });
    return () => controller.abort();
  }, [
    projectId,
    href,
    entryKey,
    admissionFingerprint,
    reviewLocatorFingerprint,
    opened,
    workId,
    reviewOwner,
    noWorkId,
    navigation,
    openTab,
    onAdmission,
  ]);
  return null;
}
