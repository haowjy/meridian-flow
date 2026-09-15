/** Publish an authorized address into the workspace; the document host owns live-session binding. */
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import {
  type DocumentAddressResult,
  isProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import { projectCatalogFile } from "@/client/query/useContextCatalog";
import { useContextTabsActions } from "@/client/stores";
import { contextTabFromFile } from "../context/context-tab-from-file";
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
  workId,
  workSlug,
  navigation,
  onAdmission,
}: {
  projectId: string;
  href: string;
  entryKey: string;
  address: ProjectAddress;
  result: DocumentAddressResult | undefined;
  localFile?: CatalogFile;
  workId: string | null;
  workSlug: string | null;
  navigation: ReturnType<typeof createProjectNavigation> | null;
  onAdmission: Dispatch<SetStateAction<AddressAdmission | null>>;
}) {
  const { openTab } = useContextTabsActions();
  const admissionInput = useRef({ address, result, localFile });
  admissionInput.current = { address, result, localFile };
  // Address/catalog projections are rebuilt from JSON snapshots. Their object
  // identity is not an admission event; only their serialized meaning is.
  const admissionFingerprint = JSON.stringify({ result, localFile });
  useEffect(() => {
    const { address, result, localFile } = admissionInput.current;
    if (!navigation || !result || result.kind === "unavailable") return;
    const ticket = navigation.captureForEntry(entryKey);
    if (!ticket) return;
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
    const routeWorkId =
      scope.kind === "work" ? scope.workId : scope.kind === "none" ? null : workId;
    void (async () => {
      const installed = openTab(
        projectId,
        contextTabFromFile(
          uri.value.scheme,
          mergeLocalResourceState(projectCatalogFile(document), localFile),
          routeWorkId,
        ),
        isCurrent,
      );
      if (controller.signal.aborted || !navigation.isCurrent(ticket)) return;
      if (installed.kind !== "opened") {
        publish("unavailable");
        return;
      }
      const next: ProjectAddress = {
        ...address,
        destination: {
          kind: "document",
          scheme: uri.value.scheme,
          path: document.path.join("/"),
          workSlug: uri.value.authority.kind === "work" ? uri.value.authority.workSlug : null,
        },
        work:
          scope.kind === "work" || scope.kind === "none"
            ? { kind: "absent" }
            : workSlug
              ? { kind: "slug", slug: workSlug }
              : { kind: "none" },
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
    workSlug,
    navigation,
    openTab,
    onAdmission,
  ]);
  return null;
}
