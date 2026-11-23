#!/usr/bin/env bash
# A Draft chat turn's Restore before, the AI's turn Undo on the one Undo rule, and a chat switched
# from Draft to Live, through the HTTP routes and room sockets of a running stack on the mock model.
# Recipe: work-drafts.md beside this file.
#
#   MODEL_PROVIDER=mock LIVE_TEST_MODEL= pnpm dev
#   bash apps/server/server/domains/collab/.context/qa/restore-before-on-the-stack.sh
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
uuid() { cat /proc/sys/kernel/random/uuid; }
field() { python3 -c "import json,sys; d=json.loads(sys.stdin.read().splitlines()[-1]); print($1)"; }
fails=0
check() { if [[ $1 == "$2" ]]; then echo "ok   $3"; else echo "FAIL $3: got <$1>, want <$2>"; fails=$((fails + 1)); fi; }
sql() { tools/dev/psql -w -Atc "$1"; }
send() { ./mf thread send "$1" go --mock "@$2" --json >/dev/null; }
# reply <file> <path> [<find> <content>]...: a mock reply that reads the path, then writes each pair.
reply() {
  python3 - "$@" <<'PY'
import json, sys
out, path, *pairs = sys.argv[1:]
steps = [{"text": "Reading.", "toolCalls": [{"name": "read", "args": {"path": path}}]}]
for find, content in zip(pairs[::2], pairs[1::2]):
    steps.append({"text": "Writing.", "toolCalls": [{"name": "write", "args": {
        "command": "replace", "path": path, "find": find, "content": content}}]})
steps.append({"text": "Done."})
json.dump({"steps": steps}, open(out, "w"))
PY
}
# tool <file> <args-json>: a mock reply that makes one write call.
tool() {
  python3 - "$1" "$2" <<'PY'
import json, sys
json.dump({"steps": [{"text": "Writing.", "toolCalls": [{"name": "write", "args": json.loads(sys.argv[2])}]},
  {"text": "Done."}]}, open(sys.argv[1], "w"))
PY
}
put() { ./mf doc put "manuscript://$1" --text "$2" --json | field "d['documentId']"; }
press() { ./mf api POST "/api/projects/$P/press" --data "{\"commandId\":\"$1\",\"verdict\":\"$2\",\"scope\":$3}" --json; }
undo() { ./mf api POST "/api/projects/$P/press/undo" --data "{\"commandId\":\"$(uuid)\",\"pressCommandId\":\"$1\"}" --json; }
live() { ./mf doc read "manuscript://$1" | tail -n +3 | tr '\n' '|'; }
draft() { ./mf doc read "manuscript://$1" --draft "$D" | tail -n +3 | tr '\n' '|'; }
turn() { sql "select turn_id from document_edits where thread_id = '$1' and document_id = '$2' order by created_at desc limit 1"; }
blockOf() {
  sql "select a->'attrs'->>'id' from document_edit_parts p join document_edits e on e.id = p.edit_id,
    jsonb_array_elements(p.delta->'after') a where e.document_id = '$1' and a->'content'->0->>'text' = '$2' limit 1"
}
pending() { sql "select coalesce((select pending::text from document_forks where draft_id = '$D' and document_id = '$1'), 'none')"; }

run=$(date +%s)
P=$(./mf project default | tail -1)
work=$(./mf api POST "/api/projects/$P/works" --data "{\"commandId\":\"$(uuid)\",\"name\":\"Restore probe $run\"}" --json)
handle=$(echo "$work" | field "d['handle']")
D=$(echo "$work" | field "d['draftId']")
chat=$(./mf thread create --work "$handle" --write-mode draft --title "Draft chat" --json | field "d['threadId']")
direct=$(./mf thread create --work "$handle" --write-mode direct --title "Live chat" --json | field "d['threadId']")

# A. A Draft chat turn rewrites two paragraphs; Restore before returns the draft to Live's text,
# and its Undo brings the turn's text back.
one="Restore $run one"
CH1=$(put "$one" $'# One\n\nThe bell rang at noon.\n\nThe square was empty.')
reply "$tmp/a.json" "manuscript://$one" "The bell rang at noon." "The bell tolled at dusk." "The square was empty." "The square filled with lanterns."
send "$chat" "$tmp/a.json"
check "$(draft "$one")" "The bell tolled at dusk.||The square filled with lanterns.|" "A: the turn wrote both paragraphs in the draft"
check "$(live "$one")" "The bell rang at noon.||The square was empty.|" "A: Live is untouched"
restore=$(uuid)
answer=$(press "$restore" restore "{\"kind\":\"turn\",\"turn\":\"$(turn "$chat" "$CH1")\",\"draft\":\"$D\"}")
check "$(echo "$answer" | field "d['documents']")" "['$CH1']" "A: Restore before names the document"
check "$(draft "$one")" "The bell rang at noon.||The square was empty.|" "A: the draft reads as before the turn"
check "$(pending "$CH1")" false "A: nothing waits for review"
check "$(undo "$restore" | field "len(d['stayed'])")" 0 "A: its Undo leaves nothing"
check "$(draft "$one")" "The bell tolled at dusk.||The square filled with lanterns.|" "A: the Undo brings the turn's text back"
check "$(pending "$CH1")" true "A: the draft is pending again"

# B. One change of the turn applied first: Restore before leaves it in Live, and the draft agrees.
two="Restore $run two"
CH2=$(put "$two" $'# Two\n\nThe road ran north.\n\nThe river ran south.')
reply "$tmp/b.json" "manuscript://$two" "The road ran north." "The road climbed into the hills." "The river ran south." "The river froze."
send "$chat" "$tmp/b.json"
road=$(blockOf "$CH2" "The road climbed into the hills.")
press "$(uuid)" apply "{\"kind\":\"change\",\"item\":\"$D:$CH2\",\"change\":\"$road\"}" >/dev/null
check "$(live "$two")" "The road climbed into the hills.||The river ran south.|" "B: Apply put one change in Live"
press "$(uuid)" restore "{\"kind\":\"turn\",\"turn\":\"$(turn "$chat" "$CH2")\",\"draft\":\"$D\"}" >/dev/null
check "$(live "$two")" "The road climbed into the hills.||The river ran south.|" "B: Restore before leaves the applied text in Live"
check "$(draft "$two")" "The road climbed into the hills.||The river ran south.|" "B: the draft reads as Live"
check "$(pending "$CH2")" false "B: nothing waits for review"

# C. A Live chat turn rewrites two paragraphs; the writer retypes one. The card's Undo takes the
# other back, leaves the retyped one whole, and says so.
three="Restore $run three"
CH3=$(put "$three" $'# Three\n\nThe bell rang.\n\nThe door was shut.')
reply "$tmp/c.json" "manuscript://$three" "The bell rang." "The bell tolled twice." "The door was shut." "The door swung open."
send "$direct" "$tmp/c.json"
./mf doc edit "manuscript://$three" --find "tolled twice" --replace "fell silent" >/dev/null
card=$(./mf api POST "/api/threads/$direct/context/reverse" \
  --data "{\"scope\":\"turn\",\"commandId\":\"$(uuid)\",\"target\":\"$(turn "$direct" "$CH3")\"}" --json)
check "$(echo "$card" | field "d['status']")" partial "C: the card's Undo answers partial"
check "$(echo "$card" | field "[x['status'] for x in d['documents']]")" "['partial']" "C: and names the document"
check "$(live "$three")" "The bell fell silent.||The door was shut.|" "C: the writer's text stays, the untouched edit is undone"

# D. The model's own undo of an edit the writer retyped: it stays, and the answer says so.
four="Restore $run four"
put "$four" $'# Four\n\nThe lamp was lit.' >/dev/null
reply "$tmp/d.json" "manuscript://$four" "The lamp was lit." "The lamp guttered out."
send "$direct" "$tmp/d.json"
./mf doc edit "manuscript://$four" --find "guttered out" --replace "burned low" >/dev/null
tool "$tmp/d-undo.json" "{\"command\":\"undo\",\"path\":\"manuscript://$four\"}"
send "$direct" "$tmp/d-undo.json"
said=$(sql "select b.content->'result'->>'message' from turn_blocks b join turns u on u.id = b.turn_id
  where u.thread_id = '$direct' and b.block_type = 'tool_result' order by b.created_at desc limit 1")
check "$said" "Can't undo e1: someone has written over it since, so it stays as they left it. Nothing was changed." "D: the model's undo says the edit was written over"
check "$(live "$four")" "The lamp burned low.|" "D: the writer's text stays"

# E. A chat reads in Draft, the writer types in Live, the chat is switched to Live and writes: the
# write plans on its Draft read (the draft wrote nothing there), so the writer's typing stays.
five="Restore $run five"
put "$five" $'# Five\n\nKade ran. The bell rang.' >/dev/null
switcher=$(./mf thread create --work "$handle" --write-mode draft --title "Switching chat" --json | field "d['threadId']")
python3 - "$tmp/e-read.json" "manuscript://$five" <<'PY'
import json, sys
json.dump({"steps": [{"text": "Reading.", "toolCalls": [{"name": "read", "args": {"path": sys.argv[2]}}]},
  {"text": "Read."}]}, open(sys.argv[1], "w"))
PY
send "$switcher" "$tmp/e-read.json"
./mf doc edit "manuscript://$five" --find "ran." --replace "ran fast." >/dev/null
./mf api POST "/api/threads/$switcher/controls" --data "{\"id\":\"$(uuid)\",\"control\":{\"kind\":\"write_mode\",\"mode\":\"direct\"}}" --json >/dev/null
tool "$tmp/e-write.json" "{\"command\":\"replace\",\"path\":\"manuscript://$five\",\"find\":\"Kade ran. The bell rang.\",\"content\":\"Kade ran. The bell tolled.\"}"
send "$switcher" "$tmp/e-write.json"
check "$(live "$five")" "Kade ran fast. The bell tolled.|" "E: the write lands on the Draft read and keeps the writer's Live typing"

echo "$fails failed"
exit $((fails > 0))
