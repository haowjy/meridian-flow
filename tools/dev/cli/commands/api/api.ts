/** `./mf api`: any authenticated request against this worktree's server (like `gh api`). */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { usageError } from "../../core/cli-error";
import { type CommandSpec, readJsonArg, requirePositional, stringOption } from "../../core/command";
import type { HttpMethod } from "../../core/session";

const METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export const apiCommand: CommandSpec = {
  path: ["api"],
  summary: "Send any authenticated request to the server API",
  args: "<METHOD> <path>",
  route: "any /api/* route",
  options: {
    field: {
      type: "string",
      multiple: true,
      description: "Multipart text part name=value (repeatable)",
    },
    file: {
      type: "string",
      multiple: true,
      description: "Multipart file part field=@path (repeatable)",
    },
    "timeout-ms": { type: "string", description: "Request timeout in milliseconds" },
    data: { type: "string", description: "JSON body: literal, @file, or - for stdin" },
  },
  examples: [
    "./mf api GET /api/threads",
    "./mf api POST /api/projects/bootstrap-default",
    `./mf api PATCH /api/threads/<id>/title --data '{"title":"Chapter 3 notes"}'`,
  ],
  async run(ctx) {
    const method = requirePositional(ctx, 0, "<METHOD>").toUpperCase() as HttpMethod;
    if (!METHODS.has(method)) throw usageError(`Unsupported method ${method}`);
    const path = requirePositional(ctx, 1, "<path>");
    if (!path.startsWith("/")) throw usageError("<path> must start with /, e.g. /api/threads");
    const data = stringOption(ctx, "data");
    const body = data === undefined ? undefined : readJsonArg(data, "--data");
    const files = ctx.values.file;
    const fields = ctx.values.field;
    if ((files !== undefined || fields !== undefined) && data !== undefined)
      throw usageError("--file and --data cannot be combined");
    const timeout = stringOption(ctx, "timeout-ms");
    const timeoutMs = timeout === undefined ? undefined : Number(timeout);
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0))
      throw usageError("Invalid --timeout-ms");
    const multipart =
      files === undefined && fields === undefined
        ? undefined
        : multipartFiles(
            Array.isArray(files) ? files : files === undefined ? [] : [String(files)],
            Array.isArray(fields) ? fields : fields === undefined ? [] : [String(fields)],
          );
    const session = await ctx.session();
    const response = await session.request(method, path, body, { timeoutMs, rawBody: multipart });
    ctx.out.result(response ?? null, (value) =>
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
    return undefined;
  },
};

function multipartFiles(files: string[], fields: string[]) {
  const boundary = `mf-${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const field of fields) {
    const split = field.indexOf("=");
    if (split <= 0 || /["\r\n]/.test(field.slice(0, split)))
      throw usageError("--field must be name=value");
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field.slice(0, split)}"\r\n\r\n${field.slice(split + 1)}\r\n`,
      ),
    );
  }
  for (const file of files) {
    const split = file.indexOf("=@");
    if (split <= 0) throw usageError("--file must be field=@path");
    const name = file.slice(0, split),
      path = file.slice(split + 2),
      filename = basename(path);
    if (/["\r\n]/.test(name + filename)) throw usageError("Invalid multipart field or filename");
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      readFileSync(path),
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { bytes: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
