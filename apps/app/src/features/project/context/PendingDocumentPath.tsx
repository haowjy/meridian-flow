/** The address of an Editor destination whose document body is masked: breadcrumb navigation only. */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { folderAncestry, pathLeafName } from "../mobile/context-location";
import { MobileBreadcrumb, type MobileBreadcrumbSegment } from "../mobile/MobileBreadcrumb";
import { PaneHeader } from "../shell/PaneHeader";
import { schemeLabel } from "./context-schemes";

export function PendingDocumentPath({
  scheme,
  path,
  onSelectContextPath,
}: {
  scheme: ProjectContextTreeScheme;
  path: string | null;
  onSelectContextPath: (path: string, scheme: ProjectContextTreeScheme) => void;
}) {
  const browsable = scheme !== "scratch";
  const segments: MobileBreadcrumbSegment[] = [
    { label: t`Files`, onSelect: () => onSelectContextPath("", "kb") },
    {
      label: schemeLabel(scheme),
      ...(browsable ? { onSelect: () => onSelectContextPath("", scheme) } : {}),
    },
  ];
  if (path) {
    // Scratch ancestry needs catalog labels, which this masked address does not own yet.
    for (const folder of browsable ? folderAncestry(path.slice(0, path.lastIndexOf("/"))) : [])
      segments.push({
        label: folder.name,
        ...(browsable ? { onSelect: () => onSelectContextPath(folder.path, scheme) } : {}),
      });
    segments.push({ label: pathLeafName(path) });
  }
  return <PaneHeader title={<MobileBreadcrumb segments={segments} />} />;
}
