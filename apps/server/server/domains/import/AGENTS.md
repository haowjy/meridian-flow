# Import

Upload and organize are separate durable phases. Upload admission creates only
selection rows. Receipts own verified bytes in staging; the project's tree list owns the
final tree, and the last step is one submission of `create` records to it. The browser never hashes or classifies files before sending them.

- Serialize commands under the import row lock. Store each put at a fresh UUIDv7
  key, and never receipt a key older than one hour by database time.
- Import ids are permanent tombstones, including after project deletion and entry
  retention.
- Stop discards the whole import before reveal and returns without waiting for
  storage cleanup; the sweep deletes its objects and the first texts it wrote. Oversize files fail individually; skips mean a deliberate
  omission, not a failed upload.

Upload protocol and phase boundary: [.context/CONTEXT.md](.context/CONTEXT.md);
[FUTURE](.context/FUTURE.md).
