import express from "express";
import multer from "multer";
import { createReadStream, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { lookup as mimeLookup } from "mime-types";

function parseIntegerFromEnv(
  envName: string,
  fallbackValue: number,
  options: { min: number; max?: number },
): number {
  const rawValue = process.env[envName];
  const parsedValue = Number.parseInt(rawValue ?? String(fallbackValue), 10);
  if (!Number.isInteger(parsedValue)) {
    throw new Error(`Invalid ${envName}: expected integer`);
  }
  if (parsedValue < options.min) {
    throw new Error(`Invalid ${envName}: must be >= ${options.min}`);
  }
  if (options.max !== undefined && parsedValue > options.max) {
    throw new Error(`Invalid ${envName}: must be <= ${options.max}`);
  }
  return parsedValue;
}

const REPO_ROOT = path.resolve(process.env.REPO_ROOT ?? process.cwd());
const HOST = "127.0.0.1";
const PORT = parseIntegerFromEnv("REMOTE_WS_PORT", 18080, { min: 1, max: 65535 });
const MAX_PREVIEW_BYTES = parseIntegerFromEnv("REMOTE_WS_MAX_PREVIEW_BYTES", 1_048_576, {
  min: 1,
});
const MAX_UPLOAD_BYTES = parseIntegerFromEnv("REMOTE_WS_MAX_UPLOAD_BYTES", 26_214_400, {
  min: 1,
});
const MAX_TREE_ENTRIES = parseIntegerFromEnv("REMOTE_WS_MAX_TREE_ENTRIES", 5000, {
  min: 1,
});
const CLIPBOARD_DIRECTORY_NAME = ".clipboard";
const CLIPBOARD_DIRECTORY_PATH = path.resolve(REPO_ROOT, CLIPBOARD_DIRECTORY_NAME);
const SCREENSHOTS_DIRECTORY_NAME = ".playwright-mcp";
const SCREENSHOTS_DIRECTORY_PATH = path.resolve(REPO_ROOT, SCREENSHOTS_DIRECTORY_NAME);
const ALLOWED_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".heic",
  ".heif",
  ".avif",
]);

type Entry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  modifiedAt: string;
};

const app = express();
app.use(express.json({ limit: "256kb" }));
const execFileAsync = promisify(execFile);

function getSingleQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

function toRepoRelativePath(absPath: string): string {
  const relative = path.relative(REPO_ROOT, absPath);
  if (!relative) {
    return "";
  }
  return relative.split(path.sep).join("/");
}

function isHiddenRepoRelativePath(repoRelativePath: string): boolean {
  if (!repoRelativePath) {
    return false;
  }
  return repoRelativePath.split("/").some((segment) => segment.startsWith("."));
}

function isBlockedHiddenRepoRelativePath(repoRelativePath: string): boolean {
  return isHiddenRepoRelativePath(repoRelativePath);
}

function parseGitIgnoredStdout(stdout: string | Buffer | undefined): Set<string> {
  if (!stdout) {
    return new Set();
  }
  return new Set(
    String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

async function getGitIgnoredPathSet(repoRelativePaths: string[]): Promise<Set<string>> {
  const normalizedPaths = Array.from(new Set(repoRelativePaths.filter(Boolean)));
  if (normalizedPaths.length === 0) {
    return new Set();
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", REPO_ROOT, "check-ignore", "--", ...normalizedPaths],
      { maxBuffer: 1024 * 1024 },
    );
    return parseGitIgnoredStdout(stdout);
  } catch (error) {
    const gitError = error as NodeJS.ErrnoException & { stdout?: string | Buffer };
    return parseGitIgnoredStdout(gitError.stdout);
  }
}

async function assertPathAccessible(
  absPath: string,
  options?: { allowHidden?: boolean; allowGitIgnored?: boolean },
): Promise<void> {
  const repoRelativePath = toRepoRelativePath(absPath);

  if (!options?.allowHidden && isBlockedHiddenRepoRelativePath(repoRelativePath)) {
    throw new Error("Hidden paths are not accessible");
  }
  if (!options?.allowGitIgnored && repoRelativePath) {
    const ignoredPathSet = await getGitIgnoredPathSet([repoRelativePath]);
    if (ignoredPathSet.has(repoRelativePath)) {
      throw new Error("Gitignored paths are not accessible");
    }
  }
}

function isWithinRepo(absPath: string): boolean {
  const relative = path.relative(REPO_ROOT, absPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolveRepoPath(relativePath: string | undefined): string {
  const input = (relativePath ?? "").trim();
  if (input.includes("\u0000")) {
    throw new Error("Path contains null byte");
  }

  const resolved = path.resolve(REPO_ROOT, input);
  if (!isWithinRepo(resolved)) {
    throw new Error("Path escapes repository root");
  }
  return resolved;
}

function sanitizeUploadFilename(originalName: string): string {
  const stripped = path.basename(originalName).replace(/[\u0000-\u001f]/g, "");
  const cleaned = stripped.trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return `upload-${Date.now()}`;
  }
  return cleaned;
}

function validateUploadFilename(fileName: string): string | null {
  if (!fileName) {
    return "Filename is required";
  }
  if (/\s/.test(fileName)) {
    return "Filename cannot contain spaces";
  }
  if (fileName === "." || fileName === ".." || fileName.startsWith(".")) {
    return "Filename is invalid";
  }
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
    return "Filename may only contain letters, numbers, dot, underscore, and dash";
  }
  const extension = path.extname(fileName).toLowerCase();
  if (!extension || !ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
    return "Filename must use an allowed image extension";
  }
  return null;
}

function isLikelyBinary(buffer: Buffer): boolean {
  for (const byte of buffer) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

async function ensureDirectory(
  absPath: string,
  options?: { allowHidden?: boolean; allowGitIgnored?: boolean },
): Promise<void> {
  const stats = await fs.stat(absPath);
  if (!stats.isDirectory()) {
    throw new Error("Target path is not a directory");
  }
  const realPath = await fs.realpath(absPath);
  if (!isWithinRepo(realPath)) {
    throw new Error("Resolved path escapes repository root");
  }
  await assertPathAccessible(realPath, options);
}

async function ensureFile(
  absPath: string,
  options?: { allowHidden?: boolean; allowGitIgnored?: boolean },
): Promise<void> {
  const stats = await fs.stat(absPath);
  if (!stats.isFile()) {
    throw new Error("Target path is not a file");
  }
  const realPath = await fs.realpath(absPath);
  if (!isWithinRepo(realPath)) {
    throw new Error("Resolved path escapes repository root");
  }
  await assertPathAccessible(realPath, options);
}

const storage = multer.diskStorage({
  destination: async (req, _file, callback) => {
    try {
      await ensureClipboardDirectoryReady();
      (req as express.Request & { uploadDirectoryPath?: string }).uploadDirectoryPath =
        CLIPBOARD_DIRECTORY_PATH;
      callback(null, CLIPBOARD_DIRECTORY_PATH);
    } catch (error) {
      callback(error as Error, "");
    }
  },
  filename: (req, file, callback) => {
    const uploadDirectoryPath = (
      req as express.Request & { uploadDirectoryPath?: string }
    ).uploadDirectoryPath;
    if (!uploadDirectoryPath) {
      callback(new Error("Upload directory unavailable"), "");
      return;
    }

    const requestedName = getSingleQueryValue(req.query.name);
    if (!requestedName) {
      callback(new Error("Missing required query parameter: name"), "");
      return;
    }
    const sanitizedRequestedName = sanitizeUploadFilename(requestedName ?? "");
    const validationError = validateUploadFilename(sanitizedRequestedName);
    if (validationError) {
      callback(new Error(validationError), "");
      return;
    }

    const targetPath = path.join(uploadDirectoryPath, sanitizedRequestedName);
    if (existsSync(targetPath)) {
      callback(new Error("Filename already exists"), "");
      return;
    }

    callback(null, sanitizedRequestedName);
  },
});

const upload = multer({
  storage,
  limits: {
    files: 1,
    fileSize: MAX_UPLOAD_BYTES,
  },
  fileFilter: (_req, file, callback) => {
    const isImageMime = file.mimetype.startsWith("image/");
    const originalExtension = path.extname(file.originalname).toLowerCase();
    if (
      !isImageMime ||
      (originalExtension !== "" && !ALLOWED_IMAGE_EXTENSIONS.has(originalExtension))
    ) {
      callback(new Error("Only image uploads are allowed"));
      return;
    }
    callback(null, true);
  },
});
const clipboardUploadMiddleware = upload.fields([
  { name: "file", maxCount: 1 },
  { name: "files", maxCount: 1 },
]);

function handleClipboardUpload(req: express.Request, res: express.Response): void {
  const requestFiles = req.files as Record<string, Express.Multer.File[]> | undefined;
  const uploadedFile = requestFiles?.file?.[0] ?? requestFiles?.files?.[0];
  if (!uploadedFile) {
    res.status(400).json({ error: "Missing upload file" });
    return;
  }

  const uploaded = {
    name: uploadedFile.filename,
    path: toRepoRelativePath(uploadedFile.path),
    size: uploadedFile.size,
  };

  const uploadDirectoryPath = (
    req as express.Request & { uploadDirectoryPath?: string }
  ).uploadDirectoryPath;

  res.json({
    directory: uploadDirectoryPath ? toRepoRelativePath(uploadDirectoryPath) : "",
    uploaded: [uploaded],
  });
}

async function ensureClipboardDirectoryReady(): Promise<void> {
  await fs.mkdir(CLIPBOARD_DIRECTORY_PATH, { recursive: true });
  await ensureDirectory(CLIPBOARD_DIRECTORY_PATH, {
    allowHidden: true,
    allowGitIgnored: true,
  });
}

type TreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
};

function buildTreeFromPaths(filePaths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", type: "directory", children: [] };

  for (const filePath of filePaths) {
    const segments = filePath.split("/");
    let current = root;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isFile = i === segments.length - 1;
      const currentPath = segments.slice(0, i + 1).join("/");

      if (!current.children) {
        current.children = [];
      }

      let existing = current.children.find((c) => c.name === segment);
      if (!existing) {
        existing = {
          name: segment,
          path: currentPath,
          type: isFile ? "file" : "directory",
          ...(isFile ? {} : { children: [] }),
        };
        current.children.push(existing);
      } else if (!isFile && !existing.children) {
        // Was added as a file but now needs to be a directory (shouldn't happen, but safe)
        existing.type = "directory";
        existing.children = [];
      }

      if (!isFile) {
        current = existing;
      }
    }
  }

  return root;
}

function sortTree(node: TreeNode): void {
  if (!node.children) return;
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  for (const child of node.children) {
    sortTree(child);
  }
}

app.get("/api/tree", async (_req, res) => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", REPO_ROOT, "ls-files", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 10 * 1024 * 1024 },
    );

    const allPaths = String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    // Filter hidden paths
    const visiblePaths = allPaths.filter((p) => !isHiddenRepoRelativePath(p));

    const truncated = visiblePaths.length > MAX_TREE_ENTRIES;
    const paths = truncated ? visiblePaths.slice(0, MAX_TREE_ENTRIES) : visiblePaths;

    const root = buildTreeFromPaths(paths);
    sortTree(root);

    res.json({
      root,
      totalFiles: visiblePaths.length,
      truncated,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build file tree";
    res.status(400).json({ error: message });
  }
});

app.get("/api/list", async (req, res) => {
  try {
    const requestedPath = getSingleQueryValue(req.query.path);
    const directoryPath = resolveRepoPath(requestedPath);
    await ensureDirectory(directoryPath);

    const dirEntries = await fs.readdir(directoryPath, { withFileTypes: true });
    const candidates: Array<{
      childPath: string;
      childRepoRelativePath: string;
      isDirectory: boolean;
      name: string;
    }> = [];
    const entries: Entry[] = [];
    let skippedSymlinks = 0;
    let skippedHidden = 0;
    let skippedIgnored = 0;

    for (const dirEntry of dirEntries) {
      if (dirEntry.isSymbolicLink()) {
        skippedSymlinks += 1;
        continue;
      }
      const childPath = path.join(directoryPath, dirEntry.name);
      const childRepoRelativePath = toRepoRelativePath(childPath);
      if (isBlockedHiddenRepoRelativePath(childRepoRelativePath)) {
        skippedHidden += 1;
        continue;
      }
      if (!dirEntry.isDirectory() && !dirEntry.isFile()) {
        continue;
      }

      candidates.push({
        childPath,
        childRepoRelativePath,
        isDirectory: dirEntry.isDirectory(),
        name: dirEntry.name,
      });
    }

    const ignoredPathSet = await getGitIgnoredPathSet(
      candidates.map((candidate) => candidate.childRepoRelativePath),
    );

    for (const candidate of candidates) {
      if (ignoredPathSet.has(candidate.childRepoRelativePath)) {
        skippedIgnored += 1;
        continue;
      }

      let childStats;
      try {
        childStats = await fs.stat(candidate.childPath);
      } catch {
        // The file may disappear between readdir and stat (race with external writers).
        continue;
      }

      entries.push({
        name: candidate.name,
        path: candidate.childRepoRelativePath,
        type: candidate.isDirectory ? "directory" : "file",
        size: childStats.size,
        modifiedAt: childStats.mtime.toISOString(),
      });
    }

    entries.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });

    const currentPath = toRepoRelativePath(directoryPath);
    const parentPath = currentPath
      ? toRepoRelativePath(path.dirname(directoryPath))
      : null;

    res.json({
      currentPath,
      parentPath,
      entries,
      skippedSymlinks,
      skippedHidden,
      skippedIgnored,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list";
    res.status(400).json({ error: message });
  }
});

app.get("/api/clipboard/list", async (_req, res) => {
  try {
    await ensureClipboardDirectoryReady();
    const dirEntries = await fs.readdir(CLIPBOARD_DIRECTORY_PATH, {
      withFileTypes: true,
    });
    const entries: Entry[] = [];

    for (const dirEntry of dirEntries) {
      if (!dirEntry.isFile()) {
        continue;
      }
      const extension = path.extname(dirEntry.name).toLowerCase();
      if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
        continue;
      }

      const absPath = path.join(CLIPBOARD_DIRECTORY_PATH, dirEntry.name);
      let stats;
      try {
        stats = await fs.stat(absPath);
      } catch {
        continue;
      }

      entries.push({
        name: dirEntry.name,
        path: toRepoRelativePath(absPath),
        type: "file",
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
    }

    entries.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
    res.json({
      directory: CLIPBOARD_DIRECTORY_NAME,
      entries,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to list clipboard";
    res.status(400).json({ error: message });
  }
});

app.get("/api/clipboard/file", async (req, res) => {
  try {
    const requestedName = getSingleQueryValue(req.query.name);
    if (!requestedName) {
      res.status(400).json({ error: "Missing ?name=..." });
      return;
    }

    await ensureClipboardDirectoryReady();
    const safeName = sanitizeUploadFilename(requestedName);
    const validationError = validateUploadFilename(safeName);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const absPath = path.join(CLIPBOARD_DIRECTORY_PATH, safeName);
    await ensureFile(absPath, { allowHidden: true, allowGitIgnored: true });
    const stats = await fs.stat(absPath);

    const mimeType = mimeLookup(absPath) || "application/octet-stream";
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(stats.size));
    await pipeline(createReadStream(absPath), res);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to stream clipboard file";
    if (!res.headersSent) {
      res.status(400).json({ error: message });
      return;
    }
    res.destroy();
  }
});

app.get("/api/screenshots/list", async (_req, res) => {
  try {
    const dirEntries = await fs.readdir(SCREENSHOTS_DIRECTORY_PATH, {
      withFileTypes: true,
    }).catch(() => [] as never[]);

    const entries: Entry[] = [];
    for (const dirEntry of dirEntries) {
      if (!dirEntry.isFile()) continue;
      const extension = path.extname(dirEntry.name).toLowerCase();
      if (!ALLOWED_IMAGE_EXTENSIONS.has(extension)) continue;

      const absPath = path.join(SCREENSHOTS_DIRECTORY_PATH, dirEntry.name);
      let stats;
      try {
        stats = await fs.stat(absPath);
      } catch {
        continue;
      }

      entries.push({
        name: dirEntry.name,
        path: `${SCREENSHOTS_DIRECTORY_NAME}/${dirEntry.name}`,
        type: "file",
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
    }

    entries.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
    res.json({
      directory: SCREENSHOTS_DIRECTORY_NAME,
      entries,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to list screenshots";
    res.status(400).json({ error: message });
  }
});

app.get("/api/screenshots/file", async (req, res) => {
  try {
    const requestedName = getSingleQueryValue(req.query.name);
    if (!requestedName) {
      res.status(400).json({ error: "Missing ?name=..." });
      return;
    }

    const safeName = sanitizeUploadFilename(requestedName);
    const absPath = path.join(SCREENSHOTS_DIRECTORY_PATH, safeName);

    // Ensure it exists, is a file, and stays within the screenshots directory
    const stats = await fs.stat(absPath);
    if (!stats.isFile()) {
      res.status(400).json({ error: "Not a file" });
      return;
    }
    const realPath = await fs.realpath(absPath);
    if (!realPath.startsWith(SCREENSHOTS_DIRECTORY_PATH)) {
      res.status(400).json({ error: "Path escapes screenshots directory" });
      return;
    }

    const mimeType = mimeLookup(absPath) || "application/octet-stream";
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(stats.size));
    await pipeline(createReadStream(absPath), res);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to stream screenshot";
    if (!res.headersSent) {
      res.status(400).json({ error: message });
      return;
    }
    res.destroy();
  }
});

app.get("/api/text", async (req, res) => {
  try {
    const requestedPath = getSingleQueryValue(req.query.path);
    if (!requestedPath) {
      res.status(400).json({ error: "Missing ?path=..." });
      return;
    }

    const absPath = resolveRepoPath(requestedPath);
    await ensureFile(absPath);
    const stats = await fs.stat(absPath);

    const maxReadBytes = Math.min(stats.size, MAX_PREVIEW_BYTES);
    const handle = await fs.open(absPath, "r");
    const buffer = Buffer.alloc(maxReadBytes);
    let readResult: Awaited<ReturnType<typeof handle.read>>;
    try {
      readResult = await handle.read(buffer, 0, maxReadBytes, 0);
    } finally {
      await handle.close();
    }
    const data = buffer.subarray(0, readResult.bytesRead);

    if (isLikelyBinary(data)) {
      res.json({
        path: toRepoRelativePath(absPath),
        binary: true,
        truncated: stats.size > data.length,
        size: stats.size,
      });
      return;
    }

    res.json({
      path: toRepoRelativePath(absPath),
      binary: false,
      truncated: stats.size > data.length,
      size: stats.size,
      content: data.toString("utf8"),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to read file";
    res.status(400).json({ error: message });
  }
});

app.get("/api/file", async (req, res) => {
  try {
    const requestedPath = getSingleQueryValue(req.query.path);
    if (!requestedPath) {
      res.status(400).json({ error: "Missing ?path=..." });
      return;
    }

    const absPath = resolveRepoPath(requestedPath);
    await ensureFile(absPath);
    const stats = await fs.stat(absPath);

    const mimeType = mimeLookup(absPath) || "application/octet-stream";
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(stats.size));
    await pipeline(createReadStream(absPath), res);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to stream file";
    if (!res.headersSent) {
      res.status(400).json({ error: message });
      return;
    }
    res.destroy();
  }
});

app.post("/api/clipboard/upload", clipboardUploadMiddleware, handleClipboardUpload);
// Backward compatibility for older cached clients still posting to /api/upload.
app.post("/api/upload", clipboardUploadMiddleware, handleClipboardUpload);

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectoryPath = path.dirname(currentFilePath);
const staticDirectoryPath = path.resolve(currentDirectoryPath, "..", "static");

app.use(express.static(staticDirectoryPath));
app.get("/", (_req, res) => {
  res.sendFile(path.join(staticDirectoryPath, "index.html"));
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof multer.MulterError) {
    res.status(400).json({ error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : "Unexpected server error";
  res.status(500).json({ error: message });
});

app.listen(PORT, HOST, () => {
  console.log(`[remote-workspace] root: ${REPO_ROOT}`);
  console.log(`[remote-workspace] http://${HOST}:${PORT}`);
  console.log(
    `[remote-workspace] Tailscale serve example: tailscale serve --bg --https=443 127.0.0.1:${PORT}`,
  );
});
