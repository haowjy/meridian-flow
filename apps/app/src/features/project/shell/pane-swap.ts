/**
 * The Write | Chat switch swaps the panes: the two hosts trade grid areas with no remount
 * (`layout/SlotGrid.tsx`). This animates that change with the View Transitions API: each moving
 * host is a named group that glides from its old rect to its new one (`html[data-pane-swap]` in
 * `styles/globals.css` sets the 200ms ease-out and shows the new page throughout, with no fade).
 * Reduced motion, or a browser without the API, swaps at once.
 */

/** How long the flag outlives the transition: the hosts' enter animation has finished by then. */
const FLAG_LINGER_MS = 300;

const hostName = (host: HTMLElement) =>
  `host-${(host.dataset.projectHost ?? "").replace(/\W/g, "_")}`;

/**
 * Runs `update`, which moves the panes and calls `done` once the new layout is committed, inside a
 * transition. `done` is called at most once; the transition ends when it has been.
 */
export function swapPanes(update: (done: () => void) => void): void {
  if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update(() => {});
    return;
  }
  const hosts = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-project-host][data-project-surface-state="active"]',
    ),
  ].filter((host) => host.dataset.projectHost !== "sidebar");
  for (const host of hosts) host.style.viewTransitionName = hostName(host);
  const root = document.documentElement;
  root.dataset.paneSwap = "";
  const transition = document.startViewTransition(
    () =>
      new Promise<void>((resolve) =>
        update(() => {
          // A host the swap parks has no new rect to glide to: it goes without an animation.
          for (const host of hosts)
            if (host.dataset.projectSurfaceState === "parked") host.style.viewTransitionName = "";
          resolve();
        }),
      ),
  );
  void transition.finished.finally(() => {
    for (const host of hosts) host.style.viewTransitionName = "";
    setTimeout(() => delete root.dataset.paneSwap, FLAG_LINGER_MS);
  });
}
