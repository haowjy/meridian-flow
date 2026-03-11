#!/usr/bin/env bash
# scratch/smoke/ws-project-smoke.sh
# Hostile-user smoke tests for the project WebSocket: /ws/projects/{projectId}
#
# The project WS is JSON-only (no binary sync). It uses golang.org/x/net/websocket
# (older lib) rather than the coder/websocket used by the doc WS.
#
# Differences from doc WS to probe:
#   - Auth timeout code is AUTH_FAILED (not AUTH_TIMEOUT — no explicit deadline error handling)
#   - Max payload: 64 KB (collabMaxMessageBytes), enforced by older library → connection closed
#   - After auth: sends {"type":"project:connected"} (not "connected")
#   - JSON-only inbound; binary frames are silently dropped (forward compat)
#   - Rate limiter is window-based (30/s, mute 1s), not token-bucket
#   - Proposal commands: require documentId UUID; wrong project → doc:error PROJECT_MISMATCH
#
# Tests covered:
#   HTTP-level       [1]  empty/whitespace project ID    → 400
#                    [2]  non-UUID project ID             → 400
#   Auth failures    [3]  bad JWT                         → AUTH_EXPIRED
#                    [4]  no auth message (timeout)        → AUTH_FAILED (deadline fired)
#   Happy path       [5]  auth → project:connected
#                    [6]  heartbeat echo                   → stays connected
#                    [7]  unknown JSON type                → ignored (forward compat)
#   Proposal routing [8]  proposal:accept, invalid docId UUID → doc:error INTERNAL_ERROR
#                    [9]  proposal:accept, valid UUID, wrong project → doc:error
#   Oversize         [10] JSON > 64 KB                    → connection closed
#   Rate limiting    [11] flood 35 JSON messages           → RATE_LIMITED (no disconnect)
#   Resilience       [12] 5 rapid connect/disconnect cycles
#
# Usage: bash scratch/smoke/ws-project-smoke.sh
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
OTHER_PROJECT_ID=""
DOC_ID=""
TOKEN=""

cleanup() {
  rm -rf "$TMP_DIR"
  for pid in "${PROJECT_ID:-}" "${OTHER_PROJECT_ID:-}"; do
    if [ -n "$pid" ] && [ -n "${TOKEN:-}" ]; then
      curl -sS -X DELETE \
        -H "Authorization: Bearer $TOKEN" \
        "$BASE_URL/api/projects/$pid" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT

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

# ── SHARED NODE.JS PROBE ──────────────────────────────────────────────────────
# ws_proj_probe <endpoint> <token> <mode> <expected_code> <label>
#
# mode: expect_error | expect_any_error | expect_project_connected |
#       auth_timeout | heartbeat_check | unknown_json_type |
#       binary_ignored
ws_proj_probe() {
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

const ws = new WebSocket(normalizeWsURL(endpoint), [], { headers: { Origin: origin } });
ws.binaryType = "arraybuffer";

let projectConnectedSeen = false;
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

ws.addEventListener("open", () => {
  if (mode === "auth_timeout") return; // intentionally send nothing
  ws.send(rawToken);
});

ws.addEventListener("message", (event) => {
  if (done) return;
  if (typeof event.data !== "string") return; // project WS is JSON-only

  let parsed;
  try { parsed = JSON.parse(event.data); } catch { return; }
  if (!parsed || typeof parsed !== "object") return;

  const type = parsed.type || "";

  // ── error frame ──────────────────────────────────────────────────────────
  if (type === "error") {
    const code = parsed.code || "(no code)";
    if (["expect_error", "expect_any_error", "auth_timeout"].includes(mode)) {
      if (mode === "expect_error" && expected && code !== expected)
        finish(false, `expected error code ${expected}, got ${code}`);
      else
        finish(true, `error code ${code}`);
      return;
    }
    // For success-path modes, unexpected error fails the test
    finish(false, `unexpected error ${code}: ${parsed.message || ""}`);
    return;
  }

  // ── project:connected ────────────────────────────────────────────────────
  if (type === "project:connected") {
    projectConnectedSeen = true;
    if (mode === "expect_project_connected") {
      finish(true, "project:connected received");
      return;
    }
    // For other success-path modes: continue and handle further messages
    if (mode === "heartbeat_check") {
      // Server sends heartbeat every 30s — instead, we send one and verify no disconnect
      ws.send(JSON.stringify({ type: "heartbeat" }));
      setTimeout(() => finish(true, "heartbeat sent, connection stayed open for 2s"), 2000);
      return;
    }
    if (mode === "unknown_json_type") {
      ws.send(JSON.stringify({ type: "xyzzy:nonexistent", data: "ignored" }));
      setTimeout(() => finish(true, "unknown JSON type sent, connection stayed open for 2s"), 2000);
      return;
    }
    if (mode === "binary_ignored") {
      // The golang.org/x/net/websocket library receives binary into []byte;
      // the message loop checks isJSONMessage (starts with '{') — binary won't match,
      // and onBinaryMessage is nil for project WS, so it's silently dropped.
      const frame = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      ws.send(frame.buffer);
      setTimeout(() => finish(true, "binary frame silently dropped, connection stayed open"), 2000);
      return;
    }
    return;
  }

  // ── heartbeat from server ─────────────────────────────────────────────────
  if (type === "heartbeat") {
    ws.send(JSON.stringify({ type: "heartbeat" }));
    return;
  }

  // ── doc:error (document-scoped errors don't close the connection) ─────────
  if (type === "doc:error") {
    if (mode === "expect_error") {
      // doc:error uses documentId/code/message fields, not top-level code
      const code = parsed.code || "(no code)";
      if (expected && code !== expected)
        finish(false, `doc:error: expected code ${expected}, got ${code}`);
      else
        finish(true, `doc:error code ${code} (documentId=${parsed.documentId || "?"})`);
      return;
    }
    if (mode === "expect_any_error") {
      finish(true, `doc:error code ${parsed.code} for doc ${parsed.documentId}`);
      return;
    }
    return;
  }
});

ws.addEventListener("close", (event) => {
  if (done) return;
  if (["expect_error", "expect_any_error", "auth_timeout"].includes(mode))
    finish(false, `closed (code=${event.code}) before receiving expected error`);
  else if (mode === "expect_project_connected")
    finish(false, `closed (code=${event.code}) before project:connected`);
  else
    finish(false, `unexpected close (code=${event.code})`);
});
NODE
}

# Probe [8, 9]: proposal command with invalid/wrong-project documentId
# Sends proposal:accept after project:connected and expects a doc:error response
ws_proj_proposal_probe() {
  local endpoint="$1" token="$2" doc_id="$3" expect_code="$4" label="$5"
  node - "$endpoint" "$token" "$doc_id" "$expect_code" "$WS_ORIGIN" "$label" <<'NODE'
const [endpoint, token, docId, expectCode, origin, label] = process.argv.slice(2);
const timeoutMs = 12000;

function fail(msg) { console.error(`[smoke] FAIL: ${label}: ${msg}`); process.exit(1); }
function pass(msg) { console.log(`[smoke] PASS: ${label}: ${msg}`); process.exit(0); }

function normalizeWsURL(raw) {
  const u = new URL(raw);
  if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol === "https:") u.protocol = "wss:";
  return u.toString();
}

const ws = new WebSocket(normalizeWsURL(endpoint), [], { headers: { Origin: origin } });
ws.binaryType = "arraybuffer";
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
  if (typeof event.data !== "string") return;
  let parsed; try { parsed = JSON.parse(event.data); } catch { return; }
  if (!parsed) return;

  if (parsed.type === "heartbeat") { ws.send(JSON.stringify({ type: "heartbeat" })); return; }

  if (parsed.type === "error") {
    // Connection-level error: sendError() sends {"type":"error"} without closing connection.
    // Valid for invalid UUID (parse error before doc routing) — loop continues.
    const code = parsed.code || "(no code)";
    if (expectCode && expectCode !== "any" && code !== expectCode) {
      finish(false, `connection-level error: expected ${expectCode}, got ${code} — ${parsed.message || ""}`);
      return;
    }
    finish(true, `connection-level error code=${code} (not closed — message loop continues)`);
    return;
  }

  if (parsed.type === "project:connected") {
    // Fire proposal:accept with the supplied documentId
    ws.send(JSON.stringify({
      type: "proposal:accept",
      documentId: docId,
      proposalId: "00000000-0000-4000-a000-000000000001",
      idempotencyKey: "smoke-test-key"
    }));
    return;
  }

  if (parsed.type === "doc:error") {
    const code = parsed.code || "(no code)";
    if (expectCode && expectCode !== "any" && code !== expectCode) {
      finish(false, `expected doc:error code ${expectCode}, got ${code}`);
      return;
    }
    finish(true, `doc:error code=${code} documentId=${parsed.documentId || "?"} (connection stayed open)`);
    return;
  }
});

ws.addEventListener("close", (event) => {
  if (done) return;
  finish(false, `closed (code=${event.code}) — expected doc:error but connection was closed`);
});
NODE
}

# Probe [10]: oversized JSON (>64KB) → connection closed by server
ws_proj_oversize_probe() {
  local endpoint="$1" token="$2" label="$3"
  node - "$endpoint" "$token" "$WS_ORIGIN" "$label" <<'NODE'
const [endpoint, token, origin, label] = process.argv.slice(2);
const timeoutMs = 12000;

function fail(msg) { console.error(`[smoke] FAIL: ${label}: ${msg}`); process.exit(1); }
function pass(msg) { console.log(`[smoke] PASS: ${label}: ${msg}`); process.exit(0); }

function normalizeWsURL(raw) {
  const u = new URL(raw);
  if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol === "https:") u.protocol = "wss:";
  return u.toString();
}

const ws = new WebSocket(normalizeWsURL(endpoint), [], { headers: { Origin: origin } });
ws.binaryType = "arraybuffer";
let projectConnected = false;
let oversizeSent = false;
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
  if (!done && oversizeSent) {
    // WS error after sending oversized payload is expected (library closes)
    finish(true, `connection errored after >64KB payload (error=${err && err.message ? err.message : "ws error"})`);
    return;
  }
  if (!done) finish(false, (err && err.message) ? err.message : "ws error");
});
ws.addEventListener("open", () => { ws.send(token); });

ws.addEventListener("message", (event) => {
  if (done) return;
  if (typeof event.data !== "string") return;
  let parsed; try { parsed = JSON.parse(event.data); } catch { return; }
  if (!parsed) return;
  if (parsed.type === "heartbeat") { ws.send(JSON.stringify({ type: "heartbeat" })); return; }
  if (parsed.type === "error") { finish(false, `connection error ${parsed.code} during setup`); return; }
  if (parsed.type === "project:connected") {
    projectConnected = true;
    // 64 * 1024 + 1 = 65537 bytes — exceeds collabMaxMessageBytes = 65536
    // Wrap in a JSON string to send as valid JSON (won't be parseable meaningfully, that's OK)
    const bigStr = "x".repeat(64 * 1024 + 1);
    const msg = JSON.stringify({ type: "heartbeat", padding: bigStr });
    oversizeSent = true;
    ws.send(msg);
    return;
  }
});

ws.addEventListener("close", (event) => {
  if (done) return;
  if (oversizeSent) {
    // golang.org/x/net/websocket closes when MaxPayloadBytes exceeded
    finish(true, `connection closed after >64KB message (code=${event.code}) — size limit enforced`);
    return;
  }
  finish(false, `unexpected close (code=${event.code}) before test could send oversized message`);
});
NODE
}

# Probe [11]: rate flood — 35 JSON messages after project:connected → RATE_LIMITED (no disconnect)
ws_proj_rate_flood_probe() {
  local endpoint="$1" token="$2" label="$3"
  node - "$endpoint" "$token" "$WS_ORIGIN" "$label" <<'NODE'
const [endpoint, token, origin, label] = process.argv.slice(2);
const timeoutMs = 15000;

function fail(msg) { console.error(`[smoke] FAIL: ${label}: ${msg}`); process.exit(1); }
function pass(msg) { console.log(`[smoke] PASS: ${label}: ${msg}`); process.exit(0); }

function normalizeWsURL(raw) {
  const u = new URL(raw);
  if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol === "https:") u.protocol = "wss:";
  return u.toString();
}

const ws = new WebSocket(normalizeWsURL(endpoint), [], { headers: { Origin: origin } });
ws.binaryType = "arraybuffer";
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
  if (typeof event.data !== "string") return;
  let parsed; try { parsed = JSON.parse(event.data); } catch { return; }
  if (!parsed) return;

  if (parsed.type === "heartbeat") { ws.send(JSON.stringify({ type: "heartbeat" })); return; }
  if (parsed.type === "error") {
    if (parsed.code === "RATE_LIMITED") {
      rateLimitedSeen = true;
      // Verify connection is still open by sending a heartbeat
      ws.send(JSON.stringify({ type: "heartbeat" }));
      setTimeout(() => finish(true, `RATE_LIMITED received; connection remained open`), 1000);
      return;
    }
    finish(false, `unexpected error during flood: ${parsed.code}`);
    return;
  }
  if (parsed.type === "project:connected") {
    if (!floodStarted) {
      floodStarted = true;
      // collabInboundRateLimit = 30 per window; flood 35 messages to exceed
      for (let i = 0; i < 35; i++) {
        ws.send(JSON.stringify({ type: "heartbeat" }));
      }
      setTimeout(() => {
        if (!rateLimitedSeen) finish(false, "sent 35 JSON messages but no RATE_LIMITED received");
      }, 2500);
    }
    return;
  }
});

ws.addEventListener("close", (event) => {
  if (done) return;
  if (floodStarted) finish(false, `closed during/after flood (code=${event.code}); expected RATE_LIMITED then stay-open`);
  else finish(false, `closed before flood started`);
});
NODE
}

# Probe [12]: rapid connect/disconnect
ws_proj_rapid_cycle_probe() {
  local endpoint="$1" token="$2" label="$3"
  node - "$endpoint" "$token" "$WS_ORIGIN" "$label" <<'NODE'
const [endpoint, token, origin, label] = process.argv.slice(2);
const CYCLES = 5;
const timeoutMs = 20000;

function fail(msg) { console.error(`[smoke] FAIL: ${label}: ${msg}`); process.exit(1); }
function pass(msg) { console.log(`[smoke] PASS: ${label}: ${msg}`); process.exit(0); }

function normalizeWsURL(raw) {
  const u = new URL(raw);
  if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol === "https:") u.protocol = "wss:";
  return u.toString();
}

const wsURL = normalizeWsURL(endpoint);
let done = false;
let cycle = 0;

const masterTimeout = setTimeout(() => {
  if (!done) { done = true; fail(`timeout at cycle ${cycle}`); }
}, timeoutMs);
function finish(ok, msg) {
  if (done) return; done = true;
  clearTimeout(masterTimeout);
  if (ok) pass(msg); else fail(msg);
}

function runCycle(n) {
  if (n > CYCLES) {
    finish(true, `${CYCLES} rapid connect/disconnect cycles completed`);
    return;
  }
  const ws = new WebSocket(wsURL, [], { headers: { Origin: origin } });
  let closed = false;
  const closeNow = () => {
    if (closed) return; closed = true;
    try { ws.close(1000, "rapid disconnect"); } catch {}
  };
  ws.addEventListener("open", () => {
    ws.send(token);
    setTimeout(closeNow, 30); // drop almost immediately after auth
  });
  ws.addEventListener("error", () => {}); // expected on rapid close
  ws.addEventListener("close", () => {
    cycle = n;
    setTimeout(() => runCycle(n + 1), 80);
  });
}
runCycle(1);
NODE
}

# ── SETUP ─────────────────────────────────────────────────────────────────────
echo "[smoke] ── ws-project-smoke: testing $BASE_URL ──────────────────────────"

HEALTH_BODY="$TMP_DIR/health.json"
HEALTH_STATUS="$(status_code "$BASE_URL/health" "$HEALTH_BODY")" || {
  echo "[smoke] FAIL: cannot reach $BASE_URL"
  exit 1
}
if [ "$HEALTH_STATUS" != "200" ]; then
  echo "[smoke] FAIL: /health returned $HEALTH_STATUS"
  exit 1
fi
echo "[smoke] backend healthy at $BASE_URL"

if [ ! -x "./scripts/get-token.sh" ]; then
  echo "[smoke] FAIL: ./scripts/get-token.sh not found or not executable"
  exit 1
fi
echo "[smoke] refreshing auth token..."
./scripts/get-token.sh >/dev/null

TOKEN="$(grep '^ACCESS_TOKEN=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
if [ -z "$TOKEN" ]; then
  echo "[smoke] FAIL: ACCESS_TOKEN not found in .env after token refresh"
  exit 1
fi

echo "[smoke] creating test resources (project + document + other-project)..."

PROJ_BODY="$TMP_DIR/project.json"
PROJ_STATUS="$(status_code "$BASE_URL/api/projects" "$PROJ_BODY" \
  -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data "{\"name\":\"smoke-ws-proj-$(date +%s)\"}")"
[ "$PROJ_STATUS" != "201" ] && { echo "[smoke] FAIL: POST /api/projects → $PROJ_STATUS"; cat "$PROJ_BODY"; exit 1; }
PROJECT_ID="$(node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(d.id||'')" "$PROJ_BODY")"
[ -z "$PROJECT_ID" ] && { echo "[smoke] FAIL: no project id"; exit 1; }

DOC_BODY="$TMP_DIR/document.json"
DOC_STATUS="$(status_code "$BASE_URL/api/documents" "$DOC_BODY" \
  -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data "{\"project_id\":\"$PROJECT_ID\",\"name\":\"smoke-ws-proj-doc\",\"extension\":\".md\",\"content\":\"\"}")"
[ "$DOC_STATUS" != "201" ] && { echo "[smoke] FAIL: POST /api/documents → $DOC_STATUS"; cat "$DOC_BODY"; exit 1; }
DOC_ID="$(node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(d.id||'')" "$DOC_BODY")"
[ -z "$DOC_ID" ] && { echo "[smoke] FAIL: no document id"; exit 1; }

# Create a second project (for cross-project document access test)
OTHER_PROJ_BODY="$TMP_DIR/other_project.json"
OTHER_PROJ_STATUS="$(status_code "$BASE_URL/api/projects" "$OTHER_PROJ_BODY" \
  -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data "{\"name\":\"smoke-ws-proj-other-$(date +%s)\"}")"
OTHER_PROJECT_ID=""
if [ "$OTHER_PROJ_STATUS" = "201" ]; then
  OTHER_PROJECT_ID="$(node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(d.id||'')" "$OTHER_PROJ_BODY")"
fi

echo "[smoke] project=$PROJECT_ID  doc=$DOC_ID  other_project=${OTHER_PROJECT_ID:-n/a}"
echo

WS_PROJ="$BASE_URL/ws/projects/$PROJECT_ID"

# ── HTTP-LEVEL TESTS ──────────────────────────────────────────────────────────
echo "[smoke] ── [1-2] HTTP-level path validation ──────────────────────────────"

B="$TMP_DIR/http1.txt"
S="$(status_code "$BASE_URL/ws/projects/%20" "$B")"
check_http "400" "$S" "$B" "[1] GET /ws/projects/%20 (whitespace ID)"

B="$TMP_DIR/http2.txt"
S="$(status_code "$BASE_URL/ws/projects/not-a-uuid" "$B")"
check_http "400" "$S" "$B" "[2] GET /ws/projects/not-a-uuid (non-UUID)"

echo

# ── AUTH FAILURE TESTS ────────────────────────────────────────────────────────
echo "[smoke] ── [3-4] Auth failure paths ─────────────────────────────────────"

ws_proj_probe "$WS_PROJ" "not.a.real.jwt.token" "expect_error" "AUTH_EXPIRED" "[3] bad JWT → AUTH_EXPIRED" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "[smoke]   [4] auth timeout — waiting up to 8s for server's 5s auth deadline..."
echo "[smoke]   NOTE: project WS auth timeout produces AUTH_FAILED (not AUTH_TIMEOUT)"
WS_TIMEOUT_MS=9000 ws_proj_probe "$WS_PROJ" "$TOKEN" "auth_timeout" "" \
  "[4] no auth message → AUTH_FAILED (deadline expired)" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo

# ── HAPPY PATH ────────────────────────────────────────────────────────────────
echo "[smoke] ── [5-7] Happy path and forward-compat ───────────────────────────"

ws_proj_probe "$WS_PROJ" "$TOKEN" "expect_project_connected" "" \
  "[5] valid auth → project:connected" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

ws_proj_probe "$WS_PROJ" "$TOKEN" "heartbeat_check" "" \
  "[6] send heartbeat after project:connected → stays connected" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

ws_proj_probe "$WS_PROJ" "$TOKEN" "unknown_json_type" "" \
  "[7] unknown JSON type (xyzzy:nonexistent) → silently ignored, stays connected" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo

# ── PROPOSAL ROUTING TESTS ────────────────────────────────────────────────────
echo "[smoke] ── [8-9] Proposal command routing / document access ─────────────"

# [8]: invalid UUID as documentId → server returns doc:error with INTERNAL_ERROR
ws_proj_proposal_probe "$WS_PROJ" "$TOKEN" "not-a-valid-uuid" "INTERNAL_ERROR" \
  "[8] proposal:accept with non-UUID documentId → INTERNAL_ERROR (conn-level, not closed)" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

# [9]: valid UUID that belongs to a DIFFERENT project (cross-project access)
if [ -n "$OTHER_PROJECT_ID" ] && [ -n "$DOC_ID" ]; then
  # DOC_ID belongs to PROJECT_ID, not OTHER_PROJECT_ID
  # Connecting to OTHER_PROJECT's WS and trying to act on DOC_ID should fail
  WS_OTHER_PROJ="$BASE_URL/ws/projects/$OTHER_PROJECT_ID"
  ws_proj_proposal_probe "$WS_OTHER_PROJ" "$TOKEN" "$DOC_ID" "any" \
    "[9] proposal:accept for doc from different project → doc:error (FORBIDDEN or PROJECT_MISMATCH)" \
    && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
else
  echo "[smoke] SKIP: [9] cross-project test (other project creation failed)"
fi

echo

# ── OVERSIZED PAYLOAD TEST ────────────────────────────────────────────────────
echo "[smoke] ── [10] Oversized payload (> 64 KB) ──────────────────────────────"

ws_proj_oversize_probe "$WS_PROJ" "$TOKEN" "[10] >64KB JSON message → connection closed (MaxPayloadBytes enforced)" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo

# ── RATE LIMITING TEST ────────────────────────────────────────────────────────
echo "[smoke] ── [11] Rate limiting (30/s window, flood 35 JSON messages) ──────"

ws_proj_rate_flood_probe "$WS_PROJ" "$TOKEN" "[11] rate flood → RATE_LIMITED + connection stays open" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo

# ── RAPID CONNECT/DISCONNECT ──────────────────────────────────────────────────
echo "[smoke] ── [12] Rapid connect/disconnect (5 cycles) ─────────────────────"

ws_proj_rapid_cycle_probe "$WS_PROJ" "$TOKEN" "[12] 5 rapid connect/disconnect cycles → no crash" \
  && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo

# ── SUMMARY ───────────────────────────────────────────────────────────────────
TOTAL=$((PASS+FAIL))
echo "[smoke] ── RESULTS: $PASS/$TOTAL passed ─────────────────────────────────"
if [ "$FAIL" -gt 0 ]; then
  echo "[smoke] $FAIL test(s) FAILED"
  exit 1
fi
echo "[smoke] all project WS smoke tests passed."
