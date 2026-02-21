const ALLOWED_UPLOAD_EXTENSIONS = new Set([
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
const IMAGE_MIME_TO_EXTENSION = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/avif": ".avif",
};

const state = {
  currentPath: "",
  selectedPath: "",
  directoryRequestId: 0,
  fileRequestId: 0,
  clipboardRequestId: 0,
  directoryAbortController: null,
  fileAbortController: null,
  clipboardAbortController: null,
  pendingUploadFile: null,
  clipboardApiMode: "modern",
};

const fileList = document.getElementById("file-list");
const viewer = document.getElementById("viewer");
const viewerTitle = document.getElementById("viewer-title");
const crumbs = document.getElementById("crumbs");
const statusEl = document.getElementById("status");
const clipboardStatusEl = document.getElementById("clipboard-status");
const clipboardGrid = document.getElementById("clipboard-grid");
const uploadInput = document.getElementById("upload-input");
const pasteClipboardButton = document.getElementById("paste-clipboard-btn");
const uploadNameInput = document.getElementById("upload-name-input");
const uploadButton = document.getElementById("upload-btn");
const clipboardRefreshButton = document.getElementById("clipboard-refresh-btn");

const markdown = window.markdownit({
  html: false,
  linkify: true,
  breaks: true,
});

window.mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "neutral",
});

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "muted";
}

function setClipboardStatus(message, isError = false) {
  clipboardStatusEl.textContent = message;
  clipboardStatusEl.className = isError ? "error" : "muted";
}

function isRouteMissingResponse(response, parseError) {
  if (response.status !== 404) {
    return false;
  }
  const message = toErrorMessage(parseError);
  return (
    message.includes("Unexpected response payload") ||
    message.includes("Cannot POST") ||
    message.includes("Cannot GET")
  );
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function joinPath(base, child) {
  if (!base) return child;
  return `${base}/${child}`;
}

function isMarkdownPath(filePath) {
  return /\.(md|markdown|mdx)$/i.test(filePath);
}

function isImagePath(filePath) {
  return /\.(png|jpe?g|gif|webp|svg|bmp|heic|heif|avif)$/i.test(filePath);
}

function isAbortError(error) {
  return error instanceof DOMException && error.name === "AbortError";
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : "Unexpected error";
}

function handleActionError(error) {
  if (isAbortError(error)) {
    return;
  }
  setStatus(toErrorMessage(error), true);
}

function handleUploadError(error) {
  if (isAbortError(error)) {
    return;
  }
  const message = toErrorMessage(error);
  setClipboardStatus(message, true);
  setStatus(message, true);
}

function isBlockedPathErrorMessage(message) {
  return (
    message.includes("Gitignored paths are not accessible") ||
    message.includes("Hidden paths are not accessible")
  );
}

async function refreshDirectoryWithFallback(targetPath) {
  try {
    await loadDirectory(targetPath);
  } catch (error) {
    const message = toErrorMessage(error);
    if (targetPath && isBlockedPathErrorMessage(message)) {
      state.currentPath = "";
      await loadDirectory("");
      setStatus("Current path is blocked by visibility rules; returned to repo root.");
      return;
    }
    throw error;
  }
}

function normalizeSuggestedFilename(originalName) {
  const trimmed = (originalName || "").trim();
  const hasDot = trimmed.lastIndexOf(".") > 0;
  const extension = hasDot ? trimmed.slice(trimmed.lastIndexOf(".")).toLowerCase() : "";
  const safeExtension = ALLOWED_UPLOAD_EXTENSIONS.has(extension) ? extension : ".png";
  const rawStem = hasDot ? trimmed.slice(0, trimmed.lastIndexOf(".")) : trimmed;
  const safeStem = rawStem
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${safeStem || "image"}${safeExtension}`;
}

function extensionFromMimeType(mimeType) {
  return IMAGE_MIME_TO_EXTENSION[mimeType] || ".png";
}

function ensureClipboardFileHasName(file) {
  if (file.name && file.name.trim()) {
    return file;
  }
  const extension = extensionFromMimeType(file.type);
  const fileName = `clipboard-${Date.now()}${extension}`;
  return new File([file], fileName, { type: file.type || "image/png" });
}

function setPendingUploadFile(file, sourceLabel) {
  const namedFile = ensureClipboardFileHasName(file);
  state.pendingUploadFile = namedFile;
  if (!uploadNameInput.value.trim()) {
    uploadNameInput.value = normalizeSuggestedFilename(namedFile.name);
  }
  setClipboardStatus(`Selected ${namedFile.name} from ${sourceLabel}. Set filename, then tap Upload.`);
}

function validateUploadFilename(fileName) {
  if (!fileName) {
    return "Filename is required.";
  }
  if (/\s/.test(fileName)) {
    return "Filename cannot contain spaces.";
  }
  if (fileName === "." || fileName === ".." || fileName.startsWith(".")) {
    return "Filename is invalid.";
  }
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
    return "Use letters, numbers, dot, underscore, and dash only.";
  }
  const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(extension)) {
    return "Filename must include a supported image extension.";
  }
  return null;
}

async function readJsonResponse(response) {
  const rawBody = await response.text();
  if (!rawBody) {
    return {};
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error(`Unexpected response payload (HTTP ${response.status})`);
  }
}

async function loadDirectory(nextPath = "") {
  const requestId = ++state.directoryRequestId;
  if (state.directoryAbortController) {
    state.directoryAbortController.abort();
  }
  const controller = new AbortController();
  state.directoryAbortController = controller;

  try {
    setStatus("Loading files...");
    const url = `/api/list?path=${encodeURIComponent(nextPath)}`;
    const response = await fetch(url, { signal: controller.signal });
    const data = await readJsonResponse(response);
    if (requestId !== state.directoryRequestId) {
      return;
    }
    if (!response.ok) {
      throw new Error(data.error || "Unable to load directory");
    }

    state.currentPath = data.currentPath || "";
    renderCrumbs(state.currentPath);
    renderFileList(data.entries, data.parentPath);
    const skippedSymlinks = Number(data.skippedSymlinks || 0);
    const skippedHidden = Number(data.skippedHidden || 0);
    const skippedIgnored = Number(data.skippedIgnored || 0);
    const skipDetails = [];
    if (skippedSymlinks > 0) skipDetails.push(`${skippedSymlinks} symlink(s)`);
    if (skippedHidden > 0) skipDetails.push(`${skippedHidden} hidden item(s)`);
    if (skippedIgnored > 0) skipDetails.push(`${skippedIgnored} gitignored item(s)`);
    if (skipDetails.length > 0) {
      setStatus(`Loaded ${data.entries.length} entries. Skipped ${skipDetails.join(", ")}.`);
      return;
    }
    setStatus(`Loaded ${data.entries.length} entries.`);
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    throw error;
  }
}

function renderCrumbs(currentPath) {
  crumbs.innerHTML = "";
  const rootButton = document.createElement("button");
  rootButton.type = "button";
  rootButton.textContent = "repo";
  rootButton.onclick = () => loadDirectory("").catch(handleActionError);
  crumbs.appendChild(rootButton);

  const segments = currentPath ? currentPath.split("/") : [];
  let running = "";
  for (const segment of segments) {
    running = joinPath(running, segment);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = segment;
    const next = running;
    button.onclick = () => loadDirectory(next).catch(handleActionError);
    crumbs.appendChild(button);
  }
}

function renderFileList(entries, parentPath) {
  fileList.innerHTML = "";

  if (parentPath !== null) {
    const parentRow = document.createElement("li");
    parentRow.innerHTML =
      '<button class="item" type="button"><span class="name">..</span><span class="meta">parent</span></button>';
    parentRow.querySelector("button").onclick = () =>
      loadDirectory(parentPath || "").catch(handleActionError);
    fileList.appendChild(parentRow);
  }

  for (const entry of entries) {
    const row = document.createElement("li");
    const meta = entry.type === "directory" ? "folder" : formatBytes(entry.size);
    row.innerHTML = `<button class="item" type="button"><span class="name">${escapeHtml(
      entry.type === "directory" ? `[DIR] ${entry.name}` : `[FILE] ${entry.name}`,
    )}</span><span class="meta">${escapeHtml(meta)}</span></button>`;
    row.querySelector("button").onclick = () => {
      if (entry.type === "directory") {
        loadDirectory(entry.path).catch(handleActionError);
        return;
      }
      openFile(entry.path).catch(handleActionError);
    };
    fileList.appendChild(row);
  }
}

function clipboardImageUrl(entry) {
  if (state.clipboardApiMode === "legacy") {
    return `/api/file?path=${encodeURIComponent(entry.path)}`;
  }
  return `/api/clipboard/file?name=${encodeURIComponent(entry.name)}`;
}

function renderClipboardImages(imageEntries) {
  clipboardGrid.innerHTML = "";
  if (imageEntries.length === 0) {
    clipboardGrid.innerHTML = '<p class="placeholder">No images in .clipboard yet.</p>';
    return;
  }

  for (const entry of imageEntries) {
    const container = document.createElement("div");
    container.className = "clipboard-item";
    const button = document.createElement("button");
    button.type = "button";
    const imageUrl = clipboardImageUrl(entry);
    button.innerHTML = `<img alt="${escapeHtml(entry.name)}" src="${imageUrl}" />`;
    button.onclick = () => openClipboardImage(entry);

    const fileName = document.createElement("div");
    fileName.className = "filename";
    fileName.textContent = entry.name;

    container.appendChild(button);
    container.appendChild(fileName);
    clipboardGrid.appendChild(container);
  }
}

function openClipboardImage(entry) {
  const imageUrl = clipboardImageUrl(entry);
  viewerTitle.textContent = `${".clipboard"}/${entry.name}`;
  viewer.innerHTML = `<img alt="${escapeHtml(entry.name)}" src="${imageUrl}" style="max-width:100%;border-radius:10px;" />`;
  setStatus(`Showing .clipboard image: ${entry.name}`);
}

async function fetchClipboardEntriesModern(signal) {
  const response = await fetch("/api/clipboard/list", { signal });
  let data;
  try {
    data = await readJsonResponse(response);
  } catch (error) {
    if (isRouteMissingResponse(response, error)) {
      throw new Error("Clipboard API not available");
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(data.error || "Unable to load .clipboard");
  }
  return data.entries || [];
}

async function fetchClipboardEntriesLegacy(signal) {
  const response = await fetch("/api/list?path=.clipboard", { signal });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(data.error || "Unable to load .clipboard");
  }
  return (data.entries || []).filter((entry) => entry.type === "file");
}

async function loadClipboardImages() {
  const requestId = ++state.clipboardRequestId;
  if (state.clipboardAbortController) {
    state.clipboardAbortController.abort();
  }
  const controller = new AbortController();
  state.clipboardAbortController = controller;

  try {
    setClipboardStatus("Loading .clipboard images...");
    let entries;
    let mode = "modern";
    try {
      entries = await fetchClipboardEntriesModern(controller.signal);
    } catch (error) {
      if (toErrorMessage(error) === "Clipboard API not available") {
        entries = await fetchClipboardEntriesLegacy(controller.signal);
        mode = "legacy";
      } else {
        throw error;
      }
    }
    if (requestId !== state.clipboardRequestId) {
      return;
    }
    state.clipboardApiMode = mode;
    const imageEntries = entries.filter((entry) =>
      isImagePath(entry.path || entry.name),
    );
    renderClipboardImages(imageEntries);
    if (mode === "legacy") {
      setClipboardStatus(`.clipboard: ${imageEntries.length} image(s). Using legacy API mode.`);
    } else {
      setClipboardStatus(`.clipboard: ${imageEntries.length} image(s).`);
    }
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    setClipboardStatus(toErrorMessage(error), true);
  }
}

async function openFile(filePath) {
  const requestId = ++state.fileRequestId;
  if (state.fileAbortController) {
    state.fileAbortController.abort();
  }
  const controller = new AbortController();
  state.fileAbortController = controller;

  state.selectedPath = filePath;
  viewerTitle.textContent = filePath;
  setStatus(`Opening ${filePath}...`);

  if (isImagePath(filePath)) {
    if (requestId !== state.fileRequestId) {
      return;
    }
    viewer.innerHTML = `<img alt="${escapeHtml(filePath)}" src="/api/file?path=${encodeURIComponent(filePath)}" style="max-width:100%;border-radius:10px;" />`;
    setStatus(`Showing image: ${filePath}`);
    return;
  }

  const response = await fetch(`/api/text?path=${encodeURIComponent(filePath)}`, {
    signal: controller.signal,
  });
  const data = await readJsonResponse(response);
  if (requestId !== state.fileRequestId) {
    return;
  }
  if (!response.ok) {
    viewer.innerHTML = `<p class="error">${escapeHtml(data.error || "Failed to open file.")}</p>`;
    setStatus("File open failed", true);
    return;
  }

  if (data.binary) {
    viewer.innerHTML = `<p>This appears to be a binary file.</p><p><a href="/api/file?path=${encodeURIComponent(filePath)}" target="_blank" rel="noopener">Download / open raw file</a></p>`;
    setStatus("Binary file preview is limited.");
    return;
  }

  if (isMarkdownPath(filePath)) {
    await renderMarkdown(data.content, data.truncated, requestId);
    if (requestId !== state.fileRequestId) {
      return;
    }
    setStatus(data.truncated ? "Rendered markdown preview (truncated)." : "Rendered markdown preview.");
    return;
  }

  viewer.innerHTML = `<pre>${escapeHtml(data.content || "")}</pre>`;
  setStatus(data.truncated ? "Text preview is truncated." : "Text preview loaded.");
}

async function renderMarkdown(markdownContent, truncated, requestId) {
  if (requestId !== state.fileRequestId) {
    return;
  }

  const html = markdown.render(markdownContent || "");
  viewer.innerHTML = `<article class="markdown-body">${html}</article>${
    truncated ? '<p class="muted">Preview truncated for large file.</p>' : ""
  }`;

  const mermaidCodeBlocks = viewer.querySelectorAll("pre > code.language-mermaid");
  for (const codeBlock of mermaidCodeBlocks) {
    const pre = codeBlock.closest("pre");
    if (!pre) continue;
    const chart = document.createElement("div");
    chart.className = "mermaid";
    chart.textContent = codeBlock.textContent || "";
    pre.replaceWith(chart);
  }

  const mermaidNodes = viewer.querySelectorAll(".mermaid");
  if (mermaidNodes.length > 0) {
    try {
      await window.mermaid.run({ nodes: mermaidNodes });
    } catch (error) {
      console.error(error);
      if (requestId !== state.fileRequestId) {
        return;
      }
      const warning = document.createElement("p");
      warning.className = "error";
      warning.textContent = "Mermaid render failed for one or more diagrams.";
      viewer.appendChild(warning);
    }
  }
}

function handleUploadSelection() {
  const selectedFile = uploadInput.files?.[0];
  if (!selectedFile) {
    state.pendingUploadFile = null;
    return;
  }
  setPendingUploadFile(selectedFile, "file picker");
}

async function pasteImageFromClipboard() {
  if (!navigator.clipboard || typeof navigator.clipboard.read !== "function") {
    throw new Error("Clipboard image paste button is not supported in this browser.");
  }

  const clipboardItems = await navigator.clipboard.read();
  for (const clipboardItem of clipboardItems) {
    const imageType = clipboardItem.types.find((type) => type.startsWith("image/"));
    if (!imageType) {
      continue;
    }
    const blob = await clipboardItem.getType(imageType);
    const extension = extensionFromMimeType(imageType);
    const file = new File([blob], `clipboard-${Date.now()}${extension}`, { type: imageType });
    setPendingUploadFile(file, "clipboard");
    return;
  }

  throw new Error("Clipboard does not contain an image.");
}

async function uploadPendingImage() {
  if (!state.pendingUploadFile) {
    throw new Error("Choose one image before uploading.");
  }

  const requestedName = uploadNameInput.value.trim();
  const filenameError = validateUploadFilename(requestedName);
  if (filenameError) {
    throw new Error(filenameError);
  }

  setStatus(`Uploading ${requestedName} to .clipboard...`);
  const createBody = () => {
    const formData = new FormData();
    formData.append("file", state.pendingUploadFile);
    return formData;
  };

  let data;
  try {
    const primaryResponse = await fetch(
      `/api/clipboard/upload?name=${encodeURIComponent(requestedName)}`,
      {
        method: "POST",
        body: createBody(),
      },
    );
    try {
      data = await readJsonResponse(primaryResponse);
    } catch (error) {
      if (isRouteMissingResponse(primaryResponse, error)) {
        throw new Error("Clipboard API not available");
      }
      throw error;
    }
    if (!primaryResponse.ok) {
      throw new Error(data.error || "Upload failed");
    }
  } catch (error) {
    if (toErrorMessage(error) !== "Clipboard API not available") {
      throw error;
    }

    const legacyResponse = await fetch(`/api/upload?name=${encodeURIComponent(requestedName)}`, {
      method: "POST",
      body: createBody(),
    });
    data = await readJsonResponse(legacyResponse);
    if (!legacyResponse.ok) {
      throw new Error(data.error || "Upload failed");
    }
    state.clipboardApiMode = "legacy";
  }

  setClipboardStatus(`Uploaded ${requestedName} to ${data.directory || ".clipboard"}.`);
  state.pendingUploadFile = null;
  uploadInput.value = "";
  uploadNameInput.value = "";
  await loadClipboardImages();
  await refreshDirectoryWithFallback(state.currentPath);
}

document.getElementById("refresh-btn").onclick = () =>
  refreshDirectoryWithFallback(state.currentPath).catch(handleActionError);

uploadInput.addEventListener("change", handleUploadSelection);
pasteClipboardButton.onclick = () => pasteImageFromClipboard().catch(handleUploadError);
uploadButton.onclick = () => uploadPendingImage().catch(handleUploadError);
clipboardRefreshButton.onclick = () => loadClipboardImages().catch(handleActionError);

Promise.all([loadDirectory(""), loadClipboardImages()]).catch(handleActionError);
