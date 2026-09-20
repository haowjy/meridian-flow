/** ChildReportBlock — the child's returned report, rendered as an `ArtifactCard` titled Return. */
import { Trans } from "@lingui/react/macro";
import type { ChildReportProps } from "@meridian/contracts/components";
import { FileText } from "lucide-react";
import { Markdown } from "@/rich-content/Markdown";
import { ArtifactCard } from "./ArtifactCard";
import { ArtifactGrid, isArtifactRef } from "./ArtifactGrid";
import type { ComponentBlockProps } from "./component-registry";

export function ChildReportBlock({ content }: ComponentBlockProps) {
  const props = content.props as ChildReportProps;
  const artifacts = Array.isArray(props.artifacts) ? props.artifacts.filter(isArtifactRef) : [];
  return (
    <ArtifactCard icon={FileText} tone="resolved" title={<Trans>Return</Trans>}>
      {props.summary ? <Markdown variant="compact">{props.summary}</Markdown> : null}
      {artifacts.length > 0 ? (
        <div className={props.summary ? "mt-3" : undefined}>
          <ArtifactGrid artifacts={artifacts} />
        </div>
      ) : null}
    </ArtifactCard>
  );
}
