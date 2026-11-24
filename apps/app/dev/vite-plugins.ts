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
        // keep: Babel 8 dropped allExtensions/isTSX, so TSX macros need ignoreExtensions plus parserOpts jsx
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
              ignoreList: result.map.ignoreList ? [...result.map.ignoreList] : undefined,
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
