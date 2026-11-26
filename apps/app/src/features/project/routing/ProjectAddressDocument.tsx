import { contextOwner, type DocumentAddressResult } from "@meridian/contracts/protocol";
import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import type { TreeFile } from "@/core/project-tree/tree-view";
import { openDocumentFromDraftGroup } from "../context/open-document-from-draft";
import { openDocumentFromFile, treeFileFromCatalogEntry } from "../context/open-document-from-file";
import type { AddressedDocument } from "../context/route-document-owner";
import { canonicalDocumentAddress } from "./document-address-canonical";
import type { ProjectRouteIssue } from "./ProjectRouteBoundary";
import { type ProjectAddress, projectAddressHref } from "./project-address";
import type { createProjectNavigation } from "./project-navigation";

export type AddressAdmission = {
  key: string;
  documentId: string;
  href: string;
  issue: ProjectRouteIssue | undefined;
};

export function addressedDocument(
  address: ProjectAddress,
  result: DocumentAddressResult | undefined,
  localFile: TreeFile | undefined,
  draftOnly: ReviewFileTarget | undefined,
): AddressedDocument | null {
  if (!result || result.kind === "unavailable") return null;
  if (draftOnly) {
    const tab = openDocumentFromDraftGroup({
      documentId: result.document.documentId,
      contextLocation: draftOnly.contextLocation,
      documentName: draftOnly.documentName,
    });
    return tab ? { document: tab, draftOnly: true } : null;
  }
  const canonical = canonicalDocumentAddress(address, result.document.entry);
  if (!canonical) return null;
  const document = result.document.entry;
  const scope = document.scope;
  const tab = openDocumentFromFile(
    canonical.destination.scheme,
    localFile ?? treeFileFromCatalogEntry(document),
    contextOwner(
      scope.kind === "work" ? scope.workId : undefined,
      scope.kind === "lineage" ? scope.rootThreadId : undefined,
    ),
  );
  return { document: tab, draftOnly: false };
}

export function ProjectAddressDocument({
  href,
  entryKey,
  address,
  result,
  draftItemKey,
  workId,
  navigation,
  onAdmission,
}: {
  href: string;
  entryKey: string;
  address: ProjectAddress;
  result: DocumentAddressResult | undefined;
  draftItemKey?: string;
  workId: string | null;
  navigation: ReturnType<typeof createProjectNavigation> | null;
  onAdmission: Dispatch<SetStateAction<AddressAdmission | null>>;
}) {
  const admissionInput = useRef({ address, result, draftItemKey });
  admissionInput.current = { address, result, draftItemKey };
  const admissionFingerprint = JSON.stringify({ result, draftItemKey });
  useEffect(() => {
    const { address, result, draftItemKey } = admissionInput.current;
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
    if (draftItemKey) {
      const next = { ...canonical, itemKey: draftItemKey };
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
  }, [href, entryKey, admissionFingerprint, workId, navigation, onAdmission]);
  return null;
}
