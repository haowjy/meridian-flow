// ---------------------------------------------------------------------------
// Theme — initialize before Tailwind processes classes
// ---------------------------------------------------------------------------
const savedTheme = localStorage.getItem("workspace-theme") || "dark";
document.documentElement.dataset.theme = savedTheme;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".heic", ".heif", ".avif",
]);
const IMAGE_MIME_TO_EXTENSION = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
  "image/webp": ".webp", "image/svg+xml": ".svg", "image/bmp": ".bmp",
  "image/heic": ".heic", "image/heif": ".heif", "image/avif": ".avif",
};
const EXTENSION_TO_HLJS_LANG = {
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".jsx": "javascript",
  ".go": "go", ".py": "python", ".rs": "rust",
  ".sh": "bash", ".bash": "bash", ".zsh": "bash",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml",
  ".css": "css", ".html": "html", ".htm": "html",
  ".sql": "sql", ".diff": "diff", ".patch": "diff",
  ".toml": "ini", ".ini": "ini", ".cfg": "ini",
  ".xml": "xml", ".svg": "xml",
  ".rb": "ruby", ".java": "java", ".kt": "kotlin",
  ".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
  ".cs": "csharp", ".swift": "swift", ".lua": "lua",
  ".r": "r", ".R": "r", ".pl": "perl",
  ".dockerfile": "dockerfile", ".makefile": "makefile",
};
const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_MAX_RESULTS = 20;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  activeTab: "clipboard",
  // Tree: top-level entries loaded eagerly, children loaded on expand
  topLevelEntries: [],
  dirChildren: new Map(),
  dirLoading: new Set(),
  expandedPaths: new Set(),
  // Search: flat file list loaded in background via /api/tree
  flatFilePaths: [],
  searchReady: false,
  searchQuery: "",
  selectedPath: "",
  fileRequestId: 0,
  fileAbortController: null,
  clipboardRequestId: 0,
  clipboardAbortController: null,
  clipboardApiMode: "modern",
  pendingUploadFile: null,
  searchDebounceTimer: null,
  // Screenshots
  screenshotEntries: [],
  screenshotsRequestId: 0,
  screenshotsAbortController: null,
};

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const clipboardStatusEl = $("clipboard-status");
const clipboardGrid = $("clipboard-grid");
const fileTree = $("file-tree");
const viewer = $("viewer");
const viewerTitle = $("viewer-title");
const searchInput = $("search-input");
const searchResultsEl = $("search-results");
const uploadInput = $("upload-input");
const pasteClipboardBtn = $("paste-clipboard-btn");
const uploadNameInput = $("upload-name-input");
const uploadBtn = $("upload-btn");
const clipboardRefreshBtn = $("clipboard-refresh-btn");
const treeRefreshBtn = $("tree-refresh-btn");
const screenshotsGrid = $("screenshots-grid");
const screenshotsStatusEl = $("screenshots-status");
const screenshotsRefreshBtn = $("screenshots-refresh-btn");
const viewerRefreshBtn = $("viewer-refresh-btn");
const lightbox = $("lightbox");
const lightboxPanel = $("lightbox-panel");
const lightboxCloseBtn = $("lightbox-close-btn");
const lightboxImg = $("lightbox-img");
const lightboxSvgContainer = $("lightbox-svg-container");
const themeToggleBtn = $("theme-toggle-btn");
const hljsThemeLink = $("hljs-theme");

// Tab badges
const tabBadgeClipboard = $("tab-badge-clipboard");
const tabBadgeFiles = $("tab-badge-files");
const tabBadgeScreenshots = $("tab-badge-screenshots");

// ---------------------------------------------------------------------------
// Markdown + highlight.js integration
// ---------------------------------------------------------------------------
const md = window.markdownit({
  html: false,
  linkify: true,
  breaks: true,
  highlight: (str, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang }).value;
      } catch { /* fall through */ }
    }
    return "";
  },
});

window.mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: (localStorage.getItem("workspace-theme") || "dark") === "dark" ? "dark" : "default",
});

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function isMarkdownPath(p) { return /\.(md|markdown|mdx)$/i.test(p); }
function isImagePath(p) { return /\.(png|jpe?g|gif|webp|svg|bmp|heic|heif|avif)$/i.test(p); }
function isAbortError(e) { return e instanceof DOMException && e.name === "AbortError"; }
function toErrorMessage(e) { return e instanceof Error ? e.message : "Unexpected error"; }

function extensionToHljsLang(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return EXTENSION_TO_HLJS_LANG[ext] || null;
}

function getFileIconName(filename, type) {
  if (type === "directory") return "folder";
  if (isImagePath(filename)) return "image";
  if (isMarkdownPath(filename)) return "file-text";
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (EXTENSION_TO_HLJS_LANG[ext]) return "file-code";
  return "file";
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError
    ? "text-[11px] text-red-400 font-mono truncate max-w-52"
    : "text-[11px] text-ink-500 font-mono truncate max-w-52";
}

function setClipboardStatus(message, isError = false) {
  clipboardStatusEl.textContent = message;
  clipboardStatusEl.className = isError
    ? "shrink-0 px-4 py-1 text-[11px] text-red-400 font-mono min-h-[1.4em]"
    : "shrink-0 px-4 py-1 text-[11px] text-ink-500 font-mono min-h-[1.4em]";
}

function setScreenshotsStatus(message, isError = false) {
  screenshotsStatusEl.textContent = message;
  screenshotsStatusEl.className = isError
    ? "shrink-0 px-4 py-1 text-[11px] text-red-400 font-mono min-h-[1.4em]"
    : "shrink-0 px-4 py-1 text-[11px] text-ink-500 font-mono min-h-[1.4em]";
}

function refreshIcons() {
  try { lucide.createIcons(); } catch { /* icons not ready yet */ }
}

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------
function updateThemeIcon(theme) {
  const iconName = theme === "dark" ? "sun" : "moon";
  themeToggleBtn.innerHTML = `<i data-lucide="${iconName}" class="w-4 h-4"></i>`;
  refreshIcons();
}

// Set initial icon to match saved theme
updateThemeIcon(savedTheme);
// Set initial hljs theme to match
if (savedTheme === "light") {
  hljsThemeLink.href = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css";
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("workspace-theme", next);

  updateThemeIcon(next);

  // Swap highlight.js theme
  hljsThemeLink.href = next === "dark"
    ? "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css"
    : "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css";

  // Close lightbox — its cloned SVG won't update with the new theme
  closeLightbox();

  // Re-render mermaid diagrams with correct built-in theme
  reRenderMermaid(next);
}

themeToggleBtn.addEventListener("click", toggleTheme);

async function reRenderMermaid(theme) {
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: theme === "dark" ? "dark" : "default",
  });

  const diagrams = viewer.querySelectorAll("[data-diagram]");
  for (const el of diagrams) {
    const source = el.dataset.diagram;
    const id = "mermaid-" + Math.random().toString(36).slice(2, 8);
    try {
      const { svg } = await window.mermaid.render(id, source);
      el.innerHTML = svg;
    } catch { /* leave as-is on error */ }
  }

  // Re-attach click-to-zoom on the new SVGs (old ones were replaced)
  for (const node of viewer.querySelectorAll(".mermaid svg")) {
    node.addEventListener("click", () => openMermaidLightbox(node));
  }
}

function isRouteMissingResponse(response, parseError) {
  if (response.status !== 404) return false;
  const msg = toErrorMessage(parseError);
  return msg.includes("Unexpected response payload") || msg.includes("Cannot POST") || msg.includes("Cannot GET");
}

async function readJsonResponse(response) {
  const raw = await response.text();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error(`Unexpected response payload (HTTP ${response.status})`); }
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------
const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = document.querySelectorAll(".tab-panel");

function switchTab(tabName) {
  state.activeTab = tabName;
  localStorage.setItem("workspace-tab", tabName);
  tabPanels.forEach((p) => p.classList.toggle("hidden", p.id !== `panel-${tabName}`));
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === tabName));
  refreshIcons();
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// Initialize tab — restore last active or default to clipboard
switchTab(localStorage.getItem("workspace-tab") || "clipboard");

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------
function openLightbox(src) {
  lightboxSvgContainer.classList.add("hidden");
  lightboxSvgContainer.innerHTML = "";
  lightboxImg.classList.remove("hidden");
  lightboxImg.src = src;
  lightbox.classList.remove("hidden");
}

function openMermaidLightbox(svgElement) {
  // Hide the <img>, show the SVG container
  lightboxImg.classList.add("hidden");
  lightboxImg.src = "";
  lightboxSvgContainer.innerHTML = "";

  const clone = svgElement.cloneNode(true);
  // Remove Mermaid's max-width constraint, fill the container
  clone.removeAttribute("style");
  clone.style.width = "100%";
  clone.style.height = "100%";
  lightboxSvgContainer.appendChild(clone);
  lightboxSvgContainer.classList.remove("hidden");
  lightbox.classList.remove("hidden");

  // Init pan/zoom if svg-pan-zoom is available
  if (typeof svgPanZoom === "function") {
    try {
      svgPanZoom(clone, {
        zoomEnabled: true,
        panEnabled: true,
        controlIconsEnabled: true,
        fit: true,
        center: true,
        minZoom: 0.5,
        maxZoom: 10,
      });
    } catch { /* svg-pan-zoom may fail on some SVGs — leave as-is */ }
  }
}

function closeLightbox() {
  lightbox.classList.add("hidden");
  lightboxImg.classList.add("hidden");
  lightboxImg.src = "";
  lightboxSvgContainer.classList.add("hidden");
  lightboxSvgContainer.innerHTML = "";
}
// Expose globally for any inline onclick references
window.closeLightbox = closeLightbox;

// Close lightbox when clicking anything that isn't the image, SVG, or close button.
// The panel background (bg-ink-900) looks nearly identical to the backdrop (bg-ink-950/90),
// so users expect clicks anywhere outside the actual content to dismiss.
lightbox.addEventListener("click", (e) => {
  const t = e.target;
  if (lightboxCloseBtn.contains(t)) return; // handled below
  if (lightboxImg.contains(t)) return;
  if (lightboxSvgContainer.contains(t)) return;
  closeLightbox();
});
lightboxCloseBtn.addEventListener("click", closeLightbox);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !lightbox.classList.contains("hidden")) closeLightbox();
});

// ---------------------------------------------------------------------------
// Tree: load top-level eagerly, children on demand
// ---------------------------------------------------------------------------
async function loadTopLevel() {
  try {
    setStatus("Loading...");
    fileTree.innerHTML = '<div class="flex items-center justify-center py-8 text-ink-500 text-sm"><i data-lucide="loader" class="w-4 h-4 mr-2 animate-spin"></i>Loading...</div>';
    refreshIcons();

    const res = await fetch("/api/list?path=");
    const data = await readJsonResponse(res);
    if (!res.ok) throw new Error(data.error || "Unable to load files");

    state.topLevelEntries = data.entries || [];
    tabBadgeFiles.textContent = `${state.topLevelEntries.length}`;
    renderTree();
    setStatus(`${state.topLevelEntries.length} entries`);
  } catch (error) {
    if (isAbortError(error)) return;
    fileTree.innerHTML = `<p class="p-3 text-sm text-red-400">${escapeHtml(toErrorMessage(error))}</p>`;
    setStatus(toErrorMessage(error), true);
  }
}

// Background-load the full tree for search indexing only
async function loadSearchIndex() {
  try {
    const res = await fetch("/api/tree");
    const data = await readJsonResponse(res);
    if (!res.ok) return;

    state.flatFilePaths = [];
    flattenTree(data.root);
    state.searchReady = true;
    tabBadgeFiles.textContent = `${data.totalFiles}`;
  } catch {
    // Search won't work but tree browsing still does
  }
}

function flattenTree(node) {
  if (!node.children) {
    if (node.name) state.flatFilePaths.push({ name: node.name, path: node.path, type: node.type });
    return;
  }
  for (const child of node.children) {
    flattenTree(child);
  }
}

// Fetch children of a directory on demand
async function loadDirChildren(dirPath) {
  if (state.dirChildren.has(dirPath) || state.dirLoading.has(dirPath)) return;
  state.dirLoading.add(dirPath);
  renderTree();

  try {
    const res = await fetch(`/api/list?path=${encodeURIComponent(dirPath)}`);
    const data = await readJsonResponse(res);
    if (!res.ok) throw new Error(data.error || "Unable to load directory");
    state.dirChildren.set(dirPath, data.entries || []);
  } catch (error) {
    state.expandedPaths.delete(dirPath);
    setStatus(toErrorMessage(error), true);
  } finally {
    state.dirLoading.delete(dirPath);
    renderTree();
  }
}

// ---------------------------------------------------------------------------
// Tree: render
// ---------------------------------------------------------------------------
function renderTree() {
  fileTree.innerHTML = "";
  if (state.topLevelEntries.length === 0) {
    fileTree.innerHTML = '<p class="p-3 text-sm text-ink-500">No files found.</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const entry of state.topLevelEntries) {
    renderTreeNode(entry, 0, frag);
  }
  fileTree.appendChild(frag);
  refreshIcons();
}

function renderTreeNode(entry, depth, container) {
  const isDir = entry.type === "directory";
  const isExpanded = state.expandedPaths.has(entry.path);
  const isLoading = state.dirLoading.has(entry.path);
  const isActive = state.selectedPath === entry.path;
  const iconName = getFileIconName(entry.name, entry.type);

  const row = document.createElement("div");
  row.className = "tree-item";
  row.style.setProperty("--depth", depth);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `w-full flex items-center gap-1.5 px-2 py-[3px] text-sm rounded-md transition-colors group ${
    isActive ? "bg-brand/10 text-brand font-medium" : "text-ink-300 hover:bg-ink-800"
  }`;

  if (isDir) {
    if (isLoading) {
      btn.innerHTML = `<i data-lucide="loader" class="w-3.5 h-3.5 text-ink-500 shrink-0 animate-spin"></i>`;
    } else {
      btn.innerHTML = `<i data-lucide="chevron-right" class="w-3.5 h-3.5 text-ink-500 shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}"></i>`;
    }
  } else {
    btn.innerHTML = `<span class="w-3.5 shrink-0"></span>`;
  }

  btn.innerHTML += `<i data-lucide="${iconName}" class="w-3.5 h-3.5 ${
    isDir ? "text-amber-500" : isActive ? "text-brand" : "text-ink-500"
  } shrink-0"></i>`;
  btn.innerHTML += `<span class="truncate font-mono text-[13px]">${escapeHtml(entry.name)}</span>`;

  btn.onclick = () => {
    if (isDir) {
      toggleDirectory(entry.path);
    } else {
      openFile(entry.path).catch(handleActionError);
    }
  };

  row.appendChild(btn);
  container.appendChild(row);

  if (isDir && isExpanded) {
    const children = state.dirChildren.get(entry.path);
    if (children) {
      for (const child of children) {
        renderTreeNode(child, depth + 1, container);
      }
    }
  }
}

function toggleDirectory(dirPath) {
  if (state.expandedPaths.has(dirPath)) {
    state.expandedPaths.delete(dirPath);
    renderTree();
  } else {
    state.expandedPaths.add(dirPath);
    if (!state.dirChildren.has(dirPath)) {
      loadDirChildren(dirPath);
    } else {
      renderTree();
    }
  }
}

function expandParentsOf(filePath) {
  const segments = filePath.split("/");
  let running = "";
  for (let i = 0; i < segments.length - 1; i++) {
    running = running ? `${running}/${segments[i]}` : segments[i];
    state.expandedPaths.add(running);
    if (!state.dirChildren.has(running) && !state.dirLoading.has(running)) {
      loadDirChildren(running);
    }
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
function handleSearch(query) {
  state.searchQuery = query;
  if (!query.trim()) {
    searchResultsEl.classList.add("hidden");
    searchResultsEl.innerHTML = "";
    return;
  }

  if (!state.searchReady) {
    searchResultsEl.innerHTML = '<div class="p-3 text-sm text-ink-500">Search index loading...</div>';
    searchResultsEl.classList.remove("hidden");
    return;
  }

  const lowerQuery = query.toLowerCase();
  const scored = [];
  for (const entry of state.flatFilePaths) {
    const lowerPath = entry.path.toLowerCase();
    const lowerName = entry.name.toLowerCase();
    if (!lowerPath.includes(lowerQuery)) continue;

    let score = 0;
    if (lowerName === lowerQuery) score = 3;
    else if (lowerName.includes(lowerQuery)) score = 2;
    else score = 1;
    scored.push({ ...entry, score });
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const results = scored.slice(0, SEARCH_MAX_RESULTS);

  if (results.length === 0) {
    searchResultsEl.innerHTML = '<div class="p-3 text-sm text-ink-500">No matches found</div>';
    searchResultsEl.classList.remove("hidden");
    return;
  }

  searchResultsEl.innerHTML = "";
  for (const result of results) {
    const iconName = getFileIconName(result.name, result.type);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-ink-700 transition-colors border-b border-ink-700/50 last:border-0 text-ink-300";
    item.innerHTML = `<i data-lucide="${iconName}" class="w-3.5 h-3.5 text-ink-500 shrink-0"></i>
      <span class="truncate font-mono text-[13px]">${escapeHtml(result.path)}</span>`;
    item.onclick = () => {
      searchInput.value = "";
      searchResultsEl.classList.add("hidden");
      searchResultsEl.innerHTML = "";
      expandParentsOf(result.path);
      if (result.type === "directory") {
        toggleDirectory(result.path);
      } else {
        openFile(result.path).catch(handleActionError);
      }
      renderTree();
    };
    searchResultsEl.appendChild(item);
  }
  searchResultsEl.classList.remove("hidden");
  refreshIcons();
}

searchInput.addEventListener("input", () => {
  clearTimeout(state.searchDebounceTimer);
  state.searchDebounceTimer = setTimeout(() => handleSearch(searchInput.value), SEARCH_DEBOUNCE_MS);
});

document.addEventListener("click", (e) => {
  if (!searchInput.contains(e.target) && !searchResultsEl.contains(e.target)) {
    searchResultsEl.classList.add("hidden");
  }
});
searchInput.addEventListener("focus", () => {
  if (searchInput.value.trim()) handleSearch(searchInput.value);
});

// ---------------------------------------------------------------------------
// File preview
// ---------------------------------------------------------------------------
async function openFile(filePath) {
  const requestId = ++state.fileRequestId;
  if (state.fileAbortController) state.fileAbortController.abort();
  const controller = new AbortController();
  state.fileAbortController = controller;

  state.selectedPath = filePath;
  localStorage.setItem("workspace-file", filePath);
  viewerRefreshBtn.classList.remove("hidden");
  expandParentsOf(filePath);
  renderTree();

  viewerTitle.textContent = filePath;
  setStatus(`Opening ${filePath}...`);

  if (isImagePath(filePath)) {
    if (requestId !== state.fileRequestId) return;
    viewer.innerHTML = `<img alt="${escapeHtml(filePath)}" src="/api/file?path=${encodeURIComponent(filePath)}" class="max-w-full rounded-lg cursor-pointer" onclick="openLightbox(this.src)" />`;
    setStatus(`Image: ${filePath}`);
    return;
  }

  const response = await fetch(`/api/text?path=${encodeURIComponent(filePath)}`, { signal: controller.signal });
  const data = await readJsonResponse(response);
  if (requestId !== state.fileRequestId) return;

  if (!response.ok) {
    viewer.innerHTML = `<p class="text-red-400 text-sm">${escapeHtml(data.error || "Failed to open file.")}</p>`;
    setStatus("File open failed", true);
    return;
  }

  if (data.binary) {
    viewer.innerHTML = `<div class="flex flex-col items-center justify-center h-full text-ink-500">
      <i data-lucide="file-warning" class="w-8 h-8 mb-2 opacity-40"></i>
      <p class="text-sm mb-2">Binary file</p>
      <a href="/api/file?path=${encodeURIComponent(filePath)}" target="_blank" rel="noopener" class="text-brand text-sm underline">Download / open raw</a>
    </div>`;
    refreshIcons();
    setStatus("Binary file");
    return;
  }

  if (isMarkdownPath(filePath)) {
    await renderMarkdown(data.content, data.truncated, requestId);
    if (requestId !== state.fileRequestId) return;
    setStatus(data.truncated ? "Markdown (truncated)" : "Markdown preview");
    return;
  }

  const lang = extensionToHljsLang(filePath);
  let highlighted;
  if (lang && hljs.getLanguage(lang)) {
    try {
      highlighted = hljs.highlight(data.content || "", { language: lang }).value;
    } catch { /* fall through */ }
  }

  if (highlighted) {
    viewer.innerHTML = `<pre><code class="hljs language-${lang}">${highlighted}</code></pre>`;
  } else {
    viewer.innerHTML = `<pre><code>${escapeHtml(data.content || "")}</code></pre>`;
  }
  if (data.truncated) {
    viewer.insertAdjacentHTML("beforeend", '<p class="text-xs text-ink-500 mt-2">Preview truncated for large file.</p>');
  }
  setStatus(data.truncated ? "Text (truncated)" : "Text preview");
}

async function renderMarkdown(markdownContent, truncated, requestId) {
  if (requestId !== state.fileRequestId) return;

  const html = md.render(markdownContent || "");
  viewer.innerHTML = `<article class="markdown-body">${html}</article>${
    truncated ? '<p class="text-xs text-ink-500 mt-3">Preview truncated for large file.</p>' : ""
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
    // Save source BEFORE mermaid.run() replaces textContent with SVG
    const mermaidSources = new Map();
    for (const node of mermaidNodes) {
      mermaidSources.set(node, node.textContent);
    }

    try {
      await window.mermaid.run({ nodes: mermaidNodes });
    } catch (error) {
      console.error(error);
      if (requestId !== state.fileRequestId) return;
      const warning = document.createElement("p");
      warning.className = "text-xs text-red-400 mt-2";
      warning.textContent = "Mermaid render failed for one or more diagrams.";
      viewer.appendChild(warning);
    }

    // Persist source as data attribute for theme re-rendering
    for (const [node, source] of mermaidSources) {
      node.dataset.diagram = source;
    }

    // Add click-to-zoom on rendered SVGs
    for (const node of viewer.querySelectorAll(".mermaid svg")) {
      node.addEventListener("click", () => openMermaidLightbox(node));
    }
  }
}

// ---------------------------------------------------------------------------
// Clipboard images
// ---------------------------------------------------------------------------
function clipboardImageUrl(entry) {
  if (state.clipboardApiMode === "legacy") {
    return `/api/file?path=${encodeURIComponent(entry.path)}`;
  }
  return `/api/clipboard/file?name=${encodeURIComponent(entry.name)}`;
}

function renderClipboardImages(imageEntries) {
  clipboardGrid.innerHTML = "";
  if (imageEntries.length === 0) {
    clipboardGrid.innerHTML = '<p class="text-sm text-ink-500 col-span-full py-8 text-center">No images in .clipboard yet.</p>';
    return;
  }

  for (const entry of imageEntries) {
    const container = document.createElement("div");
    container.className = "relative group border border-ink-800 rounded-lg bg-ink-900 p-1.5 flex flex-col gap-1 hover:border-ink-600 transition-colors";

    const imgBtn = document.createElement("button");
    imgBtn.type = "button";
    imgBtn.className = "block w-full";
    const imageUrl = clipboardImageUrl(entry);
    imgBtn.innerHTML = `<img alt="${escapeHtml(entry.name)}" src="${imageUrl}" loading="lazy" class="w-full h-24 object-cover rounded border border-ink-800 bg-ink-950" />`;
    imgBtn.onclick = () => openLightbox(imageUrl);

    const footer = document.createElement("div");
    footer.className = "flex items-center gap-1 min-w-0";
    footer.innerHTML = `<span class="text-[11px] font-mono text-ink-500 truncate flex-1">${escapeHtml(entry.name)}</span>`;

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "shrink-0 p-0.5 text-ink-500 hover:text-brand rounded transition-colors";
    copyBtn.title = "Copy path";
    copyBtn.innerHTML = `<i data-lucide="copy" class="w-3 h-3"></i>`;
    copyBtn.onclick = async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(`.clipboard/${entry.name}`);
        copyBtn.innerHTML = `<i data-lucide="check" class="w-3 h-3 text-green-400"></i>`;
        refreshIcons();
        setTimeout(() => {
          copyBtn.innerHTML = `<i data-lucide="copy" class="w-3 h-3"></i>`;
          refreshIcons();
        }, 1500);
      } catch {
        setClipboardStatus("Copy failed — clipboard access denied.", true);
      }
    };
    footer.appendChild(copyBtn);

    container.appendChild(imgBtn);
    container.appendChild(footer);
    clipboardGrid.appendChild(container);
  }
  refreshIcons();
}

async function fetchClipboardEntriesModern(signal) {
  const response = await fetch("/api/clipboard/list", { signal });
  let data;
  try { data = await readJsonResponse(response); } catch (error) {
    if (isRouteMissingResponse(response, error)) throw new Error("Clipboard API not available");
    throw error;
  }
  if (!response.ok) throw new Error(data.error || "Unable to load .clipboard");
  return data.entries || [];
}

async function fetchClipboardEntriesLegacy(signal) {
  const response = await fetch("/api/list?path=.clipboard", { signal });
  const data = await readJsonResponse(response);
  if (!response.ok) throw new Error(data.error || "Unable to load .clipboard");
  return (data.entries || []).filter((e) => e.type === "file");
}

async function loadClipboardImages() {
  const requestId = ++state.clipboardRequestId;
  if (state.clipboardAbortController) state.clipboardAbortController.abort();
  const controller = new AbortController();
  state.clipboardAbortController = controller;

  try {
    setClipboardStatus("Loading...");
    let entries;
    let mode = "modern";
    try {
      entries = await fetchClipboardEntriesModern(controller.signal);
    } catch (error) {
      if (toErrorMessage(error) === "Clipboard API not available") {
        entries = await fetchClipboardEntriesLegacy(controller.signal);
        mode = "legacy";
      } else throw error;
    }
    if (requestId !== state.clipboardRequestId) return;
    state.clipboardApiMode = mode;
    const imageEntries = entries.filter((e) => isImagePath(e.path || e.name));
    tabBadgeClipboard.textContent = imageEntries.length ? `${imageEntries.length}` : "";
    renderClipboardImages(imageEntries);
    setClipboardStatus(mode === "legacy"
      ? `${imageEntries.length} image(s) — legacy API`
      : `${imageEntries.length} image(s)`);
  } catch (error) {
    if (isAbortError(error)) return;
    setClipboardStatus(toErrorMessage(error), true);
  }
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------
function screenshotImageUrl(entry) {
  return `/api/screenshots/file?name=${encodeURIComponent(entry.name)}`;
}

function renderScreenshots(entries) {
  screenshotsGrid.innerHTML = "";
  if (entries.length === 0) {
    screenshotsGrid.innerHTML = '<p class="text-sm text-ink-500 col-span-full py-8 text-center">No screenshots in .playwright-mcp/ yet.</p>';
    return;
  }

  for (const entry of entries) {
    const container = document.createElement("div");
    container.className = "relative group border border-ink-800 rounded-lg bg-ink-900 p-1.5 flex flex-col gap-1 hover:border-ink-600 transition-colors";

    const imgBtn = document.createElement("button");
    imgBtn.type = "button";
    imgBtn.className = "block w-full";
    const imageUrl = screenshotImageUrl(entry);
    imgBtn.innerHTML = `<img alt="${escapeHtml(entry.name)}" src="${imageUrl}" loading="lazy" class="w-full h-32 object-cover rounded border border-ink-800 bg-ink-950" />`;
    imgBtn.onclick = () => openLightbox(imageUrl);

    const footer = document.createElement("div");
    footer.className = "flex items-center gap-1 min-w-0";

    // Parse timestamp from filename (page-YYYY-MM-DDTHH-MM-SS-mmmZ.png)
    const tsMatch = entry.name.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    const timeLabel = tsMatch ? `${tsMatch[1]} ${tsMatch[2]}:${tsMatch[3]}:${tsMatch[4]}` : entry.name;

    footer.innerHTML = `<span class="text-[11px] font-mono text-ink-500 truncate flex-1">${escapeHtml(timeLabel)}</span>`;

    if (entry.size) {
      footer.innerHTML += `<span class="text-[10px] font-mono text-ink-600 shrink-0">${formatBytes(entry.size)}</span>`;
    }

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "shrink-0 p-0.5 text-ink-500 hover:text-brand rounded transition-colors ml-1";
    copyBtn.title = "Copy path";
    copyBtn.innerHTML = `<i data-lucide="copy" class="w-3 h-3"></i>`;
    copyBtn.onclick = async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(`.playwright-mcp/${entry.name}`);
        copyBtn.innerHTML = `<i data-lucide="check" class="w-3 h-3 text-green-400"></i>`;
        refreshIcons();
        setTimeout(() => {
          copyBtn.innerHTML = `<i data-lucide="copy" class="w-3 h-3"></i>`;
          refreshIcons();
        }, 1500);
      } catch {
        setScreenshotsStatus("Copy failed — clipboard access denied.", true);
      }
    };
    footer.appendChild(copyBtn);

    container.appendChild(imgBtn);
    container.appendChild(footer);
    screenshotsGrid.appendChild(container);
  }
  refreshIcons();
}

async function loadScreenshots() {
  const requestId = ++state.screenshotsRequestId;
  if (state.screenshotsAbortController) state.screenshotsAbortController.abort();
  const controller = new AbortController();
  state.screenshotsAbortController = controller;

  try {
    setScreenshotsStatus("Loading...");
    const res = await fetch("/api/screenshots/list", { signal: controller.signal });
    let data;
    try { data = await readJsonResponse(res); } catch (error) {
      if (isRouteMissingResponse(res, error)) {
        // Server doesn't have screenshots endpoint yet — show empty
        if (requestId !== state.screenshotsRequestId) return;
        tabBadgeScreenshots.textContent = "";
        renderScreenshots([]);
        setScreenshotsStatus("Screenshots API not available");
        return;
      }
      throw error;
    }
    if (!res.ok) throw new Error(data.error || "Unable to load screenshots");
    if (requestId !== state.screenshotsRequestId) return;

    const entries = data.entries || [];
    state.screenshotEntries = entries;
    tabBadgeScreenshots.textContent = entries.length ? `${entries.length}` : "";
    renderScreenshots(entries);
    setScreenshotsStatus(`${entries.length} screenshot(s)`);
  } catch (error) {
    if (isAbortError(error)) return;
    setScreenshotsStatus(toErrorMessage(error), true);
  }
}

// ---------------------------------------------------------------------------
// Upload logic
// ---------------------------------------------------------------------------
function normalizeSuggestedFilename(originalName) {
  const trimmed = (originalName || "").trim();
  const hasDot = trimmed.lastIndexOf(".") > 0;
  const extension = hasDot ? trimmed.slice(trimmed.lastIndexOf(".")).toLowerCase() : "";
  const safeExtension = ALLOWED_UPLOAD_EXTENSIONS.has(extension) ? extension : ".png";
  const rawStem = hasDot ? trimmed.slice(0, trimmed.lastIndexOf(".")) : trimmed;
  const safeStem = rawStem.replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return `${safeStem || "image"}${safeExtension}`;
}

function extensionFromMimeType(mimeType) { return IMAGE_MIME_TO_EXTENSION[mimeType] || ".png"; }

function ensureClipboardFileHasName(file) {
  if (file.name && file.name.trim()) return file;
  const ext = extensionFromMimeType(file.type);
  return new File([file], `clipboard-${Date.now()}${ext}`, { type: file.type || "image/png" });
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
  if (!fileName) return "Filename is required.";
  if (/\s/.test(fileName)) return "No spaces allowed.";
  if (fileName === "." || fileName === ".." || fileName.startsWith(".")) return "Invalid filename.";
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) return "Use letters, numbers, dot, underscore, dash only.";
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) return "Unsupported image extension.";
  return null;
}

function handleUploadSelection() {
  const selectedFile = uploadInput.files?.[0];
  if (!selectedFile) { state.pendingUploadFile = null; return; }
  setPendingUploadFile(selectedFile, "file picker");
}

async function pasteImageFromClipboard() {
  if (!navigator.clipboard || typeof navigator.clipboard.read !== "function") {
    throw new Error("Clipboard paste not supported in this browser.");
  }
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const imageType = item.types.find((t) => t.startsWith("image/"));
    if (!imageType) continue;
    const blob = await item.getType(imageType);
    const ext = extensionFromMimeType(imageType);
    const file = new File([blob], `clipboard-${Date.now()}${ext}`, { type: imageType });
    setPendingUploadFile(file, "clipboard");
    return;
  }
  throw new Error("Clipboard does not contain an image.");
}

async function uploadPendingImage() {
  if (!state.pendingUploadFile) throw new Error("Choose an image first.");
  const requestedName = uploadNameInput.value.trim();
  const filenameError = validateUploadFilename(requestedName);
  if (filenameError) throw new Error(filenameError);

  setStatus(`Uploading ${requestedName}...`);
  const createBody = () => {
    const fd = new FormData();
    fd.append("file", state.pendingUploadFile);
    return fd;
  };

  let data;
  try {
    const primaryRes = await fetch(`/api/clipboard/upload?name=${encodeURIComponent(requestedName)}`, { method: "POST", body: createBody() });
    try { data = await readJsonResponse(primaryRes); } catch (error) {
      if (isRouteMissingResponse(primaryRes, error)) throw new Error("Clipboard API not available");
      throw error;
    }
    if (!primaryRes.ok) throw new Error(data.error || "Upload failed");
  } catch (error) {
    if (toErrorMessage(error) !== "Clipboard API not available") throw error;
    const legacyRes = await fetch(`/api/upload?name=${encodeURIComponent(requestedName)}`, { method: "POST", body: createBody() });
    data = await readJsonResponse(legacyRes);
    if (!legacyRes.ok) throw new Error(data.error || "Upload failed");
    state.clipboardApiMode = "legacy";
  }

  setClipboardStatus(`Uploaded ${requestedName}.`);
  state.pendingUploadFile = null;
  uploadInput.value = "";
  uploadNameInput.value = "";
  await loadClipboardImages();
}

// ---------------------------------------------------------------------------
// Error handlers
// ---------------------------------------------------------------------------
function handleActionError(error) {
  if (isAbortError(error)) return;
  setStatus(toErrorMessage(error), true);
}

function handleUploadError(error) {
  if (isAbortError(error)) return;
  const msg = toErrorMessage(error);
  setClipboardStatus(msg, true);
  setStatus(msg, true);
}

// ---------------------------------------------------------------------------
// Event bindings
// ---------------------------------------------------------------------------
uploadInput.addEventListener("change", handleUploadSelection);
pasteClipboardBtn.onclick = () => pasteImageFromClipboard().catch(handleUploadError);
uploadBtn.onclick = () => uploadPendingImage().catch(handleUploadError);
clipboardRefreshBtn.onclick = () => loadClipboardImages().catch(handleActionError);
treeRefreshBtn.onclick = () => {
  state.dirChildren.clear();
  state.expandedPaths.clear();
  loadTopLevel().catch(handleActionError);
  loadSearchIndex();
};
screenshotsRefreshBtn.onclick = () => loadScreenshots().catch(handleActionError);
viewerRefreshBtn.onclick = () => {
  if (state.selectedPath) openFile(state.selectedPath).catch(handleActionError);
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
Promise.all([loadClipboardImages(), loadTopLevel(), loadScreenshots()]).then(() => {
  // Restore last opened file after tree is loaded
  const lastFile = localStorage.getItem("workspace-file");
  if (lastFile) openFile(lastFile).catch(handleActionError);
}).catch(handleActionError);
// Load search index in background — not blocking initial render
loadSearchIndex();
