// @ts-nocheck
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";

export type HomeHeroProps = {
  /** Headline. Omit for the default Home prompt. */
  title?: ReactNode;
  /** Line under the headline. Omit for the default supporting copy. */
  subtitle?: ReactNode;
  /** Slot for future dynamic content (workbench context, hints, etc.). */
  children?: ReactNode;
};

/**
 * Home hero block: headline + supporting text. Kept separate from {@link HomeView}
 * so copy and dynamic context can evolve without touching the thread list layout.
 */
export function HomeHero({ title, subtitle, children }: HomeHeroProps) {
  return (
    <header>
      <h1 className="text-headline-hero text-balance font-semibold tracking-tight text-foreground">
        {title ?? <Trans>What are you working on?</Trans>}
      </h1>
      <p className="text-body mt-2 max-w-[65ch] text-muted-foreground">
        {subtitle ?? (
          <Trans>
            Ask about your data, methods, or the next step in your work—plain language is enough.
          </Trans>
        )}
      </p>
      {children ? <div className="mt-3">{children}</div> : null}
    </header>
  );
}
