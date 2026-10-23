import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as babel from "@babel/core";
import type { Plugin } from "vite";

function markdownWorkerDecoder(repoRoot: string): string {
  const markupRequire = createRequire(
    realpathSync(
      path.join(repoRoot, "packages/markup/node_modules/mdast-util-from-markdown/package.json"),
    ),
  );
  return markupRequire.resolve("decode-named-character-reference");
}

/** Keep the parser's entity decoder worker-safe in worker builds. */
export function markdownWorkerCharacterReferencePlugin(repoRoot: string): Plugin {
  const workerDecoder = markdownWorkerDecoder(repoRoot);
  return {
    name: "markdown-worker-character-reference-decoder",
    enforce: "pre",
    resolveId(source: string) {
      return source === "decode-named-character-reference" ? workerDecoder : undefined;
    },
  };
}

/** Dev prebundles parse-entities before worker resolve hooks can redirect its decoder. */
export function markdownWorkerDevCharacterReferencePlugin(repoRoot: string): Plugin {
  const workerDecoder = markdownWorkerDecoder(repoRoot);
  return {
    name: "markdown-worker-dev-character-reference-decoder",
    apply: "serve",
    config() {
      return {
        resolve: {
          alias: { "decode-named-character-reference": workerDecoder },
        },
      };
    },
  };
}

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
