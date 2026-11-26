#!/usr/bin/env bash
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
uuid() { cat /proc/sys/kernel/random/uuid; }
field() { python3 -c "import json,sys; d=json.loads(sys.stdin.read().splitlines()[-1]); print($1)"; }
fails=0
check() { if [[ $1 == "$2" ]]; then echo "ok   $3"; else echo "FAIL $3: got <$1>, want <$2>"; fails=$((fails + 1)); fi; }
sql() { tools/dev/psql -w -Atc "$1"; }
send() { ./mf thread send "$1" go --mock "@$2" --json >/dev/null; }
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

one="Restore $run one"
CH1=$(put "$one" $'# One\n\nThe bell rang at noon.\n\nThe square was empty.')
reply "$tmp/a.json" "manuscript://$one" "The bell rang at noon." "The bell tolled at dusk." "The square was empty." "The square filled with lanterns."
send "$chat" "$tmp/a.json"
check "$(draft "$one")" "The bell tolled at dusk.||The square filled with lanterns.|" "A: the turn wrote both paragraphs in the draft"
check "$(live "$one")" "The bell rang at noon.||The square was empty.|" "A: Live is untouched"
restore=$(uuid)
answer=$(press "$restore" restore "{\"kind\":\"turn\",\"turn\":\"$(turn "$chat" "$CH1")\",\"draft\":\"$D\"}")
check "$(echo "$answer" | field "d['documents']")" "['$CH1']" "A: the restore names the document"
check "$(draft "$one")" "The bell rang at noon.||The square was empty.|" "A: the draft reads as before the turn"
check "$(pending "$CH1")" false "A: nothing waits for review"
scope="{\"kind\":\"turn\",\"turn\":\"$(turn "$chat" "$CH1")\",\"draft\":\"$D\"}"
check "$(press "$(uuid)" restore "$scope" | field "d['documents']")" "[]" "A: a second restore changes nothing"
check "$(draft "$one")" "The bell rang at noon.||The square was empty.|" "A: and the old words show once"
tool "$tmp/a-undo.json" "{\"command\":\"undo\",\"path\":\"manuscript://$one\"}"
send "$chat" "$tmp/a-undo.json"
check "$(draft "$one")" "The bell rang at noon.||The square was empty.|" "A: the model's undo after the restore takes nothing back again"
check "$(undo "$restore" | field "d['status']")" unpressed "A: its Undo runs"
check "$(draft "$one")" "The bell tolled at dusk.||The square filled with lanterns.|" "A: the Undo brings the turn's text back"
check "$(pending "$CH1")" true "A: the draft is pending again"
redo=$(uuid)
check "$(press "$redo" restore "$scope" | field "d['documents']")" "['$CH1']" "A: pressing again is the Redo"
check "$(draft "$one")" "The bell rang at noon.||The square was empty.|" "A: the Redo reads as before the turn, the old words once"
undo "$redo" >/dev/null
check "$(draft "$one")" "The bell tolled at dusk.||The square filled with lanterns.|" "A: the Redo's Undo brings the turn's text back once"

two="Restore $run two"
CH2=$(put "$two" $'# Two\n\nThe road ran north.\n\nThe river ran south.')
reply "$tmp/b.json" "manuscript://$two" "The road ran north." "The road climbed into the hills." "The river ran south." "The river froze."
send "$chat" "$tmp/b.json"
road=$(blockOf "$CH2" "The road climbed into the hills.")
press "$(uuid)" apply "{\"kind\":\"change\",\"item\":\"$D:$CH2\",\"change\":\"$road\"}" >/dev/null
check "$(live "$two")" "The road climbed into the hills.||The river ran south.|" "B: Apply put one change in Live"
press "$(uuid)" restore "{\"kind\":\"turn\",\"turn\":\"$(turn "$chat" "$CH2")\",\"draft\":\"$D\"}" >/dev/null
check "$(live "$two")" "The road climbed into the hills.||The river ran south.|" "B: the restore leaves the applied text in Live"
check "$(draft "$two")" "The road ran north.||The river ran south.|" "B: the draft reads as before the turn"
check "$(pending "$CH2")" true "B: taking the applied change out waits for review"

words() { python3 -c "import sys; t=sys.argv[1]; print(all(w in t for w in sys.argv[2].split()))" "$1" "$2"; }
three="Restore $run three"
CH3=$(put "$three" $'# Three\n\nThe bell rang.\n\nThe door was shut.')
reply "$tmp/c.json" "manuscript://$three" "The bell rang." "The bell tolled twice." "The door was shut." "The door swung open."
send "$direct" "$tmp/c.json"
./mf doc edit "manuscript://$three" --find "tolled twice" --replace "fell silent" >/dev/null
card=$(./mf api POST "/api/threads/$direct/context/reverse" \
  --data "{\"scope\":\"turn\",\"commandId\":\"$(uuid)\",\"target\":\"$(turn "$direct" "$CH3")\"}" --json)
check "$(echo "$card" | field "d['status']")" reversed "C: the card's Undo answers reversed"
check "$(echo "$card" | field "[x['status'] for x in d['documents']]")" "['reversed']" "C: and names the document"
check "$(words "$(live "$three")" "fell silent rang door was shut")" True "C: the writer's words stay, the turn's text is undone"

four="Restore $run four"
put "$four" $'# Four\n\nThe lamp was lit.' >/dev/null
reply "$tmp/d.json" "manuscript://$four" "The lamp was lit." "The lamp guttered out."
send "$direct" "$tmp/d.json"
./mf doc edit "manuscript://$four" --find "guttered out" --replace "burned low" >/dev/null
tool "$tmp/d-undo.json" "{\"command\":\"undo\",\"path\":\"manuscript://$four\"}"
send "$direct" "$tmp/d-undo.json"
said=$(sql "select b.content->'result'->>'message' from turn_blocks b join turns u on u.id = b.turn_id
  where u.thread_id = '$direct' and b.block_type = 'tool_result' order by b.created_at desc limit 1")
check "$(echo "$said" | grep -c 'undone: e1')" 1 "D: the model's undo takes the edit out"
check "$(words "$(live "$four")" "burned low was lit")" True "D: the writer's words stay and the lamp's text comes back"

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
