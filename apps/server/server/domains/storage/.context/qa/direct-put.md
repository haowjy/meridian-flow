# Direct upload canary

Checks what upload intake relies on from an S3-compatible store: signed PUT length and type,
copy, ranged reads, CORS and expiry. Run it on MinIO now, and against the R2 bucket when one
exists; R2's behavior on every line is unproven until then.

```sh
docker run -d --name probe-minio -p 127.0.0.1:19000:9000 -e MINIO_ROOT_USER=probekey \
  -e MINIO_ROOT_PASSWORD=probesecret-xx minio/minio:RELEASE.2025-09-07T16-13-09Z server /data
cd apps/server && S3_ENDPOINT=http://127.0.0.1:19000 S3_ACCESS_KEY=probekey \
  S3_SECRET_KEY=probesecret-xx pnpm exec tsx scripts/probe-direct-put.ts --serve 5190
```

For R2 set `S3_ENDPOINT` to the account endpoint, `S3_BUCKET` to the bucket and
`PROBE_ORIGIN` to the app origin. The script sets bucket CORS (PUT, `Content-Type`) where the
store supports it; MinIO answers `NotImplemented` and allows all origins by itself.

Each line prints PASS or FAIL; the exit code is the number of failures. They cover an exact PUT,
a wrong length, a wrong type, a missing type, a read URL used to write, a repeated PUT replacing
the object, a PUT after `copy` leaving the copy as it was, `readHead` of an empty, a large and a
missing object, preflight, an allow-origin header on the PUT, and an expired URL (the script
prints whether the refusal carries CORS headers: R2 sends none, so a browser can't tell an expiry
from a network failure and the client retries from `start` whatever the cause).

With `--serve`, open the printed URL in a browser (`agent-browser`): the page PUTs 5 MiB
cross-origin by XHR and reports its status and progress events. Also check that finish's `copy`
of a 200 MiB object completes inside a request on R2: it is unmeasured there.
