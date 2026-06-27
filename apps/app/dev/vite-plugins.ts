import * as babel from "@babel/core";
import type { Plugin } from "vite";

/**
 * Run `@lingui/babel-plugin-lingui-macro` over source files that import a
 * Lingui macro (`t`, `<Trans>`, `msg`, `plural`, …).
 */
export function linguiMacroBabelPlugin(): Plugin {
  const FILE_EXT = /\.[mc]?[jt]sx?$/;
  const MACRO_IMPORT = /from\s+['"]@lingui\/(?:core|react)\/macro['"]/;
  return {
    name: "meridian-lingui-macro-babel",
    enforce: "pre",
    async transform(code, id) {
      if (id.includes("/node_modules/")) return null;
      const idWithoutQuery = id.split("?")[0];
      if (!FILE_EXT.test(idWithoutQuery)) return null;
      if (!MACRO_IMPORT.test(code)) return null;

      const result = await babel.transformAsync(code, {
        filename: idWithoutQuery,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        // Babel 8 removed preset-typescript's allExtensions/isTSX. The macro runs
        // on TSX components, so force TS-with-JSX explicitly: ignoreExtensions
        // skips extension-based detection and parserOpts `jsx` enables JSX (the
        // zero-dep equivalent of @babel/plugin-syntax-jsx, which has no v8 yet).
        presets: [["@babel/preset-typescript", { ignoreExtensions: true }]],
        plugins: ["@lingui/babel-plugin-lingui-macro"],
        parserOpts: { plugins: ["jsx"] },
      });
      if (!result?.code) return null;
      return {
        code: result.code,
        map: result.map
          ? {
              ...result.map,
              names: [...result.map.names],
              sources: [...result.map.sources],
              sourcesContent: result.map.sourcesContent
                ? [...result.map.sourcesContent]
                : undefined,
            }
          : undefined,
      };
    },
  };
}

/** Externalize shiki from SSR builds (WASM not bundleable in rolldown SSR). */
export function shikiSsrExternalPlugin(): Plugin {
  const SHIKI_RE = /^(shiki|@shikijs\/)/;
  return {
    name: "meridian-shiki-ssr-external",
    enforce: "pre",
    resolveId: {
      filter: { id: SHIKI_RE },
      handler(source) {
        if (this.environment?.config.consumer === "server") {
          return { id: source, external: true };
        }
        return null;
      },
    },
  };
}
