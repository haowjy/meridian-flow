/** Agent toolbar presentations with separate interactive and readonly contracts. */
import { t } from "@lingui/core/macro";
import { ChevronDown } from "lucide-react";
import { forwardRef } from "react";
import type { ComposerToolbarTriggerBinding } from "@/components/app/composer-toolbar";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ResolvedAgentDisplay } from "./resolve-agent";

const selectorClass = "focus-ring max-w-[11rem] min-w-0 shrink font-medium";

export function AgentPanelTrigger({
  agent,
  binding,
}: {
  agent: ResolvedAgentDisplay;
  binding: ComposerToolbarTriggerBinding;
}) {
  return (
    <button
      type="button"
      aria-label={t`Agent: ${agent.name}`}
      className={cn(buttonVariants({ variant: "outline", size: "sm" }), selectorClass)}
      ref={binding.ref}
      {...binding.buttonProps}
    >
      <span className="min-w-0 truncate">{agent.name}</span>
      <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}

export const AgentReadonlyStatus = forwardRef<
  HTMLButtonElement,
  { agent: ResolvedAgentDisplay; tooltip: string }
>(function AgentReadonlyStatus({ agent, tooltip }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-disabled="true"
      title={tooltip}
      aria-label={t`Agent: ${agent.name}`}
      className={cn(
        buttonVariants({ variant: "outline", size: "sm" }),
        selectorClass,
        "cursor-default border-transparent bg-transparent text-muted-foreground opacity-60 shadow-none hover:border-transparent hover:bg-transparent",
      )}
    >
      <span className="min-w-0 truncate">{agent.name}</span>
    </button>
  );
});
