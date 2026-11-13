/* What both viewers share: DOM helper, theme, page fetching, and the top bar. */
import { levelLinks, MAP_DIR, parsePage } from "./pages.js";

/** Where the repo root is, from the map's directory (`.context/system-architecture/`). */
export const REPO_ROOT = "../../";

/** el("a", { href, class }, child, ...): children are nodes or strings; false/null are skipped. */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

/** A repo file's text, served by `pnpm dev` at its repo path. */
export async function fetchRepoFile(path) {
  const root = new URL(REPO_ROOT, location.href);
  const url = new URL(REPO_ROOT + path, location.href);
  // `path` can come from the address bar (?doc=). Check the URL the browser will request, not
  // the string: URL parsing turns %2e%2e into .. and moves a ? tail into the query.
  const requested = url.pathname.startsWith(root.pathname)
    ? decodeURIComponent(url.pathname.slice(root.pathname.length))
    : null;
  if (url.origin !== root.origin || url.search || url.hash || requested !== path) {
    throw new Error(`${path}: not a file in this repository`);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${response.statusText}`.trim());
  return response.text();
}

export const fetchPage = async (path) => parsePage(await fetchRepoFile(path));

/** The map's main level pages, from the links in README.md: [{ id, title, path }]. */
export async function loadLevels() {
  const links = levelLinks(await fetchRepoFile(`${MAP_DIR}/README.md`));
  return links.map(({ id, title, href }) => ({ id, title, path: `${MAP_DIR}/${href}` }));
}

// ---- Theme: follows the system until the reader pins one ----

const THEME_KEY = "meridian-architecture-theme";
const themeListeners = new Set();
const systemDark = matchMedia("(prefers-color-scheme: dark)");
export const currentTheme = () => document.documentElement.dataset.theme ?? (systemDark.matches ? "dark" : "light");

try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
} catch {
  // No storage: follow the system.
}
systemDark.addEventListener("change", () => themeListeners.forEach((cb) => cb()));

export const onThemeChange = (cb) => themeListeners.add(cb);

export function pinTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not remembered; the pin still holds for this visit.
  }
  themeListeners.forEach((cb) => cb());
}
