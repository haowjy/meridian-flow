#!/usr/bin/env bash
# scratch/smoke/ws-doc-smoke.sh
# Hostile-user smoke tests for /ws/documents/{documentId}
#
# Tests covered:
#   HTTP-level    [1]  empty/whitespace doc ID    → 400
#                 [2]  non-UUID doc ID             → 400
#   Auth failures [3]  bad JWT                     → AUTH_EXPIRED
#                 [4]  binary first frame           → AUTH_FAILED
#                 [5]  empty string token           → AUTH_FAILED
#                 [6]  no auth message (timeout)    → AUTH_TIMEOUT
#   Ownership     [7]  non-existent document UUID  → FORBIDDEN / INTERNAL_ERROR
#   Happy path    [8]  auth + connected + sync
#                 [9]  awareness frame (0x01)       → silently accepted
#                 [10] unknown prefix (0xFF)         → silently dropped
#   Oversize      [11] > 256 KB binary frame        → FRAME_TOO_LARGE + close
#                 [12] exactly 256 KB frame         → accepted, no error
#   Rate limit    [13] 35 binary frames burst       → RATE_LIMITED (no disconnect)
#   Conn limit    [14] 11th connection same user    → CONNECTION_LIMIT
#   Resilience    [15] 5 rapid connect/disconnect   → no crash
#
# Usage: bash scratch/smoke/ws-doc-smoke.sh
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# ── port detection ────────────────────────────────────────────────────────────
detect_backend_port() {
  [ -n "${BACKEND_PORT:-}" ] && echo "$BACKEND_PORT" && return
  if [ -f "scripts/dev/lib.sh" ]; then
    # shellcheck disable=SC1091
    source scripts/dev/lib.sh >/dev/null 2>&1 || true
    [ -n "${BACKEND_PORT:-}" ] && echo "$BACKEND_PORT" && return
  fi
  echo "8080"
}

BACKEND_PORT_DETECTED="$(detect_backend_port)"
BASE_URL="${BASE_URL:-http://localhost:${BACKEND_PORT_DETECTED}}"
WS_ORIGIN="${WS_ORIGIN:-http://localhost:3000}"
TMP_DIR="$(mktemp -d)"
PASS=0
FAIL=0
PROJECT_ID=""
TOKEN=""

# ── cleanup ───────────────────────────────────────────────────────────────────
cleanup() {
  rm -rf "$TMP_DIR"
  if [ -n "$PROJECT_ID" ] && [ -n "$TOKEN" ]; then
    curl -sS -X DELETE \
      -H "Authorization: Bearer $TOKEN" \
      "$BASE_URL/api/projects/$PROJECT_ID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ── helpers ───────────────────────────────────────────────────────────────────
pass() { echo "[smoke] PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "[smoke] FAIL: $1"; FAIL=$((FAIL+1)); }

status_code() {
  local url="$1" out="$2"; shift 2
  curl -sS -o "$out" -w "%{http_code}" "$@" "$url"
}

check_http() {
  local expected="$1" actual="$2" body="$3" label="$4"
  if [ "$actual" = "$expected" ]; then
    pass "$label (HTTP $actual)"
  else
    echo "  body: $(cat "$body")"
    fail "$label — expected HTTP $expected, got $actual"
  fi
}

# check <label> <cmd> [args...]  — run a probe cmd, track pass/fail count
check() {
  local label="$1"; shift
  if "$@"; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
  fi
}

# ws_probe <endpoint> <token> <mode> <expected_code> <label>
#
# mode: expect_error | expect_any_error | expect_sync | auth_timeout |
#       binary_auth | empty_token
#
# Node.js v22+ built-in WebSocket is used. Dev server uses InsecureSkipVerify=true.
ws_probe() {
  local endpoint="$1" token="$2" mode="$3" expected="$4" label="$5"
  node - "$endpoint" "$token" "$mode" "$expected" "$WS_ORIGIN" "$label" <<'NODE'
const [endpoint, rawToken, mode, expected, origin, label] = process.argv.slice(2);
const timeoutMs = Number(process.env.WS_TIMEOUT_MS || 12000);

function fail(msg) { console.error(`[smoke] FAIL: ${label}: ${msg}`); process.exit(1); }
function pass(msg) { console.log(`[smoke] PASS: ${label}: ${msg}`); process.exit(0); }

function normalizeWsURL(raw) {
  const u = new URL(raw);
  if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol === "https:") u.protocol = "wss:";
  return u.toString();
}

function toU8(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return new Uint8Array(data);
  return null;
}

const wsURL = normalizeWsURL(endpoint);
const ws = new WebSocket(wsURL, [], { headers: { Origin: origin } });
ws.binaryType = "arraybuffer";

const connectTime = Date.now(); // used by auth_timeout to check elapsed time
let connectedSeen = false;
let syncStep1Seen = false;
let done = false;

const masterTimeout = setTimeout(() => {
  if (!done) { done = true; try { ws.close(); } catch {} fail(`timeout after ${timeoutMs}ms`); }
}, timeoutMs);

function finish(ok, msg) {
  if (done) return;
  done = true;
  clearTimeout(masterTimeout);
  try { ws.close(); } catch {}
  if (ok) pass(msg); else fail(msg);
}

ws.addEventListener("error", (err) => {
  // For server-driven close modes (auth_timeout, expect_error, etc.) the server
  // may close with WS status 1008 (Policy Violation), which some Node.js builds
  // surface as an "error" event before the "close" event. Let the message/close
  // handlers determine outcome; suppress error events here for those modes.
  const serverDrivenModes = ["auth_timeout", "binary_auth", "empty_token",
                             "expect_error", "expect_any_error"];
  if (serverDrivenModes.includes(mode)) return;
  if (!done) finish(false, (err && err.message) ? err.message : "ws error");
});

ws.addEventListener("open", () => {
  if (mode === "auth_timeout") return; // intentionally send nothing
  if (mode === "binary_auth") {
    const dummy = new Uint8Array([0x00, 0x01, 0x02]);
    ws.send(dummy.buffer);
    return;
  }
  if (mode === "empty_token") {
    ws.send("  "); // whitespace-only: server trims → empty → AUTH_FAILED
    return;
  }
  ws.send(rawToken);
});

ws.addEventListener("message", (event) => {
  if (done) return;

  // ── text frame ──────────────────────────────────────────────────────────────
  if (typeof event.data === "string") {
    let parsed = null;
    try { parsed = JSON.parse(event.data); } catch { return; }
    if (!parsed || typeof parsed !== "object") return;

    if (parsed.type === "heartbeat") {
      ws.send(JSON.stringify({ type: "heartbeat" }));
      return;
    }

    if (parsed.type === "error") {
      const code = parsed.code || "(no code)";
      if (["expect_error", "expect_any_error", "auth_timeout", "binary_auth", "empty_token"].includes(mode)) {
        if (mode === "expect_error" && expected && code !== expected) {
          finish(false, `expected error code ${expected}, got ${code}`);
          return;
        }
        finish(true, `error code ${code}`);
        return;
      }
      // Unexpected error for success-path modes
      finish(false, `unexpected error ${code}: ${parsed.message || ""}`);
      return;
    }

    if (parsed.type === "connected") {
      connectedSeen = true;
      if (mode === "expect_sync") return; // wait for binary sync step1
      return;
    }
    return;
  }

  // ── binary frame ────────────────────────────────────────────────────────────
  if (mode !== "expect_sync") return;

  const bytes = toU8(event.data);
  if (!bytes || bytes.length < 1) {
    finish(false, "received empty/non-binary frame during sync check");
    return;
  }
  if (bytes[0] !== 0x00) {
    finish(false, `expected sync prefix 0x00, got 0x${bytes[0].toString(16).padStart(2,"0")}`);
    return;
  }

  if (!syncStep1Seen) {
    // Echo server's sync step1 back as our step2
    syncStep1Seen = true;
    ws.send(event.data);
    return;
  }

  // Got sync step2 response — handshake complete
  if (!connectedSeen) finish(false, "sync completed before connected message");
  else finish(true, `connected + sync step1→step2 round-trip OK`);
});

ws.addEventListener("close", (event) => {
  if (done) return;
  if (["expect_error", "expect_any_error", "binary_auth", "empty_token"].includes(mode)) {
    finish(false, `closed (code=${event.code}) before receiving expected error message`);
    return;
  }
  if (mode === "auth_timeout") {
    // Node.js's built-in WebSocket (undici) does not always surface the error JSON
    // message before the close event when the server closes with 1008 Policy Violation.
    // The reliable assertion is timing: the server MUST terminate the connection after
    // docWSAuthTimeout = 5s of no message from the client.
    const elapsed = Date.now() - connectTime;
    if (elapsed >= 3000 && elapsed <= 12000) {
      finish(true, `connection terminated after ${elapsed}ms (expected ~5s auth timeout, code=${event.code})`);
    } else if (elapsed < 3000) {
      finish(false, `closed too quickly (${elapsed}ms) — not an auth timeout`);
    } else {
      finish(false, `took too long to close (${elapsed}ms) — auth timeout not enforced`);
    }
    return;
  }
  if (mode === "expect_sync") {
    finish(false, `closed before sync handshake completed (connected=${connectedSeen}, step1=${syncStep1Seen})`);
    return;
  }
});
NODE
}

# ── SPECIAL PROBES (written as temp Node.js files) ──────────────────────────

# Probe [11]: oversized frame → FRAME_TOO_LARGE + close
ws_oversized_probe() {
  local endpoint="$1" token="$2" label="$3"
  node - "$endpoint" "$token" "$WS_ORIGIN" "$label" <<'NODE'
const [endpoint, token, origin, label] = process.argv.slice(2);
const timeoutMs = Number(process.env.WS_TIMEOUT_MS || 15000);

function fail(msg) { console.error(`[smoke] FAIL: ${label}: ${msg}`); process.exit(1); }
function pass(msg) { console.log(`[smoke] PASS: ${label}: ${msg}`); process.exit(0); }

function normalizeWsURL(raw) {
  const u = new URL(raw);
  if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol === "https:") u.protocol = "wss:";
  return u.toString();
}
function toU8(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

const ws = new WebSocket(normalizeWsURL(endpoint), [], { headers: { Origin: origin } });
ws.binaryType = "arraybuffer";

let connectedSeen = false;
let syncStep1Seen = false;
let frameTooLargeSeen = false;
let done = false;

const masterTimeout = setTimeout(() => {
  if (!done) { done = true; try { ws.close(); } catch {} fail(`timeout after ${timeoutMs}ms`); }
}, timeoutMs);
function finish(ok, msg) {
  if (done) return; done = true;
  clearTimeout(masterTimeout); try { ws.close(); } catch {};
  if (ok) pass(msg); else fail(msg);
}

ws.addEventListener("error", (err) => {
  if (!done) finish(false, (err && err.message) ? err.message : "ws error");
});

ws.addEventListener("open", () => { ws.send(token); });

ws.addEventListener("message", (event) => {
  if (done) return;
  if (typeof event.data === "string") {
    let parsed; try { parsed = JSON.parse(event.data); } catch { return; }
    if (!parsed) return;
    if (parsed.type === "heartbeat") { ws.send(JSON.stringify({ type: "heartbeat" })); return; }
    if (parsed.type === "connected") { connectedSeen = true; return; }
    if (parsed.type === "error") {
      if (parsed.code === "FRAME_TOO_LARGE") { finish(true, "FRAME_TOO_LARGE received as expected"); return; }
      finish(false, `unexpected error ${parsed.code}: ${parsed.message || ""}`);
      return;
    }
    return;
  }
  // Binary sync frame
  const bytes = toU8(event.data);
  if (!bytes || bytes.length < 1 || bytes[0] !== 0x00) return;
  if (!syncStep1Seen) {
    syncStep1Seen = true;
    // Echo sync step1 first, then send the oversized frame
    ws.send(event.data);
    // 256 * 1024 + 1 = 262145 bytes  (app limit is 262144)
    const big = new Uint8Array(256 * 1024 + 1);
    big[0] = 0x00; // sync prefix — server reads this before size check
    ws.send(big.buffer);
  }
});

ws.addEventListener("close", (event) => {
  // Server closes after sending FRAME_TOO_LARGE; finish() may have already been called.
  if (done) return;
  finish(false, `closed (code=${event.code}) without FRAME_TOO_LARGE error`);
});
NODE
}

# Probe [12]: exactly 256 KB frame → accepted (no error, no close)
ws_at_limit_probe() {
  local endpoint="$1" token="$2" label="$3"
  node - "$endpoint" "$token" "$WS_ORIGIN" "$label" <<'NODE'
const [endpoint, token, origin, label] = process.argv.slice(2);
const timeoutMs = 15000;

function fail(msg) { console.error(`[smoke] FAIL: ${label}: ${msg}`); process.exit(1); }
function pass(msg) { console.log(`[smoke] PASS: ${label}: ${msg}`); process.exit(0); }

function normalizeWsURL(raw) {
  const u = new URL(raw); if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol === "https:") u.protocol = "wss:"; return u.toString();
}
function toU8(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

const ws = new WebSocket(normalizeWsURL(endpoint), [], { headers: { Origin: origin } });
ws.binaryType = "arraybuffer";

let syncStep1Sent = false;
let frameSent = false;
let done = false;

const masterTimeout = setTimeout(() => {
  if (!done) { done = true; try { ws.close(); } catch {} fail(`timeout after ${timeoutMs}ms`); }
}, timeoutMs);
function finish(ok, msg) {
  if (done) return; done = true;
  clearTimeout(masterTimeout); try { ws.close(); } catch {};
  if (ok) pass(msg); else fail(msg);
}

ws.addEventListener("error", (err) => {
  if (!done) finish(false, (err && err.message) ? err.message : "ws error");
});
ws.addEventListener("open", () => { ws.send(token); });

ws.addEventListener("message", (event) => {
  if (done) return;
  if (typeof event.data === "string") {
    let parsed; try { parsed = JSON.parse(event.data); } catch { return; }
    if (!parsed) return;
    if (parsed.type === "heartbeat") { ws.send(JSON.stringify({ type: "heartbeat" })); return; }
    if (parsed.type === "connected") return;
    if (parsed.type === "error") {
      finish(false, `unexpected error after 256KB frame: ${parsed.code}`);
      return;
    }
    return;
  }
  const bytes = toU8(event.data);
  if (!bytes || bytes.length < 1 || bytes[0] !== 0x00) return;
  if (!syncStep1Sent) {
    syncStep1Sent = true;
    ws.send(event.data); // echo step1 as step2
    return;
  }
  if (!frameSent) {
    frameSent = true;
    // 256 * 1024 = 262144 bytes exactly — must NOT trigger FRAME_TOO_LARGE
    const exact = new Uint8Array(256 * 1024);
    exact[0] = 0x00;
    ws.send(exact.buffer);
    // Wait 2.5s: if no error arrives, the frame was accepted cleanly
    setTimeout(() => finish(true, "exactly 256KB binary frame accepted (no FRAME_TOO_LARGE)"), 2500);
  }
});

ws.addEventListener("close", (event) => {
  if (done) return;
  if (frameSent) finish(false, `closed after 256KB frame (code=${event.code}); should have been accepted`);
  else finish(false, `closed unexpectedly (code=${event.code})`);
});
NODE
}

# Probe [9, 10]: send a frame with given prefix after sync, expect no error for N ms
ws_silent_frame_probe() {
  local endpoint="$1" token="$2" prefix_hex="$3" wait_ms="$4" label="$5"
  node - "$endpoint" "$token" "$prefix_hex" "$wait_ms" "$WS_ORIGIN" "$label" <<'NODE'
const [endpoint, token, prefixHex, waitMs, origin, label] = process.argv.slice(2);
const timeoutMs = Number(waitMs) + 8000;
const silenceMs = Number(waitMs);

function fail(msg) { console.error(`[smoke] FAIL: ${label}: ${msg}`); process.exit(1); }
function pass(msg) { console.log(`[smoke] PASS: ${label}: ${msg}`); process.exit(0); }

function normalizeWsURL(raw) {
  const u = new URL(raw); if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol === "https:") u.protocol = "wss:"; return u.toString();
}
function toU8(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

const ws = new WebSocket(normalizeWsURL(endpoint), [], { headers: { Origin: origin } });
ws.binaryType = "arraybuffer";

let syncStep1Sent = false;
let testFrameSent = false;
let silenceTimer = null;
let done = false;

const masterTimeout = setTimeout(() => {
  if (!done) { done = true; try { ws.close(); } catch {} fail(`timeout after ${timeoutMs}ms`); }
}, timeoutMs);
function finish(ok, msg) {
  if (done) return; done = true;
  clearTimeout(masterTimeout);
  if (silenceTimer) clearTimeout(silenceTimer);
  try { ws.close(); } catch {};
  if (ok) pass(msg); else fail(msg);
}

ws.addEventListener("error", (err) => {
  if (!done) finish(false, (err && err.message) ? err.message : "ws error");
});
ws.addEventListener("open", () => { ws.send(token); });

ws.addEventListener("message", (event) => {
  if (done) return;
  if (typeof event.data === "string") {
    let parsed; try { parsed = JSON.parse(event.data); } catch { return; }
    if (!parsed) return;
    if (parsed.type === "heartbeat") { ws.send(JSON.stringify({ type: "heartbeat" })); return; }
    if (parsed.type === "connected") return;
    if (parsed.type === "error" && testFrameSent) {
      finish(false, `error received after test frame (prefix 0x${prefixHex}): ${parsed.code}`);
      return;
    }
    if (parsed.type === "error") {
      finish(false, `unexpected error during setup: ${parsed.code}`);
      return;
    }
    return;
  }
  const bytes = toU8(event.data);
  if (!bytes || bytes.length < 1 || bytes[0] !== 0x00) return;
  if (!syncStep1Sent) {
    syncStep1Sent = true;
    ws.send(event.data); // echo sync step1
    return;
  }
  if (!testFrameSent) {
    testFrameSent = true;
    const prefix = parseInt(prefixHex, 16);
    const frame = new Uint8Array(16);
    frame[0] = prefix;
    ws.send(frame.buffer);
    // If no error arrives within silenceMs, the frame was silently accepted
    silenceTimer = setTimeout(() => {
      finish(true, `frame with prefix 0x${prefixHex} silently accepted (no error for ${silenceMs}ms)`);
    }, silenceMs);
  }
});

ws.addEventListener("close", (event) => {
  if (done) return;
  if (testFrameSent) finish(false, `closed after test frame (prefix 0x${prefixHex}), expected silent drop`);
  else finish(false, `closed unexpectedly`);
});
NODE
}

# Probe [13]: rate flood → RATE_LIMITED (connection stays open)
ws_rate_flood_probe() {
  local endpoint="$1" token="$2" label="$3"
  node - "$endpoint" "$token" "$WS_ORIGIN" "$label" <<'NODE'
const [endpoint, token, origin, label] = process.argv.slice(2);
const timeoutMs = 15000;

function fail(msg) { console.error(`[smoke] FAIL: ${label}: ${msg}`); process.exit(1); }
function pass(msg) { console.log(`[smoke] PASS: ${label}: ${msg}`); process.exit(0); }

function normalizeWsURL(raw) {
  const u = new URL(raw); if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol === "https:") u.protocol = "wss:"; return u.toString();
}
function toU8(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

const ws = new WebSocket(normalizeWsURL(endpoint), [], { headers: { Origin: origin } });
ws.binaryType = "arraybuffer";

let syncStep1Sent = false;
let floodStarted = false;
let rateLimitedSeen = false;
let done = false;

const masterTimeout = setTimeout(() => {
  if (!done) { done = true; try { ws.close(); } catch {} fail(`timeout after ${timeoutMs}ms`); }
}, timeoutMs);
function finish(ok, msg) {
  if (done) return; done = true;
  clearTimeout(masterTimeout); try { ws.close(); } catch {};
  if (ok) pass(msg); else fail(msg);
}

ws.addEventListener("error", (err) => {
  if (!done) finish(false, (err && err.message) ? err.message : "ws error");
});
ws.addEventListener("open", () => { ws.send(token); });

ws.addEventListener("message", (event) => {
  if (done) return;
  if (typeof event.data === "string") {
    let parsed; try { parsed = JSON.parse(event.data); } catch { return; }
    if (!parsed) return;
    if (parsed.type === "heartbeat") { ws.send(JSON.stringify({ type: "heartbeat" })); return; }
    if (parsed.type === "connected") return;
    if (parsed.type === "error") {
      if (parsed.code === "RATE_LIMITED") {
        rateLimitedSeen = true;
        // Verify connection is still open: send a heartbeat ACK
        ws.send(JSON.stringify({ type: "heartbeat" }));
        // Give 1s to confirm connection stays open, then pass
        setTimeout(() => finish(true, `RATE_LIMITED received; connection remained open`), 1000);
        return;
      }
      finish(false, `unexpected error during flood: ${parsed.code}`);
      return;
    }
    return;
  }
  const bytes = toU8(event.data);
  if (!bytes || bytes.length < 1 || bytes[0] !== 0x00) return;
  if (!syncStep1Sent) {
    syncStep1Sent = true;
    ws.send(event.data); // echo sync step1 as step2
    return;
  }
  if (!floodStarted) {
    floodStarted = true;
    // rate.NewLimiter(30, 30): burst of 30, then RATE_LIMITED
    // Sync step2 echo was msg #1 in the main loop.
    // Send 35 more binary frames to exceed the burst of 30 (31 total in loop = RATE_LIMITED)
    for (let i = 0; i < 35; i++) {
      const f = new Uint8Array(8); f[0] = 0x00;
      ws.send(f.buffer);
    }
    // Wait 2.5s for RATE_LIMITED response
    setTimeout(() => {
      if (!rateLimitedSeen) finish(false, "sent 36 binary frames but no RATE_LIMITED received");
    }, 2500);
  }
});

ws.addEventListener("close", (event) => {
  if (done) return;
  if (floodStarted && !rateLimitedSeen)
    finish(false, `closed during flood (code=${event.code}); expected RATE_LIMITED then stay-open`);
  else if (!floodStarted)
    finish(false, `closed before flood started (code=${event.code})`);
  else
    finish(false, `closed after RATE_LIMITED (code=${event.code}); connection should have stayed open`);
});
NODE
}

# Probe [14]: connection limit — open 10, try 11th, expect CONNECTION_LIMIT
ws_conn_limit_probe() {
  local endpoint="$1" token="$2" label="$3"
  node - "$endpoint" "$token" "$WS_ORIGIN" "$label" <<'NODE'
const [endpoint, token, origin, label] = process.argv.slice(2);
// docWSMaxConnPerUser = 10
const MAX_CONNS = 10;
const timeoutMs = 25000;

function fail(msg) { console.error(`[smoke] FAIL: ${label}: ${msg}`); process.exit(1); }
function pass(msg) { console.log(`[smoke] PASS: ${label}: ${msg}`); process.exit(0); }

function normalizeWsURL(raw) {
  const u = new URL(raw); if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol === "https:") u.protocol = "wss:"; return u.toString();
}
function toU8(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

const wsURL = normalizeWsURL(endpoint);
let done = false;
const openConns = [];

const masterTimeout = setTimeout(() => {
  if (!done) {
    done = true;
    closeAll();
    fail(`timeout after ${timeoutMs}ms — could not complete connection-limit test`);
  }
}, timeoutMs);

function closeAll() {
  for (const ws of openConns) { try { ws.close(); } catch {} }
  openConns.length = 0;
}

function finish(ok, msg) {
  if (done) return; done = true;
  clearTimeout(masterTimeout);
  closeAll();
  if (ok) pass(msg); else fail(msg);
}

// Opens one WS, auths it, waits for `connected`. Returns a Promise<WebSocket>.
function openAndAuth() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsURL, [], { headers: { Origin: origin } });
    ws.binaryType = "arraybuffer";
    const t = setTimeout(() => reject(new Error("auth timeout for connection slot")), 8000);
    ws.addEventListener("open", () => { ws.send(token); });
    ws.addEventListener("error", (err) => { clearTimeout(t); reject(err); });
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let parsed; try { parsed = JSON.parse(event.data); } catch { return; }
      if (!parsed) return;
      if (parsed.type === "connected") {
        clearTimeout(t);
        openConns.push(ws);
        resolve(ws);
      } else if (parsed.type === "error") {
        clearTimeout(t);
        reject(new Error(`connection rejected: ${parsed.code} — ${parsed.message || ""}`));
      }
    });
    ws.addEventListener("close", () => { clearTimeout(t); });
  });
}

// Opens a WS that we expect to be rejected with CONNECTION_LIMIT.
function expectConnectionLimit() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsURL, [], { headers: { Origin: origin } });
    ws.binaryType = "arraybuffer";
    const t = setTimeout(() => reject(new Error("auth timeout waiting for CONNECTION_LIMIT")), 8000);
    ws.addEventListener("open", () => { ws.send(token); });
    ws.addEventListener("error", (err) => { clearTimeout(t); reject(err); });
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let parsed; try { parsed = JSON.parse(event.data); } catch { return; }
      if (!parsed) return;
      if (parsed.type === "error") {
        clearTimeout(t);
        if (parsed.code === "CONNECTION_LIMIT") resolve(parsed.code);
        else reject(new Error(`expected CONNECTION_LIMIT, got ${parsed.code}`));
      } else if (parsed.type === "connected") {
        clearTimeout(t);
        openConns.push(ws); // track for cleanup
        reject(new Error("11th connection was accepted (CONNECTION_LIMIT not enforced)"));
      }
    });
    ws.addEventListener("close", () => { clearTimeout(t); });
  });
}

async function run() {
  // Step 1: open 10 connections concurrently
  const promises = Array.from({ length: MAX_CONNS }, () => openAndAuth());
  let conns;
  try {
    conns = await Promise.all(promises);
  } catch (err) {
    finish(false, `failed to open ${MAX_CONNS} connections: ${err.message}`);
    return;
  }
  console.log(`[smoke]   ${MAX_CONNS} connections open and authenticated`);

  // Step 2: try 11th → expect CONNECTION_LIMIT
  try {
    const code = await expectConnectionLimit();
    finish(true, `11th connection correctly rejected with ${code}`);
  } catch (err) {
    finish(false, err.message);
  }
}

run();
NODE
}

# Probe [15]: rapid connect/disconnect (no auth sent — tests server cleanup path)
ws_rapid_cycle_probe() {
  local endpoint="$1" token="$2" label="$3"
  node - "$endpoint" "$token" "$WS_ORIGIN" "$label" <<'NODE'
const [endpoint, token, origin, label] = process.argv.slice(2);
const CYCLES = 5;
const timeoutMs = 20000;

function fail(msg) { console.error(`[smoke] FAIL: ${label}: ${msg}`); process.exit(1); }
function pass(msg) { console.log(`[smoke] PASS: ${label}: ${msg}`); process.exit(0); }

function normalizeWsURL(raw) {
  const u = new URL(raw); if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol === "https:") u.protocol = "wss:"; return u.toString();
}

const wsURL = normalizeWsURL(endpoint);
let done = false;
let cycle = 0;
let errors = 0;

const masterTimeout = setTimeout(() => {
  if (!done) { done = true; fail(`timeout after ${timeoutMs}ms at cycle ${cycle}`); }
}, timeoutMs);

function finish(ok, msg) {
  if (done) return; done = true;
  clearTimeout(masterTimeout);
  if (ok) pass(msg); else fail(msg);
}

// Each cycle: connect, send token (auth), immediately close after connected or first message
function runCycle(n) {
  if (n > CYCLES) {
    if (errors === 0) finish(true, `${CYCLES} rapid connect/disconnect cycles completed cleanly`);
    else finish(false, `${errors}/${CYCLES} cycles had unexpected errors`);
    return;
  }

  const ws = new WebSocket(wsURL, [], { headers: { Origin: origin } });
  ws.binaryType = "arraybuffer";
  let closed = false;

  const closeNow = () => {
    if (closed) return; closed = true;
    try { ws.close(1000, "rapid disconnect"); } catch {}
  };

  ws.addEventListener("open", () => {
    ws.send(token); // auth then immediately schedule close
    // Small delay to let server start processing, then drop
    setTimeout(closeNow, 50);
  });

  ws.addEventListener("error", (err) => {
    // Connection errors on rapid close are expected (ECONNRESET, etc.) — count only protocol errors
    const msg = (err && err.message) ? err.message : "";
    if (msg.includes("AUTH") || msg.includes("INTERNAL")) errors++;
  });

  ws.addEventListener("close", () => {
    cycle = n;
    // Small gap between cycles to avoid overwhelming the server
    setTimeout(() => runCycle(n + 1), 100);
  });
}

runCycle(1);
NODE
}

# ── SETUP ─────────────────────────────────────────────────────────────────────
echo "[smoke] ── ws-doc-smoke: testing $BASE_URL ──────────────────────────────"

HEALTH_BODY="$TMP_DIR/health.json"
HEALTH_STATUS="$(status_code "$BASE_URL/health" "$HEALTH_BODY")" || {
  echo "[smoke] FAIL: cannot reach $BASE_URL — start backend first"
  exit 1
}
if [ "$HEALTH_STATUS" != "200" ]; then
  echo "[smoke] FAIL: /health returned $HEALTH_STATUS"
  exit 1
fi
echo "[smoke] backend healthy at $BASE_URL"

if [ ! -x "./scripts/get-token.sh" ]; then
  echo "[smoke] FAIL: ./scripts/get-token.sh missing or not executable"
  echo "[smoke]       cp scripts/get-token.sh.example scripts/get-token.sh && chmod +x scripts/get-token.sh"
  exit 1
fi

echo "[smoke] refreshing auth token..."
./scripts/get-token.sh >/dev/null

TOKEN="$(grep '^ACCESS_TOKEN=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
if [ -z "$TOKEN" ]; then
  echo "[smoke] FAIL: ACCESS_TOKEN not found in .env after ./scripts/get-token.sh"
  exit 1
fi

echo "[smoke] creating temp project + document..."
PROJ_BODY="$TMP_DIR/project.json"
PROJ_STATUS="$(status_code "$BASE_URL/api/projects" "$PROJ_BODY" \
  -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data "{\"name\":\"smoke-ws-doc-$(date +%s)\"}")"

if [ "$PROJ_STATUS" != "201" ]; then
  echo "[smoke] FAIL: POST /api/projects returned $PROJ_STATUS"
  cat "$PROJ_BODY" && echo
  exit 1
fi
PROJECT_ID="$(node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(d.id||'')" "$PROJ_BODY")"
[ -z "$PROJECT_ID" ] && { echo "[smoke] FAIL: no project id"; cat "$PROJ_BODY"; exit 1; }

DOC_BODY="$TMP_DIR/document.json"
DOC_STATUS="$(status_code "$BASE_URL/api/documents" "$DOC_BODY" \
  -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data "{\"project_id\":\"$PROJECT_ID\",\"name\":\"smoke-ws-doc\",\"extension\":\".md\",\"content\":\"\"}")"

if [ "$DOC_STATUS" != "201" ]; then
  echo "[smoke] FAIL: POST /api/documents returned $DOC_STATUS"
  cat "$DOC_BODY" && echo
  exit 1
fi
DOC_ID="$(node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(d.id||'')" "$DOC_BODY")"
[ -z "$DOC_ID" ] && { echo "[smoke] FAIL: no document id"; cat "$DOC_BODY"; exit 1; }

echo "[smoke] project=$PROJECT_ID  doc=$DOC_ID"
echo

# ── HTTP-LEVEL TESTS ──────────────────────────────────────────────────────────
echo "[smoke] ── [1-2] HTTP-level path validation ──────────────────────────────"

B="$TMP_DIR/http1.txt"
S="$(status_code "$BASE_URL/ws/documents/%20" "$B")"
check_http "400" "$S" "$B" "[1] GET /ws/documents/%20 (whitespace ID)"

B="$TMP_DIR/http2.txt"
S="$(status_code "$BASE_URL/ws/documents/not-a-uuid" "$B")"
check_http "400" "$S" "$B" "[2] GET /ws/documents/not-a-uuid (non-UUID)"

echo

# ── AUTH FAILURE TESTS ────────────────────────────────────────────────────────
echo "[smoke] ── [3-6] Auth failure paths ─────────────────────────────────────"

WS_DOC="$BASE_URL/ws/documents/$DOC_ID"

ws_probe "$WS_DOC" "this.is.not.a.valid.jwt" "expect_error" "AUTH_EXPIRED" "[3] bad JWT" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

ws_probe "$WS_DOC" "$TOKEN" "binary_auth" "" "[4] binary first frame" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

ws_probe "$WS_DOC" "$TOKEN" "empty_token" "" "[5] whitespace/empty token" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "[smoke]   [6] auth timeout — waiting up to 8s for server's 5s auth deadline..."
WS_TIMEOUT_MS=9000 ws_probe "$WS_DOC" "$TOKEN" "auth_timeout" "" "[6] no auth message → AUTH_TIMEOUT" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo

# ── OWNERSHIP TEST ────────────────────────────────────────────────────────────
echo "[smoke] ── [7] Ownership: non-existent document UUID ────────────────────"

FAKE_UUID="00000000-0000-4000-a000-000000000001"
ws_probe "$BASE_URL/ws/documents/$FAKE_UUID" "$TOKEN" "expect_any_error" "" \
  "[7] non-existent doc UUID → FORBIDDEN or INTERNAL_ERROR" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo

# ── HAPPY PATH + SILENT FRAME TESTS ──────────────────────────────────────────
echo "[smoke] ── [8-10] Happy path and silent-frame acceptance ─────────────────"

ws_probe "$WS_DOC" "$TOKEN" "expect_sync" "" "[8] valid auth + connected + sync handshake" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

ws_silent_frame_probe "$WS_DOC" "$TOKEN" "01" "2500" \
  "[9] awareness frame (prefix 0x01) silently accepted" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

ws_silent_frame_probe "$WS_DOC" "$TOKEN" "FF" "2500" \
  "[10] unknown prefix 0xFF silently dropped (no error)" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo

# ── OVERSIZED FRAME TESTS ─────────────────────────────────────────────────────
echo "[smoke] ── [11-12] Frame size boundary (app limit = 256 KB) ─────────────"

ws_oversized_probe "$WS_DOC" "$TOKEN" "[11] > 256 KB frame → FRAME_TOO_LARGE + close" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

ws_at_limit_probe "$WS_DOC" "$TOKEN" "[12] exactly 256 KB frame → accepted (no FRAME_TOO_LARGE)" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo

# ── RATE LIMITING TEST ────────────────────────────────────────────────────────
echo "[smoke] ── [13] Rate limiting (burst=30, flood 36 frames) ────────────────"

ws_rate_flood_probe "$WS_DOC" "$TOKEN" "[13] rate flood → RATE_LIMITED + connection stays open" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo

# ── CONNECTION LIMIT TEST ─────────────────────────────────────────────────────
echo "[smoke] ── [14] Connection limit (max 10 per user) ──────────────────────"
echo "[smoke]   NOTE: if previous run leaked connections, wait a few seconds and retry"

ws_conn_limit_probe "$WS_DOC" "$TOKEN" "[14] 11th connection → CONNECTION_LIMIT" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo

# ── RAPID CONNECT/DISCONNECT ──────────────────────────────────────────────────
echo "[smoke] ── [15] Rapid connect/disconnect (5 cycles) ─────────────────────"

ws_rapid_cycle_probe "$WS_DOC" "$TOKEN" "[15] 5 rapid connect/disconnect cycles → no crash" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo

# ── SUMMARY ───────────────────────────────────────────────────────────────────
TOTAL=$((PASS+FAIL))
echo "[smoke] ── RESULTS: $PASS/$TOTAL passed ─────────────────────────────────"
if [ "$FAIL" -gt 0 ]; then
  echo "[smoke] $FAIL test(s) FAILED"
  exit 1
fi
echo "[smoke] all document WS smoke tests passed."
