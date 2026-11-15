/**
 * Canary for direct upload against a real S3-compatible store (MinIO now, R2 when its bucket
 * exists). It drives the S3 adapter's signed PUT, copy and ranged read the way the intake does,
 * and checks what the intake relies on. Recipe: server/domains/storage/.context/qa/direct-put.md
 *
 *   S3_ENDPOINT=http://127.0.0.1:9000 S3_BUCKET=probe S3_ACCESS_KEY=... S3_SECRET_KEY=... \
 *     pnpm --filter @meridian/server exec tsx scripts/probe-direct-put.ts [--serve [port]]
 *
 * `--serve` also hosts a page on that port; open it in a browser and it PUTs cross-origin
 * through a signed URL, which is the CORS check no Node call can make.
 */
import { createServer } from "node:http";
import {
  CreateBucketCommand,
  PutBucketCorsCommand,
  type PutBucketCorsCommandInput,
  S3Client,
} from "@aws-sdk/client-s3";
import { createS3ObjectStore } from "../server/domains/storage/index.js";

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const endpoint = env("S3_ENDPOINT");
const bucket = env("S3_BUCKET", "probe-direct-put");
const credentials = { accessKeyId: env("S3_ACCESS_KEY"), secretAccessKey: env("S3_SECRET_KEY") };
const origin = process.env.PROBE_ORIGIN ?? "http://localhost:5173";
const store = (ttl: number) =>
  createS3ObjectStore({
    bucket,
    region: process.env.S3_REGION ?? "us-east-1",
    endpoint,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    forcePathStyle: true,
    signedUrlTtlSeconds: ttl,
    createBucketIfMissing: true,
  });

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }) => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const bytes = (size: number, fill: number) => new Uint8Array(size).fill(fill);
const put = (url: string, body: Uint8Array, headers: Record<string, string>) =>
  fetch(url, { method: "PUT", body, headers });
const run = Date.now().toString(36);

async function main() {
  const s3 = new S3Client({ region: "us-east-1", endpoint, forcePathStyle: true, credentials });
  await s3.send(new CreateBucketCommand({ Bucket: bucket })).catch((error: Error) => {
    if (!/AlreadyOwned|AlreadyExists/.test(error.name)) throw error;
  });
  const cors: PutBucketCorsCommandInput = {
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: [origin, "*"],
          AllowedMethods: ["PUT", "GET"],
          AllowedHeaders: ["Content-Type"],
          ExposeHeaders: ["ETag"],
          MaxAgeSeconds: 3600,
        },
      ],
    },
  };
  await s3.send(new PutBucketCorsCommand(cors)).then(
    () => console.log("INFO  bucket CORS set (PUT, Content-Type)"),
    (error: Error) =>
      console.log(`INFO  PutBucketCors refused (${error.name}); CORS is the server's setting`),
  );

  const main = store(300);
  const incoming = `incoming/probe-${run}/doc`;
  const final = `uploads/probe-${run}/doc`;
  const type = "application/pdf";
  const signed = unwrap(await main.signPut(incoming, { sizeBytes: 10, mimeType: type }));
  check("signed headers name the type", signed.headers["Content-Type"] === type);

  const exact = await put(signed.url, bytes(10, 0x41), signed.headers);
  check("exact length and type is accepted", exact.status === 200, `status ${exact.status}`);
  const wrongLength = await put(signed.url, bytes(11, 0x41), signed.headers);
  check("wrong length is refused", wrongLength.status === 403, `status ${wrongLength.status}`);
  const wrongType = await put(signed.url, bytes(10, 0x41), { "Content-Type": "text/plain" });
  check("wrong type is refused", wrongType.status === 403, `status ${wrongType.status}`);
  const noType = await put(signed.url, bytes(10, 0x41), {});
  check("missing type is refused", noType.status >= 400, `status ${noType.status}`);

  const read = unwrap(await main.getSignedUrl(incoming));
  const readAsWrite = await put(read, bytes(10, 0x41), signed.headers);
  check("a read URL cannot write", readAsWrite.status === 403, `status ${readAsWrite.status}`);

  // Why the intake copies before it reads: the same URL replaces the object.
  const replay = await put(signed.url, bytes(10, 0x42), signed.headers);
  check("a repeated PUT replaces the object", replay.status === 200, `status ${replay.status}`);
  unwrap(await main.copy(incoming, final));
  await put(signed.url, bytes(10, 0x43), signed.headers);
  const finalHead = unwrap(await main.readHead(final, 8192));
  check(
    "a PUT after the copy leaves the copied object as it was",
    finalHead.sizeBytes === 10 && finalHead.head.every((byte) => byte === 0x42),
  );

  const empty = `uploads/probe-${run}/empty`;
  unwrap(await main.put(empty, new Uint8Array(), type));
  const emptyHead = unwrap(await main.readHead(empty, 8192));
  check(
    "readHead of an empty object is size 0",
    emptyHead.sizeBytes === 0 && emptyHead.head.length === 0,
  );
  const big = `uploads/probe-${run}/big`;
  unwrap(await main.put(big, bytes(20_000, 0x44), type));
  const bigHead = unwrap(await main.readHead(big, 8192));
  check(
    "readHead reads only the head",
    bigHead.sizeBytes === 20_000 && bigHead.head.length === 8192,
  );
  const missing = await main.readHead(`uploads/probe-${run}/none`, 8192);
  check(
    "readHead of a missing object is not_found",
    !missing.ok && missing.error.code === "not_found",
  );

  const preflight = await fetch(signed.url, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  check(
    "CORS preflight allows PUT with Content-Type",
    preflight.status < 300 && Boolean(preflight.headers.get("access-control-allow-origin")),
    `status ${preflight.status}, allow-origin ${preflight.headers.get("access-control-allow-origin")}`,
  );
  const withOrigin = await put(
    unwrap(await main.signPut(`incoming/probe-${run}/cors`, { sizeBytes: 3, mimeType: type })).url,
    bytes(3, 1),
    { ...signed.headers, Origin: origin },
  );
  check(
    "a PUT answers with an allow-origin header",
    withOrigin.status === 200 && Boolean(withOrigin.headers.get("access-control-allow-origin")),
  );

  const short = store(1);
  const expiring = unwrap(
    await short.signPut(`incoming/probe-${run}/exp`, { sizeBytes: 3, mimeType: type }),
  );
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const expired = await put(expiring.url, bytes(3, 1), { ...expiring.headers, Origin: origin });
  check("an expired URL is refused", expired.status === 403, `status ${expired.status}`);
  console.log(
    `INFO  expired response allow-origin: ${expired.headers.get("access-control-allow-origin")} (R2 sends none; the browser then sees an opaque failure)`,
  );

  for (const key of [incoming, final, empty, big, `incoming/probe-${run}/cors`])
    await main.delete(key);

  const serve = process.argv.indexOf("--serve");
  if (serve >= 0) await browserCheck(main, Number(process.argv[serve + 1]) || 5190);
  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
}

/** Hosts a page that PUTs cross-origin to a signed URL, and waits for its report. */
async function browserCheck(main: ReturnType<typeof store>, port: number) {
  const size = 5 * 1024 * 1024;
  const signed = unwrap(
    await main.signPut(`incoming/probe-${run}/browser`, {
      sizeBytes: size,
      mimeType: "application/pdf",
    }),
  );
  const page = `<!doctype html><title>direct put</title><pre id=out>working</pre><script>
const file = new File([new Uint8Array(${size}).fill(7)], "x.pdf", { type: "application/pdf" });
const xhr = new XMLHttpRequest();
xhr.open("PUT", ${JSON.stringify(signed.url)});
xhr.setRequestHeader("Content-Type", ${JSON.stringify(signed.headers["Content-Type"])});
let progress = 0;
xhr.upload.onprogress = () => { progress += 1; };
const report = (status) => fetch("/result?status=" + status + "&progress=" + progress).then(() => { document.getElementById("out").textContent = "status " + status; });
xhr.onload = () => report(xhr.status);
xhr.onerror = () => report("error");
xhr.send(file);
</script>`;
  const done = new Promise<{ status: string; progress: string }>((resolve) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://x");
      if (url.pathname === "/result") {
        resolve({
          status: url.searchParams.get("status") ?? "",
          progress: url.searchParams.get("progress") ?? "",
        });
        response.end("ok");
        setTimeout(() => server.close(), 200);
      } else {
        response.setHeader("content-type", "text/html");
        response.end(page);
      }
    });
    server.listen(port, "127.0.0.1", () =>
      console.log(`INFO  open http://127.0.0.1:${port}/ in a browser (waiting up to 120 s)`),
    );
  });
  const result = await Promise.race([
    done,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 120_000)),
  ]);
  check(
    "a browser PUT from another origin succeeds with progress events",
    result?.status === "200" && Number(result.progress) > 0,
    result ? `status ${result.status}, ${result.progress} progress events` : "no report",
  );
  await main.delete(`incoming/probe-${run}/browser`);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
