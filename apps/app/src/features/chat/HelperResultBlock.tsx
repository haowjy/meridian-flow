/** HelperResultBlock — background helper agent result, rendered as the shared spawn report card. */
import type { HelperResultProps } from "@meridian/contracts/components";
import type { ComponentBlockProps } from "./component-registry";
import { SpawnReportCard } from "./SpawnReportCard";

export function HelperResultBlock({ content }: ComponentBlockProps) {
  const props = content.props as HelperResultProps;
  return (
    <SpawnReportCard
      agentName={props.agentName}
      title={props.title ?? null}
      summary={props.summary}
      status={props.status}
      childThreadId={props.childThreadId}
    />
  );
}
