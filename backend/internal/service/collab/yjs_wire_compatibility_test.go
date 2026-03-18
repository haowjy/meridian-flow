package collab

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	ycrdt "github.com/haowjy/y-crdt"
)

func TestYjsWireCompatibility_JSUpdateDecodesInGo(t *testing.T) {
	repoRoot := requireJSYjs(t)
	proposalID := "11111111-1111-1111-1111-111111111111"

	script := `
const Y = require('./frontend/node_modules/yjs');
const doc = new Y.Doc();
doc.getText('content').insert(0, 'js-to-go');
doc.getMap('_proposal_status').set('` + proposalID + `', 'accepted');
const update = Y.encodeStateAsUpdate(doc);
process.stdout.write(Buffer.from(update).toString('base64'));
`
	updateB64 := runNodeScript(t, repoRoot, script, "")

	update, err := base64.StdEncoding.DecodeString(strings.TrimSpace(updateB64))
	if err != nil {
		t.Fatalf("decode js update base64: %v", err)
	}

	doc := ycrdt.NewDoc("js-to-go-doc", true, ycrdt.DefaultGCFilter, nil, false)
	if err := safeApplyUpdate(doc, update, "js-update"); err != nil {
		t.Fatalf("apply js update in go: %v", err)
	}

	if got := doc.GetText("content").ToString(); got != "js-to-go" {
		t.Fatalf("unexpected content after js update: got %q", got)
	}
	status := doc.GetMap("_proposal_status").(*ycrdt.YMap).Get(proposalID)
	if status != "accepted" {
		t.Fatalf("unexpected mirrored status from js update: got %#v", status)
	}
}

func TestYjsWireCompatibility_GoUpdateDecodesInJS(t *testing.T) {
	repoRoot := requireJSYjs(t)
	proposalID := "22222222-2222-2222-2222-222222222222"

	doc := ycrdt.NewDoc("go-to-js-doc", true, ycrdt.DefaultGCFilter, nil, false)
	text := doc.GetText("content")
	statusMap := doc.GetMap("_proposal_status").(*ycrdt.YMap)
	doc.Transact(func(_ *ycrdt.Transaction) {
		text.Insert(0, "go-to-js", nil)
		statusMap.Set(proposalID, "rejected")
	}, "go-update")

	update, err := safeEncodeStateAsUpdate(doc)
	if err != nil {
		t.Fatalf("encode go update: %v", err)
	}

	script := `
const Y = require('./frontend/node_modules/yjs');
const fs = require('fs');
const input = fs.readFileSync(0, 'utf8').trim();
const update = Buffer.from(input, 'base64');
const doc = new Y.Doc();
Y.applyUpdate(doc, new Uint8Array(update));
const payload = {
  content: doc.getText('content').toString(),
  status: doc.getMap('_proposal_status').get('` + proposalID + `') ?? null
};
process.stdout.write(JSON.stringify(payload));
`
	out := runNodeScript(t, repoRoot, script, base64.StdEncoding.EncodeToString(update))

	var payload struct {
		Content string `json:"content"`
		Status  string `json:"status"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("decode js verification payload: %v", err)
	}
	if payload.Content != "go-to-js" {
		t.Fatalf("unexpected js-decoded content: got %q", payload.Content)
	}
	if payload.Status != "rejected" {
		t.Fatalf("unexpected js-decoded map status: got %q", payload.Status)
	}
}

func TestYjsWireCompatibility_JSV2PayloadProbe(t *testing.T) {
	repoRoot := requireJSYjs(t)

	script := `
const Y = require('./frontend/node_modules/yjs');
if (typeof Y.encodeStateAsUpdateV2 !== 'function') {
  process.stdout.write(JSON.stringify({ available: false }));
  process.exit(0);
}
const doc = new Y.Doc();
doc.getText('content').insert(0, 'v2-payload');
const update = Y.encodeStateAsUpdateV2(doc);
process.stdout.write(JSON.stringify({
  available: true,
  updateB64: Buffer.from(update).toString('base64')
}));
`
	out := runNodeScript(t, repoRoot, script, "")

	var payload struct {
		Available bool   `json:"available"`
		UpdateB64 string `json:"updateB64"`
	}
	if err := json.Unmarshal([]byte(out), &payload); err != nil {
		t.Fatalf("decode v2 probe payload: %v", err)
	}
	if !payload.Available {
		t.Skip("Y.encodeStateAsUpdateV2 is not available in installed yjs")
	}

	update, err := base64.StdEncoding.DecodeString(payload.UpdateB64)
	if err != nil {
		t.Fatalf("decode v2 payload base64: %v", err)
	}

	doc := ycrdt.NewDoc("v2-reject-doc", true, ycrdt.DefaultGCFilter, nil, false)
	if err := safeApplyUpdate(doc, update, "js-v2-update"); err == nil {
		t.Log("js v2 payload was accepted by current go decoder implementation")
		return
	}
	t.Log("js v2 payload was rejected by go decoder")
}

func requireJSYjs(t *testing.T) string {
	t.Helper()

	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required for js-go compatibility tests")
	}

	repoRoot := repositoryRoot(t)
	yjsPath := filepath.Join(repoRoot, "frontend", "node_modules", "yjs")
	if _, err := os.Stat(yjsPath); err != nil {
		t.Skip("frontend/node_modules/yjs is required for js-go compatibility tests")
	}
	return repoRoot
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve caller path for repository root")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(thisFile), "../../../.."))
}

func runNodeScript(t *testing.T, dir string, script string, stdin string) string {
	t.Helper()

	cmd := exec.Command("node", "-e", script)
	cmd.Dir = dir
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("run node script: %v\noutput: %s", err, string(out))
	}
	return strings.TrimSpace(string(out))
}
