# Supabase Storage Capabilities — Research Report

**Context:** Meridian-flow biomedical MVP filesystem redesign. Evaluating Supabase Storage as the universal binary file store, with a metadata DB layer on top and Daytona sandbox access. Must support DICOM stacks up to ~500 MB.

---

## 1. Upload Methods Overview

Supabase Storage offers three interoperable upload protocols. You can mix them freely — upload via S3 API, list via REST API, etc.

| Method | Best For | File Size Guidance |
|--------|----------|-------------------|
| Standard upload | Small files, simple clients | Up to 5 GB technically, but not reliable for large files |
| Resumable upload (TUS) | Large files, unreliable connections | Recommended for files > 6 MB |
| S3 multipart upload | High-throughput parallel uploads | Best for large files from server-side code |

---

## 2. Resumable Uploads (TUS Protocol)

### Protocol Details
Supabase implements the [TUS open protocol](https://tus.io/) for resumable uploads. The implementation is generally available (not alpha).

**Key constraints:**
- **Chunk size: exactly 6 MB** — hardcoded, must not be changed. The Supabase docs state this explicitly: "it must be set to 6MB (for now) do not change it."
- **Upload URL valid for 24 hours** — if not completed within 24 hours, the URL expires and the upload must restart from scratch.
- **Only one active client per upload URL** — concurrent clients to the same URL get `409 Conflict`. Multiple clients uploading to the same path with different URLs: first to complete wins (unless `x-upsert` header is set, in which case last to complete wins).
- **Performance tip:** Use the direct storage hostname `https://<project-id>.storage.supabase.co` rather than `https://<project-id>.supabase.co` for "several performance enhancements."

### Client Libraries
- **JavaScript/TypeScript:** `tus-js-client`, or Uppy (higher-level, with TUS plugin). Uppy examples are in the Supabase repo.
- **Python:** `tus-py-client`
- **Kotlin:** Native support
- **Go:** See §6 below

### Resumability Mechanics
TUS stores upload state server-side; the client resumes by querying the current offset then continuing from that byte position. This works across disconnects, process restarts, etc.

---

## 3. Pre-Signed (Signed) URLs

Signed URLs are time-limited, token-bearing URLs for accessing private bucket files without requiring the caller to hold a JWT.

### Download Signed URLs
- **Method:** `createSignedUrl(bucket, path, expiresIn)` — returns a URL valid for `expiresIn` seconds.
- **Bulk variant:** `createSignedUrls(bucket, paths[], expiresIn)` — batch generation, more efficient than calling one-by-one.
- **SDK coverage:** JavaScript, Python, Dart/Flutter. **No official Go SDK method**, but the REST endpoint is callable directly (see §6).

### Upload Signed URLs
- **Method:** `createSignedUploadUrl(bucket, path)` — generates a URL for a one-time upload, valid for **2 hours**.
- Paired with `uploadToSignedUrl(bucket, path, token, file)` on the client side.
- Use case: let an untrusted client (e.g., a sandbox) upload directly to storage without holding a service key.

### Public URL (no signing)
- For public buckets: `getPublicUrl(bucket, path)` returns a stable, permanent URL with no token.
- Public buckets serve with CDN and achieve high cache-HIT ratios.
- Download trigger: append `?download` or `?download=filename.ext` to force browser download.

### Caveats
- Signed URLs are generated server-side (never expose the service key to generate them client-side).
- For private buckets, signed URLs are the standard delivery pattern; alternatively, the Edge Function can proxy bytes.

---

## 4. File Size Limits

### Per-Plan Global Limits

| Plan | Max File Size |
|------|--------------|
| Free | 50 MB |
| Pro | 500 GB |
| Team | 500 GB |
| Enterprise | Custom (contact Supabase) |

**For Meridian:** Pro plan supports up to 500 GB per file — well above the 500 MB DICOM requirement.

### Configuration
- **Global limit** is configured in Storage Settings in the Supabase dashboard. Set it to the highest file size your application accepts.
- **Per-bucket limits** can be more restrictive than the global limit (e.g., a `thumbnails` bucket limited to 5 MB, while a `dicoms` bucket allows 500 MB).
- **Per-bucket MIME type restrictions** are also configurable at the bucket level (e.g., only allow `application/dicom`, `text/csv`, etc.).

### Standard vs Resumable for Large Files
For files approaching or exceeding 100 MB, the TUS resumable upload is strongly preferred over standard POST. Network interruptions mid-upload on standard uploads require a full restart; TUS resumes from the last acknowledged chunk.

---

## 5. S3 Compatibility

### Overview
Supabase Storage exposes an S3-compatible API. Launched April 2024, currently in alpha but used in production by many teams.

**S3 endpoint:** `https://<project-ref>.storage.supabase.co/storage/v1/s3`

Important: set `forcePathStyle: true` in any AWS SDK configuration; Supabase does not support virtual-hosted-style bucket addressing.

### Supported S3 Operations

| Category | Operations |
|----------|-----------|
| Buckets | ListBuckets, HeadBucket, CreateBucket, DeleteBucket, GetBucketLocation |
| Objects | HeadObject, ListObjects, ListObjectsV2, GetObject, PutObject, DeleteObject, DeleteObjects, CopyObject |
| Multipart | CreateMultipartUpload, UploadPart, UploadPartCopy, CompleteMultipartUpload, AbortMultipartUpload, ListMultipartUploads, ListParts |

**Multipart upload** is fully supported. This is the S3-native equivalent of TUS resumable uploads — breaks large files into parts (AWS minimum 5 MB per part, except last), uploads in parallel, then assembles. Well-supported by boto3, the AWS Go SDK, and rclone.

### NOT Supported
- **No S3 versioning** — deleted objects are permanently removed.
- **No bucket configuration via S3 API**: no CORS, encryption, lifecycle policies through S3 API (configure via Supabase dashboard instead).
- **No SSE-C encryption, ACLs, object locking, tagging.**
- **No Content-MD5 checksums.**

### S3 Authentication

**Two modes:**

1. **S3 Access Keys (server-side use only)**
   - Generated from: Project Settings → Storage → S3 Access Keys
   - Yields: Access Key ID + Secret Access Key + Endpoint + Region
   - **Bypasses RLS entirely** — full access to all buckets/objects.
   - Store in `~/.aws/credentials` (for CLI tools) or pass directly to SDK.
   - Never expose publicly.

2. **Session Token / JWT credentials (client-side / RLS-scoped)**
   - `accessKeyId`: project_ref
   - `secretAccessKey`: anonKey
   - `sessionToken`: valid user JWT
   - Respects RLS policies on `storage.objects` — enforces per-user access.

### S3-Compatible Tools That Work Out of the Box
- **AWS CLI** (`aws --endpoint-url ... s3 ls`, `s3 cp`, `s3 sync`)
- **rclone** — can mount as a local directory via FUSE, sync directories
- **boto3** — Python S3 client; standard endpoint override
- **AWS Go SDK v2** — standard `EndpointResolverWithOptions` override
- **DuckDB** — can query CSV/Parquet files directly from bucket
- **Cyberduck** — GUI browser

---

## 6. Go SDK Options

### Option A: `supabase-community/storage-go` (community-maintained)

**Repo:** https://github.com/supabase-community/storage-go  
**Version:** v0.7.0 (October 2023)  
**Stars:** 61 | **Language:** 100% Go

**API surface:**
- Bucket CRUD: `CreateBucket`, `GetBucket`, `UpdateBucket`, `EmptyBucket`, `DeleteBucket`, `ListBuckets`
- File ops: `UploadFile`, `DownloadFile`, `ListFiles`, `UpdateFile`, `MoveFile`, `RemoveFile`
- URLs: `CreateSignedUrl`, `GetPublicUrl`, `CreateSignedUploadUrl`, `UploadToSignedUrl`

**Issues:**
- Last release October 2023 — 18+ months stale.
- Does not implement TUS resumable uploads natively.
- 5 open issues, 5 open PRs — not very active.
- For large file uploads, you'd need to fall back to raw HTTP or a separate TUS client.

**Verdict:** Useful for bucket management, signed URL generation, small file operations. Not sufficient as the sole upload path for large binary files.

### Option B: `supabase-community/supabase-go` (unified client)

**Repo:** https://github.com/supabase-community/supabase-go  
Wraps `storage-go` alongside Auth and PostgREST clients. Same storage surface, same limitations.

### Option C: AWS Go SDK v2 via S3-compatible endpoint

**Repo:** https://github.com/aws/aws-sdk-go-v2  
Fully maintained, actively developed by AWS.

**Use for Supabase Storage:**
```go
cfg, _ := config.LoadDefaultConfig(ctx,
    config.WithRegion("auto"),
    config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
        accessKeyID, secretAccessKey, "",
    )),
    config.WithEndpointResolverWithOptions(
        aws.EndpointResolverWithOptionsFunc(func(service, region string, opts ...interface{}) (aws.Endpoint, error) {
            return aws.Endpoint{
                URL:               "https://<project-ref>.storage.supabase.co/storage/v1/s3",
                HostnameImmutable: true,
            }, nil
        }),
    ),
)
s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
    o.UsePathStyle = true  // Required
})
```

Supports multipart uploads via the `s3manager.Uploader` (automatically chunks and parallelizes uploads above a configurable threshold, default 5 MB parts).

**Verdict:** Best choice for large binary file uploads from the Go backend. Full multipart support, actively maintained, battle-tested.

### Option D: TUS Go Client (`tus/tus-go-client`)

**Repo:** https://github.com/tus/tus-go-client  
**Version:** v0.1.2 (November 2024) — actively maintained by the TUS org  
**Go requirement:** 1.18+

**API:**
```go
cl := tusgo.NewClient(httpClient, tusEndpointURL)
upload, _ := cl.CreateUpload(tusgo.Upload{})
stream := tusgo.NewUploadStream(cl, &upload)
stream.Sync()  // Sync current offset with server
io.Copy(stream, fileReader)
```

**Limitation:** Intermediate chunk state is in-memory only (no disk buffering). For a long-running server process uploading very large files, this is fine; for a CLI tool that might be killed, you'd need to persist the upload URL externally to resume.

**Supabase-specific:** You'd send the TUS upload to `https://<project-ref>.storage.supabase.co/storage/v1/upload/resumable` with proper auth headers (Authorization: Bearer <service_key> or JWT).

**Verdict:** Good option when you need TUS semantics (24-hour resumption window, progress tracking) from Go. Pair with AWS SDK v2 multipart for maximum flexibility.

### Recommendation for Meridian Backend (Go)

Use **AWS SDK v2** as the primary upload path for binary files:
- Multipart upload handles files of any size with parallel chunks.
- Well-understood, stable API.
- Same credentials as S3-compatible access.

Use **storage-go** for administrative operations (bucket creation, signed URL generation, file metadata queries) where the API surface is sufficient.

Consider **tus-go-client** if you need client-resumable uploads initiated from user browsers (where the backend acts as a TUS proxy) rather than backend-to-bucket uploads.

---

## 7. Bucket Policies and RLS

### Bucket-Level Configuration (Supabase Dashboard / Management API)
- **Public vs Private:** Private by default. Public buckets serve files to anyone with the URL, bypassing RLS for reads. Uploads/deletes still enforce RLS.
- **Per-bucket file size limit:** Lower bound than the global limit.
- **Allowed MIME types:** Whitelist specific content types per bucket.

### Row Level Security on `storage.objects`

All fine-grained access control is implemented as Postgres RLS policies on the `storage.objects` table. Operations map to SQL permissions:

| Storage Operation | SQL Permission Required |
|------------------|------------------------|
| Upload (new file) | INSERT |
| Overwrite/upsert | SELECT + UPDATE + INSERT |
| Download | SELECT |
| Delete | DELETE |

**Common policy patterns:**

```sql
-- Authenticated users can upload to their own project folder
CREATE POLICY "project_upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'project-files' AND
    (storage.foldername(name))[1] = auth.jwt()->>'project_id'
  );

-- Owner can read their files
CREATE POLICY "owner_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid());
```

**Service role key bypass:** The service role key entirely skips RLS. This is appropriate for:
- Backend-to-bucket uploads (Go backend writing DICOM files)
- Sandbox access (Daytona reading/writing project files)
- Administrative operations

**Never expose the service role key to client-side code.**

### Recommended Bucket Architecture for Meridian

```
Bucket: project-files
  Path pattern: {project_id}/{file_path}
  
  RLS: backend uses service role (bypasses RLS)
  Sandbox: uses service role (bypasses RLS)  
  Future user access: signed URLs generated server-side
```

Single bucket per environment (dev/staging/prod), project-scoped by path prefix. Avoids bucket sprawl and keeps management simple.

---

## 8. Pro Plan Limits Summary

| Dimension | Free | Pro ($25/mo) |
|-----------|------|-------------|
| Max file size | 50 MB | 500 GB |
| Included storage | 1 GB | 100 GB |
| Storage overage | — | $0.021/GB |
| Included egress | 5 GB (uncached) + 5 GB (cached) | 250 GB |
| Egress overage | — | $0.09/GB |
| Image transforms | Limited | Included |

**For DICOM-heavy workloads:** 100 GB included storage will fill quickly with large scan datasets. Budget for $0.021/GB overage. A 1 TB dataset costs ~$18.90/month in storage overage beyond the included 100 GB.

**Egress:** 250 GB/month free. Sandbox downloads of large DICOM stacks will consume egress. A Daytona sandbox downloading a 500 MB scan = 0.5 GB egress. If sandboxes run 500 jobs/month, that's 250 GB egress — right at the limit.

**Mitigation:** Keep processed outputs in the sandbox; only upload final results back to the bucket. Avoid redundant re-downloads.

---

## 9. Daytona Sandbox Access to Supabase Storage

### Three Viable Approaches

#### Approach A: Direct S3 API from sandbox code (Recommended)

The sandbox Python/R code uses boto3 (or another S3 client) to access Supabase Storage directly over HTTPS.

```python
import boto3

s3 = boto3.client(
    "s3",
    endpoint_url="https://<project-ref>.storage.supabase.co/storage/v1/s3",
    aws_access_key_id=ACCESS_KEY_ID,
    aws_secret_access_key=SECRET_ACCESS_KEY,
    region_name="auto",
    config=Config(s3={"addressing_style": "path"}),  # forcePathStyle equivalent
)

# Download a DICOM file
s3.download_file("project-files", f"{project_id}/scans/scan1.dcm", "/workspace/scan1.dcm")

# Upload a result
s3.upload_file("/workspace/result.csv", "project-files", f"{project_id}/results/result.csv")
```

**Pros:**
- No infrastructure beyond bucket credentials.
- Works with existing S3-aware Python libraries (boto3, s3fs for pandas/xarray, etc.).
- Fully async-compatible with aiobotocore.
- Fine-grained: only download what you need.

**Cons:**
- Requires injecting credentials into sandbox environment at job start.
- Direct network egress for every file access — no local caching.
- Requires explicit download step before processing; sandbox does not have "files" natively.

#### Approach B: FUSE mount via Daytona Volumes

Daytona Volumes are FUSE-based mounts backed by S3-compatible object storage. A volume can mount a subdirectory of the bucket as a local path inside the sandbox.

```python
# Daytona SDK — create and mount a volume
volume = daytona.volumes.create(name="project-123-data")
sandbox.volumes.attach(volume_id=volume.id, mount_path="/data")
# Files at /data/scans/scan1.dcm are transparently fetched from S3
```

**Pros:**
- Files appear as a normal local directory — no code changes needed in Python scripts.
- Shared across multiple sandboxes simultaneously.
- Volume data persists independently of sandbox lifecycle.
- Multiple sandboxes can share the same volume (e.g., parallel analysis jobs).

**Cons:**
- FUSE read/write performance is slower than local disk — significant latency per seek for large binary files.
- DICOM readers are seek-heavy; FUSE latency per seek could make reads very slow for large stacks.
- Daytona volumes are backed by Daytona's own S3, not necessarily Supabase Storage — you'd need to verify whether custom S3 endpoints can be used, or whether this requires data to live in Daytona's storage.
- Volume data does not consume Supabase Storage quota (it's Daytona's storage), which could mean duplicating data.

**Verdict:** Good for cases where data is already in Daytona. For Supabase Storage as source-of-truth, Approach A (direct S3) or Approach C (copy-on-start) is cleaner.

#### Approach C: Copy-on-Start (Explicit Sync)

The backend service synchronizes files from Supabase Storage into the sandbox before job execution. Results are synced back on completion.

```
1. Job starts → backend generates signed URLs or uses service key
2. Backend calls Daytona file upload API to push files into sandbox
3. Sandbox processes files locally (full local I/O performance)
4. On completion, sandbox uploads results via S3 API or backend fetches them
```

**Pros:**
- Full local I/O speed during processing — no FUSE overhead.
- Clean separation: sandbox does not need S3 credentials.
- Atomic: file set is consistent at job start.

**Cons:**
- Startup latency: a 500 MB DICOM stack takes time to transfer in.
- Results must be explicitly pushed back.
- Requires backend orchestration logic to manage the copy cycle.

**Verdict:** Best when processing time dominates and startup latency is acceptable. Especially good for batch jobs.

### Recommended Pattern for Meridian

**Default: Approach A (Direct S3)** — inject S3 credentials as environment variables into the sandbox at job start. Sandbox code uses boto3 for targeted file access. Simple, explicit, no extra infrastructure.

**For bulk batch jobs: Approach C (Copy-on-Start)** — when a job needs hundreds of DICOM files, pre-stage them via the Daytona file upload API, process locally, then push results back via S3.

**Avoid Approach B (FUSE)** unless Daytona confirms custom S3 endpoint support and DICOM I/O performance over FUSE is validated. FUSE seek latency is a real concern for DICOM stacks.

---

## 10. Known Real-World Issues and Gotchas

### TUS 24-Hour Expiry
If an upload is interrupted and not resumed within 24 hours, the entire upload must restart. For very large DICOM stacks from unreliable client connections, ensure the TUS client is configured to retry aggressively and the user knows the window. The server does not clean up incomplete uploads automatically — you need a scheduled cleanup job or rely on Supabase's background cleanup.

### S3 Alpha Status
The S3-compatible endpoint was launched in alpha (April 2024). As of early 2026, it's widely used but not marked GA. Monitor for breaking changes and test against the actual endpoint periodically.

### storage-go Library Staleness
The community Go storage client has not had a release since October 2023. For production use, either fork it to add needed methods or use the REST API directly for operations not covered by the library.

### RLS Policies Are Postgres Policies — Not IAM
RLS policies are evaluated per-request in Postgres. For high-throughput scenarios (many small files), this adds Postgres query overhead per operation. With service role key (RLS bypass), this overhead disappears. For the single-user MVP, this is not a concern.

### No Object Versioning
Supabase Storage has no versioning. Overwriting a file permanently destroys the previous version. If DICOM data integrity matters, implement application-level versioning (e.g., immutable paths with version in filename or DB metadata).

### Egress Costs for Sandbox Access
Every file the sandbox downloads is egress. For large DICOM stacks downloaded repeatedly across jobs, this adds up. Implement a local cache or use Approach C (copy-once, process locally).

### FUSE DICOM Performance
DICOM files are not sequential reads — many DICOM libraries seek to specific offsets to read metadata then image data. FUSE (s3fs/gcsfuse) performs poorly with random-access seek patterns on large files because each seek may trigger an HTTP range request. Benchmark before committing to FUSE-based access for DICOM processing.

---

## 11. Decision Summary

| Decision | Recommendation |
|----------|---------------|
| Upload protocol for large binary files | S3 multipart via AWS SDK v2 (from Go backend) |
| Upload protocol for browser clients | TUS resumable (tus-js-client + @supabase/storage-js) |
| Go SDK for bucket management / signed URLs | storage-go (v0.7.0) for admin ops; AWS SDK v2 for uploads |
| Bucket structure | Single bucket, `{project_id}/{path}` prefixes |
| Access control | Service role key for backend/sandbox; signed URLs for any future client delivery |
| Daytona sandbox file access | Direct S3 API (boto3) with credentials injected at job start |
| Max file size | 500 GB ceiling on Pro; set global limit to 500 MB for DICOM safety margin |

---

## Sources

- [Resumable Uploads | Supabase Docs](https://supabase.com/docs/guides/storage/uploads/resumable-uploads)
- [Standard Uploads | Supabase Docs](https://supabase.com/docs/guides/storage/uploads/standard-uploads)
- [File Limits | Supabase Docs](https://supabase.com/docs/guides/storage/uploads/file-limits)
- [S3 Compatibility | Supabase Docs](https://supabase.com/docs/guides/storage/s3/compatibility)
- [S3 Authentication | Supabase Docs](https://supabase.com/docs/guides/storage/s3/authentication)
- [Storage Access Control | Supabase Docs](https://supabase.com/docs/guides/storage/security/access-control)
- [Storage Buckets | Supabase Docs](https://supabase.com/docs/guides/storage/buckets/fundamentals)
- [Serving Downloads | Supabase Docs](https://supabase.com/docs/guides/storage/serving/downloads)
- [Bandwidth & Storage Egress | Supabase Docs](https://supabase.com/docs/guides/storage/serving/bandwidth)
- [Storage Pricing | Supabase Docs](https://supabase.com/docs/guides/storage/pricing)
- [Storage Schema Design | Supabase Docs](https://supabase.com/docs/guides/storage/schema/design)
- [Supabase Storage S3 Protocol Blog Post](https://supabase.com/blog/s3-compatible-storage)
- [supabase-community/storage-go](https://github.com/supabase-community/storage-go)
- [tus/tus-go-client](https://github.com/tus/tus-go-client)
- [Daytona File System Operations](https://www.daytona.io/docs/en/file-system-operations/)
- [Daytona Volumes](https://www.daytona.io/docs/en/volumes/)
