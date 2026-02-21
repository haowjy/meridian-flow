const state = {
  currentPath: "",
  selectedPath: "",
  directoryRequestId: 0,
  fileRequestId: 0,
  directoryAbortController: null,
  fileAbortController: null,
};

const fileList = document.getElementById("file-list");
const viewer = document.getElementById("viewer");
const viewerTitle = document.getElementById("viewer-title");
const crumbs = document.getElementById("crumbs");
const statusEl = document.getElementById("status");
const uploadInput = document.getElementById("upload-input");
const mkdirInput = document.getElementById("mkdir-input");

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
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(filePath);
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
    const skipDetails = [];
    if (skippedSymlinks > 0) skipDetails.push(`${skippedSymlinks} symlink(s)`);
    if (skippedHidden > 0) skipDetails.push(`${skippedHidden} hidden item(s)`);
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

async function uploadFiles(files) {
  if (!files || files.length === 0) return;
  setStatus(`Uploading ${files.length} image(s) to .clipboard...`);
  const body = new FormData();
  for (const file of files) {
    body.append("files", file);
  }
  const response = await fetch("/api/upload", {
    method: "POST",
    body,
  });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(data.error || "Upload failed");
  }
  setStatus(`Uploaded ${data.uploaded.length} image(s) to ${data.directory || ".clipboard"}.`);
  await loadDirectory(state.currentPath);
}

async function createFolder() {
  const folderName = mkdirInput.value.trim();
  if (!folderName) {
    return;
  }
  const pathValue = joinPath(state.currentPath, folderName);
  setStatus(`Creating folder ${pathValue}...`);
  const response = await fetch("/api/mkdir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: pathValue }),
  });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(data.error || "Create folder failed");
  }
  mkdirInput.value = "";
  setStatus(`Created folder ${data.path}.`);
  await loadDirectory(state.currentPath);
}

document.getElementById("refresh-btn").onclick = () =>
  loadDirectory(state.currentPath).catch(handleActionError);

document.getElementById("mkdir-btn").onclick = () => {
  createFolder().catch(handleActionError);
};

uploadInput.addEventListener("change", () => {
  uploadFiles(uploadInput.files)
    .catch(handleActionError)
    .finally(() => {
      uploadInput.value = "";
    });
});

loadDirectory("").catch(handleActionError);
