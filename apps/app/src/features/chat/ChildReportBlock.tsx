/** ChildReportBlock — the child's returned report, rendered as an `ArtifactCard` titled Return. */
import { Trans } from "@lingui/react/macro";
import type { ChildReportProps } from "@meridian/contracts/components";
import { FileText } from "lucide-react";
import { Markdown } from "@/rich-content/Markdown";
import { ArtifactCard } from "./ArtifactCard";
import type { ComponentBlockProps } from "./component-registry";

export function ChildReportBlock({ content }: ComponentBlockProps) {
  const props = content.props as ChildReportProps;
  return (
    <ArtifactCard icon={FileText} tone="resolved" title={<Trans>Return</Trans>}>
      {props.summary ? <Markdown variant="compact">{props.summary}</Markdown> : null}
    </ArtifactCard>
  );
}
