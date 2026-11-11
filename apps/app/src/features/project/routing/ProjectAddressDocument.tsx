/** An authorized address, made canonical; the document host owns live-session binding. */
import { contextOwner, type DocumentAddressResult } from "@meridian/contracts/protocol";
import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import { projectCatalogFile } from "@/client/query/useContextCatalog";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { openDocumentFromDraftGroup } from "../context/open-document-from-draft";
import { openDocumentFromFile } from "../context/open-document-from-file";
import type { AddressedDocument } from "../context/route-document-owner";
import { canonicalDocumentAddress } from "./document-address-canonical";
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
 * The document an answered address names: built from the address's draft row when live lacks it
 * (a page a draft created), else from the server's answer at its canonical locator. Main's
 * resolver shows it when live lacks the document.
 */
export function addressedDocument(
  address: ProjectAddress,
  result: DocumentAddressResult | undefined,
  localFile: CatalogFile | undefined,
  draftOnly: ReviewFileTarget | undefined,
): AddressedDocument | null {
  if (!result || result.kind === "unavailable") return null;
  if (draftOnly) {
    const tab = openDocumentFromDraftGroup({
      documentId: result.document.documentId,
      contextLocation: draftOnly.contextLocation,
      documentName: draftOnly.documentName,
    });
    return tab ? { tab, draftOnly: true } : null;
  }
  const canonical = canonicalDocumentAddress(address, result.document.entry);
  if (!canonical) return null;
  const document = result.document.entry;
  const scope = document.scope;
  const tab = openDocumentFromFile(
    canonical.destination.scheme,
    mergeLocalResourceState(projectCatalogFile(document), localFile),
    contextOwner(
      scope.kind === "work" ? scope.workId : undefined,
      scope.kind === "lineage" ? scope.rootThreadId : undefined,
    ),
  );
  return { tab, draftOnly: false };
}

/**
 * Takes an answered address to its canonical form and says when main may show its document.
 * Main's host paints the document the address names (`useMainDocument`); nothing is installed.
 */
export function ProjectAddressDocument({
  href,
  entryKey,
  address,
  result,
  reviewItemKey,
  workId,
  navigation,
  onAdmission,
}: {
  href: string;
  entryKey: string;
  address: ProjectAddress;
  result: DocumentAddressResult | undefined;
  /** An explicit selector (or hidden create) never publishes a live representation. */
  reviewItemKey?: string;
  workId: string | null;
  navigation: ReturnType<typeof createProjectNavigation> | null;
  onAdmission: Dispatch<SetStateAction<AddressAdmission | null>>;
}) {
  // A hidden create can name its item through its draft row rather than the address.
  const reviewOwner = reviewItemKey
    ? addressReviewOwner({ owner: address.owner, itemKey: reviewItemKey }, workId)
    : null;
  const admissionInput = useRef({ address, result, reviewItemKey });
  admissionInput.current = { address, result, reviewItemKey };
  // Address projections are rebuilt from JSON snapshots. Their object identity is not an
  // admission event; only their serialized meaning is.
  const admissionFingerprint = JSON.stringify({ result, reviewItemKey });
  useEffect(() => {
    const { address, result, reviewItemKey } = admissionInput.current;
    if (!workId || !navigation || !result || result.kind === "unavailable") return;
    const ticket = navigation.captureForEntry(entryKey);
    if (!ticket) return;
    const identity = { href, key: entryKey, documentId: result.document.documentId };
    const publish = (issue: ProjectRouteIssue | undefined) => onAdmission({ ...identity, issue });
    const canonical = canonicalDocumentAddress(address, result.document.entry);
    if (!canonical) {
      publish("unavailable");
      return;
    }
    if (reviewItemKey) {
      // The link to a draft carries its owner, which a hidden create takes from the scope.
      const next = { ...canonical, owner: reviewOwner ?? canonical.owner, itemKey: reviewItemKey };
      if (projectAddressHref(next) !== href) void navigation.replaceIfCurrent(ticket, next);
      return;
    }
    if (projectAddressHref(canonical) === href) {
      publish(undefined);
      return;
    }
    let current = true;
    publish("loading");
    void navigation.replaceIfCurrent(ticket, canonical).then(
      (replacement) => {
        if (current && replacement.kind === "failed" && navigation.isCurrent(replacement.ticket))
          publish("error");
      },
      () => {
        if (current && navigation.isCurrent(ticket)) publish("error");
      },
    );
    return () => {
      current = false;
    };
  }, [href, entryKey, admissionFingerprint, workId, reviewOwner, navigation, onAdmission]);
  return null;
}
