import { type CommandSpec, flag, requirePositional, stringOption } from "../../core/command";
import { unknownJsonResponse } from "../../core/session";

type FetchResponse = {
  commit: string;
  repo: string;
  ref: string | null;
  path: string;
  dropped: { path: string; reason: string }[];
  used: { downloadBytes: number; expandedBytes: number; entries: number; elapsedMs: number };
  files: { path: string; bytes: number }[];
};

function shape(files: FetchResponse["files"], depth: number): string[] {
  const dirs = new Map<string, { files: number; bytes: number }>();
  for (const { path, bytes } of files) {
    const parts = path.split("/").slice(0, -1);
    const key = parts.slice(0, depth).join("/") || ".";
    const entry = dirs.get(key) ?? { files: 0, bytes: 0 };
    entry.files += 1;
    entry.bytes += bytes;
    dirs.set(key, entry);
  }
  return [...dirs]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, { files: count, bytes }]) => `  ${dir}/  ${count} files, ${bytes} bytes`);
}

export const packageFetchCommand: CommandSpec = {
  path: ["package", "fetch"],
  summary: "Fetch a GitHub URL through the server's fetch port and print the tree's shape",
  args: "<url>",
  route: "GET /api/debug/package-fetch",
  options: {
    commit: {
      type: "string",
      description:
        "Pin the fetch to this commit SHA; no ref lookup is made. Pair with --ref and --path from an earlier fetch",
    },
    ref: { type: "string", description: "With --commit: the ref the earlier fetch reported" },
    path: { type: "string", description: "With --commit: the path the earlier fetch reported" },
    depth: { type: "string", description: "Directory levels in the printed shape (default 2)" },
    files: { type: "boolean", description: "List every file" },
  },
  examples: [
    "./mf package fetch https://github.com/haowjy/creative-writing-skills",
    "./mf package fetch https://github.com/haowjy/creative-writing-skills/tree/v0.9.1",
  ],
  async run(ctx) {
    const search = new URLSearchParams({ url: requirePositional(ctx, 0, "<url>") });
    const commit = stringOption(ctx, "commit");
    if (commit !== undefined) search.set("commit", commit);
    for (const name of ["ref", "path"]) {
      const value = stringOption(ctx, name);
      if (value !== undefined) search.set(name, value);
    }
    const depth = Number(stringOption(ctx, "depth") ?? 2);
    const session = await ctx.session();
    const tree = (await session.request("GET", `/api/debug/package-fetch?${search}`, undefined, {
      decode: unknownJsonResponse,
    })) as FetchResponse;
    ctx.out.result(tree, (value) =>
      [
        `${value.repo} @ ${value.commit}`,
        `ref: ${value.ref ?? "(none)"}  path: ${value.path || "(root)"}`,
        `${value.files.length} files, ${value.files.reduce((sum, file) => sum + file.bytes, 0)} bytes`,
        `used: download ${value.used.downloadBytes}, expanded ${value.used.expandedBytes}, entries ${value.used.entries}, ${value.used.elapsedMs} ms`,
        ...(value.dropped.length
          ? ["dropped:", ...value.dropped.map((entry) => `  ${entry.reason}  ${entry.path}`)]
          : []),
        ...(flag(ctx, "files")
          ? value.files.map((file) => `  ${file.path}  ${file.bytes}`)
          : shape(value.files, depth)),
      ].join("\n"),
    );
    return undefined;
  },
};
