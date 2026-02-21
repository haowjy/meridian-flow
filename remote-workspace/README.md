# Remote Workspace

Mobile-friendly read/upload web workspace for this repository.

## Features

- Browse repository folders/files
- Upload images into `.clipboard/` at repo root (single image per upload)
- Preview text files and images
- Render Markdown with Mermaid diagrams
- Hide and block access to dotfiles/dot-directories (for example `.env`, `.git`)
- Dedicated collapsible `.clipboard` panel for upload + quick image viewing

This app is intentionally **no-edit** (image upload only) to keep remote access simple and lower risk.
Uploads are restricted to one image per request with required filename validation.

## Start

From repo root:

```bash
./remote-workspace/run.sh
```

By default it serves on `127.0.0.1:18080`.

`run.sh` always configures Tailscale Serve (tailnet-only) before starting.

Explicit serve mode (same behavior):

```bash
./remote-workspace/run.sh --serve
```

Copy/paste startup script:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /home/jimyao/gitrepos/meridian-collab
./remote-workspace/run.sh
```

## Options

```bash
./remote-workspace/run.sh --port 18111
./remote-workspace/run.sh --install
./remote-workspace/run.sh --serve
```

## Environment

- `REMOTE_WS_PORT` (default `18080`)
- `REMOTE_WS_MAX_PREVIEW_BYTES` (default `1048576`)
- `REMOTE_WS_MAX_UPLOAD_BYTES` (default `26214400`)
- `REPO_ROOT` (injected by launcher script)

## Upload Clipboard

- `POST /api/upload` always writes to `REPO_ROOT/.clipboard`
- `.clipboard` panel uses dedicated clipboard endpoints (`/api/clipboard/list`, `/api/clipboard/file`)
- Main repository browser still blocks all hidden paths and gitignored paths
- Gitignored paths are hidden/blocked (for example `node_modules/`, build artifacts, local secrets)
- Accepted upload types are images only (`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `bmp`, `heic`, `heif`, `avif`)
- Upload requires `name` query parameter (filename is user-controlled)
- Filename rules: no spaces, no leading dot, `[A-Za-z0-9._-]` only, and must use an allowed image extension
- Multipart field names accepted: `file` (current UI) and `files` (legacy cached UI compatibility)

## Tailscale

Tailscale Serve is enabled by default and stays private to your tailnet.

```bash
# Tailnet-only URL
./remote-workspace/run.sh
```

Manual commands (equivalent):

```bash
tailscale serve --bg --https=443 127.0.0.1:18080
```
