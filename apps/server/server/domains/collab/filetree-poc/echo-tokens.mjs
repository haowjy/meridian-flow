import { encode } from "gpt-tokenizer/encoding/o200k_base";
const est = (s) => Math.ceil(new TextEncoder().encode(s).byteLength / 3);
const cases = {
  // today
  "today: move, live": "status: success; path: manuscript://Arc 3/Chapter 49; write: e7; version: live; moved from manuscript://Arc 2/Chapter 49",
  "today: move, draft": "not applied yet: moved only in this chat's draft; live still has it at manuscript://Arc 2/Chapter 49 until the user applies it. Tell the user it is waiting for their review.\n\nstatus: success; path: manuscript://Arc 3/Chapter 49; write: e7; version: draft (w2); moved from manuscript://Arc 2/Chapter 49",
  "today: delete, live": "status: success; path: manuscript://Arc 2/Chapter 49; write: e8; version: live; deleted",
  // proposed plain
  "move / rename / reorder, live": "status: success; write: e7; version: live",
  "move, draft (after the first in a reply)": "status: success; write: e7; version: draft (w2)",
  "move, draft (first drafted tree change of a reply)": "not applied yet: tree changes in this chat's draft stay out of live until the user applies them. Tell the user they are waiting for review.\n\nstatus: success; write: e7; version: draft (w2)",
  "move of several into a folder (9 items)": "status: success; write: e7; version: live; moved: 9",
  "create folder": "status: success; write: e9; version: live",
  "delete document": "status: success; write: e8; version: live",
  "delete folder": "status: success; write: e8; version: live; deleted: 31 inside",
  "restore": "status: success; write: e10; version: live",
  // stale
  "stale path: source renamed by the writer since": "status: success; path: manuscript://Arc 3/The Fall; write: e7; version: live\n\nconcurrent tree changes:\nuser Jimmy:\n  renamed: manuscript://Arc 2/Chapter 49 → The Fall",
  "name taken, numbered": "status: success; path: manuscript://Arc 3/Notes (2); write: e7; version: live",
  "source deleted since": "status: gone; path: manuscript://Arc 2/Chapter 49\n\nNot moved: user Jimmy deleted it after you last listed it. `restore` brings it back.",
  "destination folder deleted since": "status: gone; path: manuscript://Arc 3/\n\nNot moved: user Jimmy deleted this folder after you last listed it.",
  "loop": "status: invalid_write; path: manuscript://Arc 2/Part 1/Arc 2\n\nNot moved: it would put manuscript://Arc 2/ inside itself.",
  "loop made by a move since": "status: invalid_write; path: manuscript://Part 1/Arc 2\n\nNot moved: it would put manuscript://Arc 2/ inside itself. user Jimmy moved manuscript://Part 1/ into it after you last listed it.",
  "delete folder that gained a document since": "status: success; write: e8; version: live; deleted: 31 inside; kept: manuscript://Arc 2/ with manuscript://Arc 2/Chapter 50, added by user Jimmy after you last listed it",
  "restore, old folder gone": "status: success; path: manuscript://Chapter 49; write: e10; version: live",
  "already deleted": "status: success; version: live; already deleted by user Jimmy",
  "both renamed": "status: success; write: e7; version: live\n\nconcurrent tree changes:\nuser Jimmy:\n  renamed: manuscript://Arc 2/Chapter 49 → The Fall",
  "20 drafted moves, proposed": ["not applied yet: tree changes in this chat's draft stay out of live until the user applies them. Tell the user they are waiting for review.\n\nstatus: success; write: e1; version: draft (w2)", ...Array.from({length:19},(_, i)=>`status: success; write: e${i+2}; version: draft (w2)`)].join("\n"),
  "20 drafted moves, today": Array.from({length:20},(_, i)=>`not applied yet: moved only in this chat's draft; live still has it at manuscript://Arc 2/Chapter ${41+i} until the user applies it. Tell the user it is waiting for their review.\n\nstatus: success; path: manuscript://Arc 3/Chapter ${41+i}; write: e${i+1}; version: draft (w2); moved from manuscript://Arc 2/Chapter ${41+i}`).join("\n"),
  "path names a different node now": "status: path_changed; path: manuscript://Chapter 49\n\nNothing done: the document you listed as manuscript://Chapter 49 is now manuscript://The Fall, and user Jimmy has made a new manuscript://Chapter 49. Use the path of the one you mean.",
  "move several, partly made": "status: success; write: e7; version: live; moved: 7 of 9\n\nnot moved: manuscript://Arc 2/Chapter 44 (deleted by user Jimmy); manuscript://Arc 2/Part 1/ (would put it inside itself)",
  "delete with surviving Works": "status: success; write: e8; version: live\n\nw2 still has changes to it; applying them brings it back.",
  "restore into a folder still in Trash": "status: success; write: e10; version: live; kept: manuscript://Arc 2/",
  "sibling for position gone": "status: success; write: e7; version: live; placed at end: manuscript://Arc 3/Chapter 48 is no longer in this folder",
  "too many changes: re-list": "status: success; write: e7; version: live\n\nconcurrent tree changes: 143 since you last listed, too many to show. `ls` the folders you are working in before using a path from an older listing.",
  "draft mode, node deleted in live": "status: success; write: e7; version: draft (w2)\n\ndeleted in live by user Jimmy: this waits until it is restored",
  "too many, new wording": "status: success; write: e7; version: live\n\nconcurrent tree changes: 143 since you last listed, too many to show. `ls` a folder before relying on an older listing of it.",
  "report: 4 changes by the user": "concurrent tree changes:\nuser Jimmy:\n  renamed: manuscript://Arc 2/Chapter 49 → The Fall\n  moved: manuscript://Notes/Outline → manuscript://Arc 3/\n  deleted: manuscript://Old outline\n  created: manuscript://Arc 3/Chapter 50",
};
// a folder re-listing: 30 chapters
const ls = ["manuscript://Arc 3/", ...Array.from({ length: 30 }, (_, i) => `  Chapter ${41 + i}`)].join("\n");
const lsTitled = ["manuscript://Arc 3/", ...Array.from({ length: 30 }, (_, i) => `  Chapter ${41 + i}: The Long Road North`)].join("\n");
cases["ls of a 30-chapter folder (short names)"] = ls;
cases["ls of a 30-chapter folder (titled chapters)"] = lsTitled;
cases["ls call + result overhead: the call's arguments"] = '{"path":"manuscript://Arc 3/"}';
for (const [k, v] of Object.entries(cases)) console.log(`${String(encode(v).length).padStart(4)} o200k  ${String(est(v)).padStart(4)} est  | ${k}`);
