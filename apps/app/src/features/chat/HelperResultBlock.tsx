/** HelperResultBlock — background helper agent result, rendered as the shared spawn report card. */
import type { HelperResultProps } from "@meridian/contracts/components";
import { isArtifactRef } from "./ArtifactGrid";
import type { ComponentBlockProps } from "./component-registry";
import { SpawnReportCard } from "./SpawnReportCard";

export function HelperResultBlock({ content }: ComponentBlockProps) {
  const props = content.props as HelperResultProps;
  const artifacts = Array.isArray(props.artifacts) ? props.artifacts.filter(isArtifactRef) : [];
  return (
    <SpawnReportCard
      agentName={props.agentName}
      title={props.title ?? null}
      summary={props.summary ?? null}
      status={props.status}
      childThreadId={props.childThreadId ?? null}
      artifacts={artifacts}
    />
  );
}
