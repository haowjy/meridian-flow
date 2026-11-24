#!/usr/bin/env bash
# The press through the HTTP routes of a running stack on the mock model: a draft-created paragraph
# applied alone, a second draft's count, Apply all at `work` scope and its Undo, and an Undo over a
# chat's write, which runs and keeps the chat's words. Recipe: work-drafts.md beside this file.
#
#   MODEL_PROVIDER=mock pnpm dev
#   bash apps/server/server/domains/collab/.context/qa/press-on-the-stack.sh
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
uuid() { cat /proc/sys/kernel/random/uuid; }
field() { python3 -c "import json,sys; d=json.loads(sys.stdin.read().splitlines()[-1]); print($1)"; }
fails=0
check() { if [[ $1 == "$2" ]]; then echo "ok   $3"; else echo "FAIL $3: got <$1>, want <$2>"; fails=$((fails + 1)); fi; }
sql() { tools/dev/psql -w -Atc "$1"; }
send() { ./mf thread send "$1" go --mock "@$2" --json >/dev/null; }
# write <file> <path> <find> <content>: a mock reply that reads the path and replaces `find`.
write() {
  python3 - "$@" <<'PY'
import json, sys
out, path, find, content = sys.argv[1:]
json.dump({"steps": [
  {"text": "Reading.", "toolCalls": [{"name": "read", "args": {"path": path}}]},
  {"text": "Writing.", "toolCalls": [{"name": "write", "args": {
    "command": "replace", "path": path, "find": find, "content": content}}]},
  {"text": "Done."}]}, open(out, "w"))
PY
}
put() { ./mf doc put "manuscript://$1" --text "$2" --json | field "d['documentId']"; }
press() { ./mf api POST "/api/projects/$P/press" --data "{\"commandId\":\"$1\",\"verdict\":\"apply\",\"scope\":$2}" --json; }
undo() { ./mf api POST "/api/projects/$P/press/undo" --data "{\"commandId\":\"$(uuid)\",\"pressCommandId\":\"$1\"}" --json; }
last() { ./mf doc read "manuscript://$1" | tail -1; }

run=$(date +%s)
P=$(./mf project default | tail -1)
work=$(./mf api POST "/api/projects/$P/works" --data "{\"commandId\":\"$(uuid)\",\"name\":\"Press probe $run\"}" --json)
W=$(echo "$work" | field "d['id']")
handle=$(echo "$work" | field "d['handle']")
D1=$(echo "$work" | field "d['draftId']")
c1=$(./mf thread create --work "$handle" --write-mode draft --title "Draft one" --json | field "d['threadId']")
c2=$(./mf thread create --work "$handle" --write-mode draft --title "Draft two" --json | field "d['threadId']")
live=$(./mf thread create --work "$handle" --write-mode direct --title "Live chat" --json | field "d['threadId']")
D2=$(./mf api POST "/api/works/$W/drafts" --data "{\"commandId\":\"$(uuid)\",\"name\":\"Second\"}" --json | field "d['draft']['id']")
check "$(./mf api PUT "/api/threads/$c2/draft" --data "{\"commandId\":\"$(uuid)\",\"draftId\":\"$D2\"}" --json | field "d['draftId']")" "$D2" \
  "PUT /api/threads/:id/draft names the Work's second draft"

# A paragraph the draft created, applied alone, gives Live its text.
one="Probe $run one"
CH1=$(put "$one" $'# One\n\nThe first paragraph.\n\nThe last paragraph.')
write "$tmp/created.json" "manuscript://$one" "The last paragraph." $'The last paragraph.\n\nA closing paragraph only the draft wrote.'
send "$c1" "$tmp/created.json"
created=$(sql "select a->'attrs'->>'id' from document_edit_parts p join document_edits e on e.id = p.edit_id,
  jsonb_array_elements(p.delta->'after') a where e.document_id = '$CH1'
  and a->'content'->0->>'text' = 'A closing paragraph only the draft wrote.' limit 1")
press "$(uuid)" "{\"kind\":\"change\",\"item\":\"$D1:$CH1\",\"change\":\"$created\"}" >/dev/null
check "$(last "$one")" "A closing paragraph only the draft wrote." "a draft-created paragraph applied alone lands with its text"

# Two drafts of one Work, each pending; the second's count moves with its first write.
two="Probe $run two"
CH2=$(put "$two" $'# Two\n\nThe first paragraph.\n\nThe second paragraph.')
write "$tmp/d1.json" "manuscript://$two" "The first paragraph." "The first paragraph, by draft one."
write "$tmp/d2.json" "manuscript://$two" "The second paragraph." "The second paragraph, by draft two."
send "$c1" "$tmp/d1.json"
send "$c2" "$tmp/d2.json"
check "$(sql "select pending_document_count from drafts where id = '$D2'")" 1 "the second draft counts its pending document"
check "$(sql "select pending_document_count from works where id = '$W'")" 2 "the Work counts both drafts'"

# Apply all at work scope lands both drafts; its Undo takes both back.
all=$(uuid)
press "$all" "{\"kind\":\"work\",\"work\":\"$W\"}" >/dev/null
check "$(./mf doc read "manuscript://$two" | tail -3 | tr '\n' '|')" "The first paragraph, by draft one.||The second paragraph, by draft two.|" \
  "Apply all lands both drafts"
check "$(sql "select count(*) from document_forks where draft_id in ('$D1','$D2') and pending")" 0 "Apply all leaves no fork pending"
check "$(sql "select pending_document_count from works where id = '$W'")" 0 "the Work's count is 0"
check "$(undo "$all" | field "d['status']")" unpressed "its Undo runs"
check "$(./mf doc read "manuscript://$two" | tail -3 | tr '\n' '|')" "The first paragraph.||The second paragraph.|" \
  "the Undo gives Live its text back"
check "$(sql "select count(*) from document_forks where draft_id in ('$D1','$D2') and document_id = '$CH2' and pending")" 2 \
  "both forks are pending again"

# A chat writes over an applied change: the Undo still runs (design §2). It deletes what is left
# of the press's characters and puts back the text the press deleted; every word the chat
# typed that is not one of the press's characters stays.
words() { python3 -c "import sys; t=sys.argv[1]; print(all(w in t for w in sys.argv[2].split()))" "$1" "$2"; }
three="Probe $run three"
put "$three" $'# Three\n\nThe only paragraph of chapter three.' >/dev/null
write "$tmp/d3.json" "manuscript://$three" "The only paragraph of chapter three." "Chapter three, rewritten by its draft."
send "$c1" "$tmp/d3.json"
pressed=$(uuid)
press "$pressed" "{\"kind\":\"draft\",\"draft\":\"$D1\"}" >/dev/null
write "$tmp/l3.json" "manuscript://$three" "Chapter three, rewritten by its draft." "Night falls on chapter three."
send "$live" "$tmp/l3.json"
check "$(undo "$pressed" | field "d['status']")" unpressed "the Undo over a chat's write runs"
check "$(words "$(./mf doc read "manuscript://$three" | tail -3 | tr '\n' ' ')" "Night falls The only paragraph of")" True \
  "the chat's own words stay and the text the press replaced comes back"
echo "$fails failed"
exit $((fails > 0))
