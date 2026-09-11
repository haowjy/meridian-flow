/** Admit a resolved bookmark by stable ID, then repair only the browser entry that requested it. */
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import {
  type DocumentAddressResult,
  isProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { type Dispatch, type SetStateAction, useEffect } from "react";
import { useOpenProjectDocument } from "../context/open-project-document";
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
  const open = useOpenProjectDocument(projectId);
  useEffect(() => {
    if (!navigation || !result || result.kind === "unavailable") return;
    const ticket = navigation.captureForEntry({ href, key: entryKey });
    if (!ticket) return;
    const identity = { href, key: entryKey, documentId: result.document.documentId };
    const controller = new AbortController();
    onAdmission({ ...identity, issue: "loading" });
    void open({
      documentId: result.document.documentId,
      workId,
      disposition: "background",
      signal: controller.signal,
    })
      .then((opened) => {
        if (controller.signal.aborted || !navigation.isCurrent(ticket)) return;
        if (opened.kind !== "opened" && opened.kind !== "not-editable") {
          onAdmission({ ...identity, issue: "unavailable" });
          return;
        }
        const uri = parseUnifiedContextUri(opened.document.uri);
        if (!uri.ok || !isProjectContextTreeScheme(uri.value.scheme)) {
          onAdmission({ ...identity, issue: "unavailable" });
          return;
        }
        const scope = opened.document.scope;
        const next: ProjectAddress = {
          ...address,
          destination: {
            kind: "document",
            scheme: uri.value.scheme,
            path: opened.document.path.join("/"),
            workSlug: uri.value.authority.kind === "work" ? uri.value.authority.workSlug : null,
          },
          work:
            scope.kind === "work" || scope.kind === "none"
              ? { kind: "absent" }
              : workSlug
                ? { kind: "slug", slug: workSlug }
                : { kind: "none" },
        };
        onAdmission({ ...identity, issue: undefined });
        if (projectAddressHref(next) !== href) void navigation.replaceIfCurrent(ticket, next);
      })
      .catch(() => {
        if (!controller.signal.aborted && navigation.isCurrent(ticket))
          onAdmission({ ...identity, issue: "error" });
      });
    return () => controller.abort();
  }, [projectId, href, entryKey, result, workId, workSlug, navigation, open, onAdmission]);
  return null;
}
