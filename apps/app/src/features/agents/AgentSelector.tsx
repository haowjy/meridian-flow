/** Readonly Agent status presentation for chats with a frozen Agent binding. */
import { t } from "@lingui/core/macro";
import { forwardRef } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ResolvedAgentDisplay } from "./resolve-agent";

const selectorClass = "focus-ring max-w-[11rem] min-w-0 shrink font-medium";

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
