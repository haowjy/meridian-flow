/** Thread-scoped latest-request ownership for change-trail navigation. */
export class LatestNavigationCoordinator {
  private active: AbortController | null = null;

  run<T>(navigate: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.active?.abort();
    const request = new AbortController();
    this.active = request;
    return navigate(request.signal).finally(() => {
      if (this.active === request) this.active = null;
    });
  }

  dispose(): void {
    this.active?.abort();
    this.active = null;
  }
}
