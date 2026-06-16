/** HelperResultBlock — compact inline result card for background helper agents. */
import type { HelperResultProps } from "@meridian/contracts/components";
import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import { Markdown } from "@/rich-content/Markdown";
import type { ComponentBlockProps } from "./component-registry";

export function HelperResultBlock({ content }: ComponentBlockProps) {
  const props = content.props as HelperResultProps;
  const status = props.status;
  const Icon =
    status === "completed" ? CheckCircle2 : status === "failed" ? CircleAlert : LoaderCircle;
  const label = props.title ?? props.agentName ?? props.agentSlug;

  return (
    <section
      className="my-2 rounded-lg border border-subtle bg-surface-subtle px-3 py-2"
      data-helper-result
      data-helper-agent={props.agentSlug}
      data-helper-thread={props.childThreadId}
    >
      <div className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        <span>{props.agentName}</span>
        <span aria-hidden>·</span>
        <span>{label}</span>
      </div>
      {props.summary ? (
        <div className="mt-1 text-[13px] leading-relaxed text-foreground">
          <Markdown variant="compact">{props.summary}</Markdown>
        </div>
      ) : null}
    </section>
  );
}
