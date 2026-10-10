/** Publish an authorized address into the workspace; the document host owns live-session binding. */
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import {
  contextOwner,
  type DocumentAddressResult,
  isProjectContextTreeScheme,
  isWorkScopedProjectContextScheme,
} from "@meridian/contracts/protocol";
import { type ParsedRequestId, parseRequestId } from "@meridian/contracts/request-id";
import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import { projectCatalogFile } from "@/client/query/useContextCatalog";
import { useContextTabsActions } from "@/client/stores";
import { contextTabFromFile } from "../context/context-tab-from-file";
import { mergeLocalResourceState } from "./local-document-address";
import type { ProjectRouteIssue } from "./ProjectRouteBoundary";
import { type ProjectAddress, projectAddressHref } from "./project-address";
import { workSelectionFor } from "./project-address-resolution";
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
    if (draftOnlyId) {
      // No tab and no live room: the address carries the draft and
      // EditorReviewAddressOwner opens its review.
      if (address.draftId !== draftOnlyId)
        void navigation.replaceIfCurrent(ticket, { ...address, draftId: draftOnlyId });
      return;
    }
    const identity = { href, key: entryKey, documentId: result.document.documentId };
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && navigation.isCurrent(ticket);
    const publish = (issue: ProjectRouteIssue | undefined) => onAdmission({ ...identity, issue });
    publish("loading");
    const document = result.document.entry;
    const uri = parseUnifiedContextUri(document.uri);
    if (!uri.ok || !isProjectContextTreeScheme(uri.value.scheme)) {
      publish("unavailable");
      return;
    }
    const scope = document.scope;
    const tabWorkId = scope.kind === "work" ? scope.workId : undefined;
    const lineageId = scope.kind === "lineage" ? scope.rootThreadId : undefined;
    void (async () => {
      const installed = openTab(
        projectId,
        contextTabFromFile(
          uri.value.scheme,
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
      const destination: ProjectAddress["destination"] = {
        kind: "document",
        scheme: uri.value.scheme,
        path: document.path.join("/"),
      };
      // A chat's Scratch is addressed by its lineage; the Editor's own Work stays implicit.
      const { lineage: _previousLineage, ...previous } = address;
      const next: ProjectAddress = lineageId
        ? {
            ...previous,
            destination,
            work: { kind: "absent" },
            ...(parseRequestId(lineageId)
              ? { lineage: parseRequestId(lineageId) as ParsedRequestId }
              : {}),
          }
        : {
            ...previous,
            destination,
            work: workSelectionFor(
              destination,
              scope.kind === "work" && isWorkScopedProjectContextScheme(uri.value.scheme)
                ? scope.workId
                : workId,
              noWorkId,
            ),
          };
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
    workId,
    noWorkId,
    navigation,
    openTab,
    onAdmission,
  ]);
  return null;
}
