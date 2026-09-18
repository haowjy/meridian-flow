/** ChildReportBlock — the child's returned report, rendered as a title-less `TurnCard`. */
import type { ChildReportProps } from "@meridian/contracts/components";
import { FileText } from "lucide-react";
import { Markdown } from "@/rich-content/Markdown";
import type { ComponentBlockProps } from "./component-registry";
import { TurnCard } from "./TurnCard";

export function ChildReportBlock({ content }: ComponentBlockProps) {
  const props = content.props as ChildReportProps;
  return (
    <TurnCard icon={FileText} tone="resolved">
      {props.summary ? <Markdown variant="compact">{props.summary}</Markdown> : null}
    </TurnCard>
  );
}
