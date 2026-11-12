/**
 * The Write | Chat switch swaps the panes: the two hosts trade grid areas with no remount
 * (`layout/SlotGrid.tsx`). This animates that change with the View Transitions API: each moving
 * host is a named group that glides from its old rect to its new one (`html[data-pane-swap]` in
 * `styles/globals.css` sets the 200ms ease-out and shows the new page throughout, with no fade).
 * Reduced motion, or a browser without the API, swaps at once.
 */

/** How long the flag outlives the transition: the hosts' enter animation has finished by then. */
const FLAG_LINGER_MS = 300;

/**
 * How long the screen may stay frozen on the old page while the navigation runs: the browser paints
 * nothing until the transition's update callback settles. A navigation slower than this lands
 * without the glide.
 */
const FREEZE_CAP_MS = 250;

const hostName = (host: HTMLElement) =>
  `host-${(host.dataset.projectHost ?? "").replace(/\W/g, "_")}`;

const noop = () => {};

/** Transitions in flight or lingering: a second press must not lose the flag to the first. */
let flagged = 0;

/** The next commit React makes from work that just settled, or soon after if no frame comes. */
const afterCommit = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
    setTimeout(resolve, 50);
  });

/**
 * Runs `update`, which moves the panes, inside a transition and returns what it settles with. The
 * transition ends at the commit after `update` settles, or after `FREEZE_CAP_MS`.
 */
export async function swapPanes<T>(update: () => Promise<T>): Promise<T> {
  if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches)
    return update();
  const hosts = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-project-host][data-project-surface-state="active"]',
    ),
  ].filter((host) => host.dataset.projectHost !== "sidebar");
  for (const host of hosts) host.style.viewTransitionName = hostName(host);
  const root = document.documentElement;
  root.dataset.paneSwap = "";
  flagged += 1;
  let result: Promise<T> | undefined;
  const transition = document.startViewTransition(async () => {
    result = update();
    await Promise.race([
      result.then(afterCommit, noop),
      new Promise((resolve) => setTimeout(resolve, FREEZE_CAP_MS)),
    ]);
    // A host the swap parks has no new rect to glide to: it goes without an animation.
    for (const host of hosts)
      if (host.dataset.projectSurfaceState === "parked") host.style.viewTransitionName = "";
  });
  // A transition a newer press skipped rejects these; its update has run all the same.
  void transition.ready.catch(noop);
  void transition.finished.catch(noop).finally(() => {
    for (const host of hosts) host.style.viewTransitionName = "";
    setTimeout(() => {
      flagged -= 1;
      if (flagged === 0) delete root.dataset.paneSwap;
    }, FLAG_LINGER_MS);
  });
  await transition.updateCallbackDone.catch(noop);
  return result as Promise<T>;
}
