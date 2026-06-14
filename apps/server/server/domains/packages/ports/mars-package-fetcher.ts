// @ts-nocheck
/**
 * Mars package fetcher port: the package domain's narrow dependency for
 * materializing remote package sources before parsing. Concrete transports
 * (GitHub today) are adapters injected by composition.
 */
export interface FetchedMarsSource {
  sourceDir: string;
  commitSha: string;
  cleanup: () => Promise<void>;
}

export interface MarsPackageFetcher {
  fetch(input: { url: string; ref?: string }): Promise<FetchedMarsSource>;
}

/** Test helper: materialize a local directory as a fetched remote source. */
export function fetchedMarsSourceFromDirectory(
  sourceDir: string,
  commitSha: string,
): FetchedMarsSource {
  return {
    sourceDir,
    commitSha,
    cleanup: async () => undefined,
  };
}
