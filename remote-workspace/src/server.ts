import express from "express";
import multer from "multer";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
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
const CLIPBOARD_DIRECTORY_NAME = ".clipboard";
const CLIPBOARD_DIRECTORY_PATH = path.resolve(REPO_ROOT, CLIPBOARD_DIRECTORY_NAME);
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

function isClipboardRepoRelativePath(repoRelativePath: string): boolean {
  return (
    repoRelativePath === CLIPBOARD_DIRECTORY_NAME ||
    repoRelativePath.startsWith(`${CLIPBOARD_DIRECTORY_NAME}/`)
  );
}

function isBlockedHiddenRepoRelativePath(repoRelativePath: string): boolean {
  if (!isHiddenRepoRelativePath(repoRelativePath)) {
    return false;
  }
  return !isClipboardRepoRelativePath(repoRelativePath);
}

function assertNotHiddenPath(absPath: string): void {
  if (isBlockedHiddenRepoRelativePath(toRepoRelativePath(absPath))) {
    throw new Error("Hidden paths are not accessible");
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

function findAvailableFilename(directoryPath: string, baseName: string): string {
  const extension = path.extname(baseName);
  const stem = path.basename(baseName, extension);
  let candidate = baseName;
  let index = 1;
  while (existsSync(path.join(directoryPath, candidate))) {
    candidate = `${stem} (${index})${extension}`;
    index += 1;
  }
  return candidate;
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
  options?: { allowHidden?: boolean },
): Promise<void> {
  const stats = await fs.stat(absPath);
  if (!stats.isDirectory()) {
    throw new Error("Target path is not a directory");
  }
  const realPath = await fs.realpath(absPath);
  if (!isWithinRepo(realPath)) {
    throw new Error("Resolved path escapes repository root");
  }
  if (!options?.allowHidden) {
    assertNotHiddenPath(realPath);
  }
}

async function ensureFile(absPath: string): Promise<void> {
  const stats = await fs.stat(absPath);
  if (!stats.isFile()) {
    throw new Error("Target path is not a file");
  }
  const realPath = await fs.realpath(absPath);
  if (!isWithinRepo(realPath)) {
    throw new Error("Resolved path escapes repository root");
  }
  assertNotHiddenPath(realPath);
}

async function ensureNearestExistingParentWithinRepo(absPath: string): Promise<void> {
  let currentPath = absPath;
  while (!existsSync(currentPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }

  const realPath = await fs.realpath(currentPath);
  if (!isWithinRepo(realPath)) {
    throw new Error("Parent path escapes repository root");
  }
  assertNotHiddenPath(realPath);
}

const storage = multer.diskStorage({
  destination: async (req, _file, callback) => {
    try {
      await fs.mkdir(CLIPBOARD_DIRECTORY_PATH, { recursive: true });
      await ensureDirectory(CLIPBOARD_DIRECTORY_PATH, { allowHidden: true });
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

    const baseName = sanitizeUploadFilename(file.originalname);
    const uniqueName = findAvailableFilename(uploadDirectoryPath, baseName);
    callback(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: {
    files: 20,
    fileSize: MAX_UPLOAD_BYTES,
  },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const isImageMime = file.mimetype.startsWith("image/");
    const isAllowedExtension = ALLOWED_IMAGE_EXTENSIONS.has(extension);
    if (!isImageMime || !isAllowedExtension) {
      callback(new Error("Only image uploads are allowed"));
      return;
    }
    callback(null, true);
  },
});

app.get("/api/list", async (req, res) => {
  try {
    const requestedPath = getSingleQueryValue(req.query.path);
    const directoryPath = resolveRepoPath(requestedPath);
    assertNotHiddenPath(directoryPath);
    await ensureDirectory(directoryPath);

    const dirEntries = await fs.readdir(directoryPath, { withFileTypes: true });
    const entries: Entry[] = [];
    let skippedSymlinks = 0;
    let skippedHidden = 0;

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

      let childStats;
      try {
        childStats = await fs.stat(childPath);
      } catch {
        // The file may disappear between readdir and stat (race with external writers).
        continue;
      }
      entries.push({
        name: dirEntry.name,
        path: toRepoRelativePath(childPath),
        type: dirEntry.isDirectory() ? "directory" : "file",
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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list";
    res.status(400).json({ error: message });
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
    assertNotHiddenPath(absPath);
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
    assertNotHiddenPath(absPath);
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

app.post("/api/upload", upload.array("files", 20), (req, res) => {
  const files = req.files as Express.Multer.File[] | undefined;
  const uploaded = (files ?? []).map((file) => ({
    name: file.filename,
    path: toRepoRelativePath(file.path),
    size: file.size,
  }));

  const uploadDirectoryPath = (
    req as express.Request & { uploadDirectoryPath?: string }
  ).uploadDirectoryPath;

  res.json({
    directory: uploadDirectoryPath ? toRepoRelativePath(uploadDirectoryPath) : "",
    uploaded,
  });
});

app.post("/api/mkdir", async (req, res) => {
  try {
    const relativePath =
      typeof req.body?.path === "string" ? req.body.path : undefined;
    if (!relativePath) {
      res.status(400).json({ error: "Missing JSON body: { path: string }" });
      return;
    }

    const absPath = resolveRepoPath(relativePath);
    assertNotHiddenPath(absPath);
    await ensureNearestExistingParentWithinRepo(absPath);
    await fs.mkdir(absPath, { recursive: true });
    res.json({ path: toRepoRelativePath(absPath) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to create directory";
    res.status(400).json({ error: message });
  }
});

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
