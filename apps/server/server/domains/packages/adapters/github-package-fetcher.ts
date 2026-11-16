import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
  type DroppedEntry,
  type FetchBudget,
  type FetchedTree,
  type FetchRequest,
  PackageFetchError,
  type PackageFetcher,
} from "../ports/package-fetcher.js";
import { readTar } from "./tar-reader.js";

const API_HOST = "api.github.com";
const ALLOWED_HOSTS = new Set(["github.com", API_HOST, "codeload.github.com"]);
const MAX_REDIRECTS = 5;
const MAX_TAG_HOPS = 5;
/** Ref and tag API bodies are small; a body past this is refused. */
const MAX_API_BYTES = 8 * 1024 * 1024;
/** A file over this is left out with a warning (foreign-import §1, stored package). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build"]);
const ARCHIVE_NAME = /\.(zip|tar(\.[a-z0-9]+)?|tgz)$/i;
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9._-]+$/;

type GitObject = { sha: string; type: string };
type ParsedUrl = { owner: string; repo: string; segments: string[] };

function parseGithubUrl(raw: string): ParsedUrl {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new PackageFetchError("bad-url", `Not a URL: ${raw}`);
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new PackageFetchError("host-refused", "Only https://github.com URLs can be imported");
  }
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        throw new PackageFetchError("bad-url", `Malformed percent-escape in ${part}`);
      }
    });
  const [owner, repoPart, kind, ...segments] = parts;
  const repo = repoPart?.replace(/\.git$/, "");
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) {
    throw new PackageFetchError("bad-url", "Expected https://github.com/<owner>/<repo>");
  }
  if (kind !== undefined && (kind !== "tree" || segments.length === 0)) {
    throw new PackageFetchError("bad-url", "Expected a repository, or /tree/<ref>[/<path>]");
  }
  return { owner, repo, segments };
}

/** Splits an archive or URL path into segments. Absolute paths and `..` are refused; `.` and empty segments vanish. */
function normalizeSegments(raw: string, what: string): string[] {
  if (raw.startsWith("/") || raw.includes("\0")) {
    throw new PackageFetchError("path-refused", `${what} is not a relative path: ${raw}`);
  }
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "..") {
      throw new PackageFetchError("path-refused", `${what} leaves its root: ${raw}`);
    }
    if (segment !== "" && segment !== ".") segments.push(segment);
  }
  return segments;
}

/** A skipped name matches a directory, so only the segments above the file count. */
const isSkipped = (segments: readonly string[]) =>
  segments.slice(0, -1).some((segment) => SKIPPED_DIRECTORIES.has(segment)) ||
  ARCHIVE_NAME.test(segments.at(-1) ?? "");

export function createGithubPackageFetcher(options: { token?: string } = {}): PackageFetcher {
  /** Follows redirects by hand so every hop is checked against the host list, and the token reaches only the API host. */
  async function request(url: string, budget: FetchBudget, accept: string): Promise<Response> {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const { hostname, protocol } = new URL(target);
      if (protocol !== "https:" || !ALLOWED_HOSTS.has(hostname)) {
        throw new PackageFetchError("host-refused", `Refusing to fetch from ${hostname}`);
      }
      const headers: Record<string, string> = {
        Accept: accept,
        "User-Agent": "meridian-flow",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (options.token && hostname === API_HOST) headers.Authorization = `Bearer ${options.token}`;
      let response: Response;
      try {
        response = await fetch(target, { headers, redirect: "manual", signal: budget.signal });
      } catch (error) {
        budget.checkTime();
        throw new PackageFetchError("upstream", `GitHub request failed: ${String(error)}`);
      }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        target = new URL(location, target).toString();
        continue;
      }
      return response;
    }
    throw new PackageFetchError("upstream", "Too many redirects");
  }

  async function failure(response: Response, what: string): Promise<PackageFetchError> {
    await response.body?.cancel();
    if (response.status === 404) {
      return new PackageFetchError("not-found", `${what} was not found on GitHub`);
    }
    if (
      response.status === 429 ||
      (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")
    ) {
      return new PackageFetchError(
        "rate-limited",
        "GitHub's rate limit is used up; set FLOW_GITHUB_TOKEN for a higher one",
      );
    }
    return new PackageFetchError("upstream", `GitHub answered ${response.status} for ${what}`);
  }

  async function api<T>(path: string, budget: FetchBudget): Promise<T> {
    const response = await request(
      `https://${API_HOST}${path}`,
      budget,
      "application/vnd.github+json",
    );
    if (!response.ok) throw await failure(response, path);
    return JSON.parse(await readCapped(response, budget)) as T;
  }

  /** Reads an API body, counting it toward the download budget and refusing one past `MAX_API_BYTES`. */
  async function readCapped(response: Response, budget: FetchBudget): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of Readable.fromWeb(
        (response.body ?? new Blob([]).stream()) as never,
      )) {
        size += (chunk as Buffer).length;
        if (size > MAX_API_BYTES) {
          throw new PackageFetchError("upstream", `GitHub's answer is over ${MAX_API_BYTES} bytes`);
        }
        budget.download((chunk as Buffer).length);
        chunks.push(chunk as Buffer);
      }
    } catch (error) {
      budget.checkTime();
      throw error;
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /** Every branch and tag whose name starts with `prefix`, by full name (`heads/x/y`). */
  async function matchingRefs(
    { owner, repo }: ParsedUrl,
    kind: "heads" | "tags",
    prefix: string,
    budget: FetchBudget,
  ): Promise<Map<string, GitObject>> {
    const refs = await api<{ ref: string; object: GitObject }[]>(
      `/repos/${owner}/${repo}/git/matching-refs/${kind}/${encodeURIComponent(prefix)}`,
      budget,
    );
    const found = new Map<string, GitObject>();
    for (const { ref, object } of refs) found.set(ref.slice(`refs/${kind}/`.length), object);
    return found;
  }

  /** A tag ref can name a tag object, which can name another: follow them to a commit. */
  async function peel(parsed: ParsedUrl, object: GitObject, budget: FetchBudget): Promise<string> {
    let current = object;
    for (let hop = 0; hop < MAX_TAG_HOPS && current.type === "tag"; hop += 1) {
      const tag = await api<{ object: GitObject }>(
        `/repos/${parsed.owner}/${parsed.repo}/git/tags/${current.sha}`,
        budget,
      );
      current = tag.object;
    }
    if (current.type !== "commit") {
      throw new PackageFetchError(
        "ref-not-found",
        `The ref points at a ${current.type}, not a commit`,
      );
    }
    return current.sha;
  }

  /** The longest leading run of segments that names a branch or tag is the ref; the rest is the path. */
  async function resolve(
    parsed: ParsedUrl,
    budget: FetchBudget,
  ): Promise<{ ref: string | null; commit: string; path: string[] }> {
    const { owner, repo, segments } = parsed;
    if (segments.length === 0) {
      const head = await api<{ sha: string }>(`/repos/${owner}/${repo}/commits/HEAD`, budget);
      return { ref: null, commit: head.sha, path: [] };
    }
    const first = segments[0] as string;
    const heads = await matchingRefs(parsed, "heads", first, budget);
    const tags = await matchingRefs(parsed, "tags", first, budget);
    for (let length = segments.length; length >= 1; length -= 1) {
      const name = segments.slice(0, length).join("/");
      const object = heads.get(name) ?? tags.get(name);
      if (object) {
        return {
          ref: name,
          commit: await peel(parsed, object, budget),
          path: segments.slice(length),
        };
      }
    }
    if (SHA.test(first)) return { ref: null, commit: first, path: segments.slice(1) };
    throw new PackageFetchError(
      "ref-not-found",
      `No branch or tag of ${owner}/${repo} starts the path ${segments.join("/")}`,
    );
  }

  async function download(
    { owner, repo }: ParsedUrl,
    commit: string,
    root: readonly string[],
    budget: FetchBudget,
  ): Promise<{ files: Map<string, Uint8Array>; dropped: DroppedEntry[]; sawFile: boolean }> {
    const response = await request(
      `https://codeload.github.com/${owner}/${repo}/tar.gz/${commit}`,
      budget,
      "application/x-gzip",
    );
    if (!response.ok || !response.body) throw await failure(response, `${owner}/${repo}@${commit}`);

    const files = new Map<string, Uint8Array>();
    const dropped: DroppedEntry[] = [];
    let sawFile = false;
    const seen = new Set<string>();

    // An abort of the request's signal surfaces mid-stream as an AbortError; the budget names it.
    try {
      await pipeline(
        Readable.fromWeb(response.body as never),
        async function* countDownload(chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            budget.download(chunk.length);
            yield chunk;
          }
        },
        createGunzip(),
        async function* countExpanded(chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            budget.expanded(chunk.length);
            budget.checkTime();
            yield chunk;
          }
        },
        (chunks: AsyncIterable<Buffer>) =>
          readTar(chunks, async (entry) => {
            budget.entry();
            // GitHub wraps every entry in `<repo>-<sha>/`.
            const [, ...inRepo] = normalizeSegments(entry.name, "An archive entry");
            const key = inRepo.join("/");
            if (entry.type === "directory" || inRepo.length === 0) {
              await entry.skip();
              return;
            }
            if (entry.type !== "link") {
              if (seen.has(key)) {
                throw new PackageFetchError("path-refused", `Two archive entries are ${key}`);
              }
              seen.add(key);
            }
            if (!root.every((segment, index) => inRepo[index] === segment)) {
              await entry.skip();
              return;
            }
            const relative = inRepo.slice(root.length);
            if (relative.length === 0) {
              sawFile ||= entry.type === "file";
              await entry.skip();
              return;
            }
            if (isSkipped(relative) || entry.type === "other") {
              await entry.skip();
              return;
            }
            const path = relative.join("/");
            if (entry.type === "link") {
              dropped.push({ path, reason: "link" });
              await entry.skip();
              return;
            }
            if (entry.size > MAX_FILE_BYTES) {
              dropped.push({ path, reason: "too-large" });
              await entry.skip();
              return;
            }
            files.set(path, await entry.body());
          }),
      );
    } catch (error) {
      budget.checkTime();
      throw error;
    }
    return { files, dropped, sawFile };
  }

  return {
    async fetchTree({ url, pin }: FetchRequest, budget: FetchBudget): Promise<FetchedTree> {
      const parsed = parseGithubUrl(url);
      // A pin already holds the split, so no ref call is made and a deleted branch can't fail it.
      const resolved = pin
        ? { ref: pin.ref, commit: pin.commit, path: pin.path.split("/") }
        : await resolve(parsed, budget);
      const path = normalizeSegments(resolved.path.join("/"), "The URL path");
      const at = resolved.commit;
      if (!SHA.test(at)) throw new PackageFetchError("bad-url", `Not a full commit SHA: ${at}`);
      const { files, dropped, sawFile } = await download(parsed, at, path, budget);
      if (files.size === 0 && dropped.length === 0 && path.length > 0) {
        throw new PackageFetchError(
          "path-not-found",
          sawFile
            ? `${path.join("/")} is a file, not a directory`
            : `${path.join("/")} is not in ${parsed.owner}/${parsed.repo} at ${at}`,
        );
      }
      return {
        commit: at,
        repo: `${parsed.owner}/${parsed.repo}`,
        ref: resolved.ref,
        path: path.join("/"),
        files: Object.fromEntries(files),
        dropped,
      };
    },
  };
}
