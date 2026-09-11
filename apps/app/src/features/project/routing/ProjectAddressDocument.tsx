/** Publish an authorized address into the desk; the document host owns live-session binding. */
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import {
  type DocumentAddressResult,
  isProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { type Dispatch, type SetStateAction, useEffect } from "react";
import { projectCatalogFile } from "@/client/query/useContextCatalog";
import { useContextTabsActions } from "@/client/stores";
import { contextTabFromFile } from "../context/context-tab-from-file";
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
  workId: string | null;
  workSlug: string | null;
  navigation: ReturnType<typeof createProjectNavigation> | null;
  onAdmission: Dispatch<SetStateAction<AddressAdmission | null>>;
}) {
  const { openTab } = useContextTabsActions();
  useEffect(() => {
    if (!navigation || !result || result.kind === "unavailable") return;
    const ticket = navigation.captureForEntry({ href, key: entryKey });
    if (!ticket) return;
    const identity = { href, key: entryKey, documentId: result.document.documentId };
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && navigation.isCurrent(ticket);
    onAdmission({ ...identity, issue: "loading" });
    const document = result.document.entry;
    const uri = parseUnifiedContextUri(document.uri);
    if (!uri.ok || !isProjectContextTreeScheme(uri.value.scheme)) {
      onAdmission({ ...identity, issue: "unavailable" });
      return;
    }
    const scope = document.scope;
    const routeWorkId =
      scope.kind === "work" ? scope.workId : scope.kind === "none" ? null : workId;
    void openTab(
      projectId,
      contextTabFromFile(uri.value.scheme, projectCatalogFile(document), routeWorkId),
      isCurrent,
    )
      .then(async () => {
        if (controller.signal.aborted || !navigation.isCurrent(ticket)) return;
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
            onAdmission({ ...identity, issue: "error" });
        } else {
          onAdmission({ ...identity, issue: undefined });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && navigation.isCurrent(ticket))
          onAdmission({ ...identity, issue: "error" });
      });
    return () => controller.abort();
  }, [projectId, href, entryKey, result, workId, workSlug, navigation, openTab, onAdmission]);
  return null;
}
