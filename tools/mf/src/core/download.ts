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
  const origin = new URL(path, session.serverUrl);
  const temporary = `${output}.${randomUUID()}.part`;
  // A stored file answers with one redirect to a signed store URL. The cookie goes only to the
  // server's own origin, never to the store.
  const fetchInto = (url: URL, redirected: boolean) =>
    new Promise<void>((resolve, reject) => {
      const sameOrigin = url.origin === origin.origin;
      const request = (url.protocol === "https:" ? https : http).get(
        url,
        {
          headers: sameOrigin ? { cookie: session.cookie } : {},
          ...(url.protocol === "https:" && sameOrigin && session.ca ? { ca: session.ca } : {}),
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const location = response.headers.location;
          if (status >= 300 && status < 400 && location && !redirected) {
            response.resume();
            fetchInto(new URL(location, url), true).then(resolve, reject);
            return;
          }
          if (status < 200 || status >= 300) {
            response.resume();
            reject(
              httpError("GET", path, {
                status,
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
  try {
    await fetchInto(origin, false);
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}
