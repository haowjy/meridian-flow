/*
 * The project's map.config.mjs as the viewer uses it. The dev server serves the config at
 * `map.config.mjs` beside index.html, whatever it is called on disk.
 */
import config from "../map.config.mjs";
import { globRegExp } from "./pages.js";

export const TITLE = config.title;
export const MAP_DIR = config.pagesDir;
export const NAV = config.nav ?? {};
export const STATE_MACHINES_INDEX = config.stateMachines?.index ?? null;
export const DEPENDENCIES_PAGE = config.nav?.dependencies ? `${MAP_DIR}/${config.dependencies.page}` : null;
export const STYLES = config.styles;

/** The key the viewer files a browser setting under, so two maps on one origin don't share settings. */
export const storageKey = (name) => `architecture-map:${config.repo}:${name}`;

/** A repo path on GitHub. */
export const sourceUrl = (path) => `https://github.com/${config.repo}/blob/${config.branch}/${path}`;

const docs = (config.docs ?? []).map(globRegExp);

/** Whether the dev server shows this repo path in the viewer (see `serveSource` in the config). */
export const opensLocally = (path) =>
  location.protocol !== "file:" && (config.serveSource !== false || path.startsWith(`${MAP_DIR}/`) || docs.some((re) => re.test(path)));
