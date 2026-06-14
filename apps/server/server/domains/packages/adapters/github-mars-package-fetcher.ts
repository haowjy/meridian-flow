// @ts-nocheck
/**
 * GitHub Mars package fetcher adapter: resolves GitHub repo refs, downloads
 * codeload tarballs, and extracts them to temp directories for the package
 * domain's parse/sync pipeline. Token/env selection stays in composition;
 * this adapter only consumes explicit config.
 */
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import * as tar from "tar";

import type { FetchedMarsSource, MarsPackageFetcher } from "../ports/mars-package-fetcher.js";

export interface GitHubMarsPackageFetcherDeps {
  fetch?: typeof fetch;
  githubToken?: string;
}

export function createGitHubMarsPackageFetcher(
  deps: GitHubMarsPackageFetcherDeps = {},
): MarsPackageFetcher {
  const fetchImpl = deps.fetch ?? fetch;
  const token = deps.githubToken;

  return {
    async fetch(input) {
      const repo = parseGitHubRepoUrl(input.url);
      const ref = input.ref?.trim() || "main";
      const commitSha = await resolveCommitSha(fetchImpl, repo, ref, token);
      const tarball = await downloadTarball(fetchImpl, repo, commitSha, token);
      return extractTarballToTemp(tarball, commitSha);
    },
  };
}

export function parseGitHubRepoUrl(url: string): { owner: string; repo: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid GitHub package URL: ${url}`);
  }

  if (parsed.hostname !== "github.com") {
    throw new Error(`Unsupported package URL host (expected github.com): ${url}`);
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`GitHub package URL is missing owner/repo: ${url}`);
  }

  return { owner: segments[0], repo: segments[1].replace(/\.git$/, "") };
}

async function resolveCommitSha(
  fetchImpl: typeof fetch,
  repo: { owner: string; repo: string },
  ref: string,
  token?: string,
): Promise<string> {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(ref)}`,
    { headers: githubHeaders(token) },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to resolve GitHub ref "${ref}" for ${repo.owner}/${repo.repo}: HTTP ${response.status}`,
    );
  }
  const payload = (await response.json()) as { sha?: string };
  if (!payload.sha) {
    throw new Error(
      `GitHub commit resolution returned no SHA for ${repo.owner}/${repo.repo}@${ref}`,
    );
  }
  return payload.sha;
}

async function downloadTarball(
  fetchImpl: typeof fetch,
  repo: { owner: string; repo: string },
  commitSha: string,
  token?: string,
): Promise<Buffer> {
  const response = await fetchImpl(
    `https://codeload.github.com/${repo.owner}/${repo.repo}/tar.gz/${commitSha}`,
    { headers: githubHeaders(token) },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to download GitHub tarball for ${repo.owner}/${repo.repo}@${commitSha}: HTTP ${response.status}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function extractTarballToTemp(
  tarball: Buffer,
  commitSha: string,
): Promise<FetchedMarsSource> {
  const extractRoot = await mkdtemp(path.join(tmpdir(), "meridian-mars-fetch-"));
  const treeDir = path.join(extractRoot, "tree");

  try {
    await mkdir(treeDir, { recursive: true });
    await pipeline(
      Readable.from(tarball),
      createGunzip(),
      tar.extract({ cwd: treeDir, strict: true }),
    );
    const sourceDir = await resolvePackageRoot(treeDir);
    return {
      sourceDir,
      commitSha,
      cleanup: async () => {
        await rm(extractRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(extractRoot, { recursive: true, force: true });
    throw error;
  }
}

async function resolvePackageRoot(extractDir: string): Promise<string> {
  const entries = await readdir(extractDir, { withFileTypes: true });
  if (entries.length === 1 && entries[0]?.isDirectory()) {
    return path.join(extractDir, entries[0].name);
  }
  if (entries.some((entry) => entry.isFile() && entry.name === "mars.toml")) {
    return extractDir;
  }
  throw new Error("Extracted GitHub tarball does not contain a Mars package root");
}

function githubHeaders(token?: string): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "meridian-mars-fetcher",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}
