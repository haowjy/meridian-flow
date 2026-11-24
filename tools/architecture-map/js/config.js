import config from "../map.config.mjs";
import { globRegExp } from "./pages.js";

export const TITLE = config.title;
export const MAP_DIR = config.pagesDir;
export const NAV = config.nav ?? {};
export const STATE_MACHINES_INDEX = config.stateMachines?.index ?? null;
export const DEPENDENCIES_PAGE = config.nav?.dependencies
  ? `${MAP_DIR}/${config.dependencies.page}`
  : null;
export const DARK = config.tokens.dark;

export const storageKey = (name) => `architecture-map:${config.repo}:${name}`;

export const sourceUrl = (path) =>
  `https://github.com/${config.repo}/blob/${config.branch}/${path}`;

const docs = (config.docs ?? []).map(globRegExp);

export const opensLocally = (path) =>
  config.serveSource !== false ||
  path.startsWith(`${MAP_DIR}/`) ||
  docs.some((re) => re.test(path));
