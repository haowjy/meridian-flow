/** Publish an authorized address into the workspace; the document host owns live-session binding. */
import { contextOwner, type DocumentAddressResult } from "@meridian/contracts/protocol";
import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import { projectCatalogFile } from "@/client/query/useContextCatalog";
import {
  type ContextTab,
  matchesReviewItem,
  useContextTabs,
  useContextTabsActions,
} from "@/client/stores";
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
  reviewItemKey,
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
      !!reviewItemKey &&
      !!result &&
      result.kind !== "unavailable" &&
      tab.documentId === result.document.documentId &&
      matchesReviewItem(tab, { reviewWorkId: workId ?? "", reviewItemKey: reviewItemKey }),
  );
  // A tab on the document without a draft-only entry: the document lives, and its tab follows
  // the live catalog.
  const liveTabOpen =
    !!result &&
    result.kind !== "unavailable" &&
    tabs.some((tab) => tab.kind === "tracked" && tab.documentId === result.document.documentId);
  const reviewLocatorFingerprint = JSON.stringify(
    reviewTab ? { scheme: reviewTab.scheme, path: reviewTab.path, name: reviewTab.name } : null,
  );
  const admissionInput = useRef({ address, result, localFile, reviewItemKey });
  admissionInput.current = { address, result, localFile, reviewItemKey };
  // Address/catalog projections are rebuilt from JSON snapshots. Their object
  // identity is not an admission event; only their serialized meaning is.
  const admissionFingerprint = JSON.stringify({ result, localFile, reviewItemKey });
  useEffect(() => {
    const { address, result, localFile, reviewItemKey } = admissionInput.current;
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
    if (reviewItemKey) {
      // The address carries the item and ReviewAddressOwner opens its review. A document
      // that has a live location keeps the locator its tab and catalog follow (a sidebar
      // rename moves them): the draft view's locator lags that rename, so repairing from it
      // would walk the route back to the old name, the rename would walk it forward, and the
      // two would trade writes without end (#845). Only a hidden review has no live
      // catalog to refresh its labels, so there the server's canonical locator repairs its tab.
      if (!reviewTab && liveTabOpen) return;
      if (reviewTab) {
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
    liveTabOpen,
    workId,
    noWorkId,
    navigation,
    openTab,
    onAdmission,
  ]);
  return null;
}
