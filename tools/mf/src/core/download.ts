/** Stream an authenticated API download to disk, publishing only a complete response. */

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { CliError } from "./cli-error";
import { httpError, type Session } from "./session";

export async function downloadApiFile(
  session: Session,
  path: string,
  output: string,
): Promise<void> {
  const url = new URL(path, session.serverUrl);
  const temporary = `${output}.${randomUUID()}.part`;
  try {
    await new Promise<void>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).get(
        url,
        {
          headers: { cookie: session.cookie },
          ...(url.protocol === "https:" && session.ca ? { ca: session.ca } : {}),
        },
        (response) => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            response.resume();
            reject(
              httpError("GET", path, {
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: "Download failed",
              }),
            );
            return;
          }
          pipeline(response, createWriteStream(temporary, { flags: "wx" })).then(resolve, reject);
        },
      );
      request.setTimeout(30000, () =>
        request.destroy(new CliError("timeout", "Download stalled for 30 seconds")),
      );
      request.on("error", reject);
    });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}
