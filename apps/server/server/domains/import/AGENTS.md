# Import

Upload and organize are separate durable phases. Upload admission creates only
selection rows. Receipts own verified bytes in staging; Context owns the final
tree. The browser never hashes or classifies files before sending them.

Serialize commands under the import row lock. Store each put at a fresh UUIDv7
key, and never receipt a key older than one hour by database time. Import ids
are permanent tombstones, including after project deletion and entry retention.

Stop discards the whole import before reveal. It changes durable state and
returns without waiting for storage cleanup. Oversize files fail individually;
skips mean a deliberate omission, not a failed upload.

See [.context/CONTEXT.md](.context/CONTEXT.md) for the upload protocol and phase
boundary, and [.context/FUTURE.md](.context/FUTURE.md) for separate sorting work.
