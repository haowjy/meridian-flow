/** Publish an authorized address into the workspace; the document host owns live-session binding. */
import { contextOwner, type DocumentAddressResult } from "@meridian/contracts/protocol";
import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import { projectCatalogFile } from "@/client/query/useContextCatalog";
import { type ContextTab, useContextTabs, useContextTabsActions } from "@/client/stores";
import { contextTabFromFile } from "../context/context-tab-from-file";
import { canonicalDocumentAddress, canonicalReviewTabPatch } from "./document-address-canonical";
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

export function ProjectAddressDocument({
  projectId,
  href,
  entryKey,
  address,
  result,
  localFile,
  draftOnlyId,
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
  /** Pending draft that alone proposes this document: it has no live view, only review. */
  draftOnlyId?: string;
  workId: string | null;
  noWorkId: string | null;
  navigation: ReturnType<typeof createProjectNavigation> | null;
  onAdmission: Dispatch<SetStateAction<AddressAdmission | null>>;
}) {
  const { openTab } = useContextTabsActions();
  const { tabs } = useContextTabs(projectId);
  const reviewTab = tabs.find(
    (tab): tab is Extract<ContextTab, { kind: "tracked" }> =>
      tab.kind === "tracked" &&
      tab.draftOnly === true &&
      tab.reviewWorkId === workId &&
      tab.reviewDraftId === draftOnlyId &&
      !!result &&
      result.kind !== "unavailable" &&
      tab.documentId === result.document.documentId,
  );
  const reviewLocatorFingerprint = JSON.stringify(
    reviewTab ? { scheme: reviewTab.scheme, path: reviewTab.path, name: reviewTab.name } : null,
  );
  const admissionInput = useRef({ address, result, localFile, draftOnlyId });
  admissionInput.current = { address, result, localFile, draftOnlyId };
  // Address/catalog projections are rebuilt from JSON snapshots. Their object
  // identity is not an admission event; only their serialized meaning is.
  const admissionFingerprint = JSON.stringify({ result, localFile, draftOnlyId });
  useEffect(() => {
    const { address, result, localFile, draftOnlyId } = admissionInput.current;
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
    if (draftOnlyId) {
      // No live tab or room: the address carries the draft and
      // EditorReviewAddressOwner opens its review.
      if (reviewTab) {
        const patch = canonicalReviewTabPatch(
          reviewTab,
          canonical.destination,
          result.document.entry.name,
        );
        if (patch)
          openTab(projectId, { ...reviewTab, ...patch }, () => navigation.isCurrent(ticket));
      }
      const next = { ...canonical, draftId: draftOnlyId };
      if (projectAddressHref(next) !== href) void navigation.replaceIfCurrent(ticket, next);
      return;
    }
    const identity = { href, key: entryKey, documentId: result.document.documentId };
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && navigation.isCurrent(ticket);
    const publish = (issue: ProjectRouteIssue | undefined) => onAdmission({ ...identity, issue });
    publish("loading");
    const document = result.document.entry;
    const scope = document.scope;
    const tabWorkId = scope.kind === "work" ? scope.workId : undefined;
    const lineageId = scope.kind === "lineage" ? scope.rootThreadId : undefined;
    void (async () => {
      const installed = openTab(
        projectId,
        contextTabFromFile(
          canonical.destination.scheme,
          mergeLocalResourceState(projectCatalogFile(document), localFile),
          contextOwner(tabWorkId, lineageId),
        ),
        isCurrent,
      );
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
    workId,
    noWorkId,
    navigation,
    openTab,
    onAdmission,
  ]);
  return null;
}
