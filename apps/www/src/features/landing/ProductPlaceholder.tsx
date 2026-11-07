import type { CardStore } from "./card-store";
import { MUSE_REPLY, NEXT_LINE, QUESTIONS } from "./story";

/**
 * A drawing of the real app, to be replaced by captured footage. The page only
 * calls `set` from `createProductSlot`; footage would seek there, and the box, the
 * night grade and the motion stay.
 */
export function ProductPlaceholder() {
  return (
    <div className="slot" id="slot" data-state="team" data-view="chat">
      <aside className="s-rail" aria-label="Project">
        <div className="s-proj">The Long Reckoning</div>
        <button type="button" className="s-n">
          Chat
        </button>
        <button type="button" className="s-n">
          Work
        </button>
        <button type="button" className="s-n on">
          Editor
        </button>
        <div className="s-h">MANUSCRIPT</div>
        <div className="s-d">Book 1</div>
        <RailDocument id="d9">9. The Hook</RailDocument>
        <div className="s-d">Book 2</div>
        <RailDocument id="d146">146. Salt Tea</RailDocument>
        <div className="s-d">Book 3</div>
        <RailDocument id="d263">263. Night Watch</RailDocument>
        <RailDocument id="d380">380. Fog</RailDocument>
        <div className="s-d">Book 4</div>
        <RailDocument id="d412" on>
          412. Dead Reckoning
        </RailDocument>
        <RailDocument id="d413" extraClass="s-only-hints">
          413. Brown Ink
        </RailDocument>
        <div className="s-h">KNOWLEDGE BASE</div>
        <RailDocument id="ddell">Aldous Dell</RailDocument>
      </aside>
      <div className="s-pane">
        <div className="s-top">
          <span>Manuscript</span>
          <span>›</span>
          <b id="s-name">412. Dead Reckoning</b>
        </div>
        <div className="s-body">
          <article className="s-doc" id="d412">
            <h3>412. Dead Reckoning</h3>
            <p>On the four hundred and twelfth night, the stars came back wrong.</p>
            <p>
              Ise Varo went below and read her own handwriting. Ninth night out of Sarn. A boy with
              a cargo hook opened the captain’s left palm to the bone. Nine stitches. He did not
              make a sound.
            </p>
            <p>
              Above her the hatch scraped. Captain Dell came down the ladder with the lantern, the
              way he had every night since Sarn, and asked her where they were.
            </p>
            <p>
              “Close,” she said, and watched him lift his right hand to hang the lamp on its hook.
              The scar ran white across the palm.
            </p>
          </article>
          <article className="s-doc" id="d413" hidden>
            <h3>413. Brown Ink</h3>
            <p>
              The wind came back in the morning watch. Nobody aboard thanked it. The crew went up
              the ratlines with the slow care of people who had stopped expecting anything, and the
              sails filled, and for the first time in nine days the <i>Harrow</i> had a wake.
            </p>
            <p>Ise stayed at the chart table until the lamp was only a habit.</p>
            <p>
              <span id="s-typing" />
              <i className="s-car" />
            </p>
          </article>
          <article className="s-doc" id="d9" hidden>
            <h3>9. The Hook</h3>
            <p>
              The boy was maybe twelve and had never held a cargo hook. It came round on the swell
              and opened the captain’s palm to the bone. Left hand. Nine stitches, and he did not
              make a sound.
            </p>
          </article>
          <article className="s-doc" id="d146" hidden>
            <h3>146. Salt Tea</h3>
            <p>He took the cup in his left hand, the way he always had, and drank.</p>
          </article>
          <article className="s-doc" id="d263" hidden>
            <h3>263. Night Watch</h3>
            <p>She would remember later how long he had been gone from the deck that night.</p>
          </article>
          <article className="s-doc" id="d380" hidden>
            <h3>380. Fog</h3>
            <p>
              The fog sat on them for two days. When it lifted he was at the wheel, and nobody had
              seen him go up.
            </p>
          </article>
          <article className="s-doc" id="ddell" hidden>
            <h3>Aldous Dell</h3>
            <p>
              Captain of the <i>Harrow</i>. Born in Sarn. Scar across the left palm (chapter 9).
            </p>
            <p className="s-only-hints" id="s-note">
              {MUSE_REPLY.a.note}
            </p>
          </article>
        </div>
        <nav className="s-tabs" aria-label="Workspace views">
          <button type="button" data-view="project" aria-pressed="false">
            Project
          </button>
          <button type="button" data-view="page" aria-pressed="false">
            Page
          </button>
          <button type="button" data-view="chat" aria-pressed="true">
            Chat
          </button>
        </nav>
      </div>
      <aside className="s-chat" aria-label="Chat">
        <div className="s-ct">
          Chapter 412 <span className="s-only-team">2 running</span>
        </div>
        <div className="s-msgs">
          <div className="s-me s-only-team">Have the team read it.</div>
          <HelperCard
            letter="C"
            name="Continuity-checker"
            scope="Chapter 412"
            line="Finished"
            done
          />
          <HelperCard letter="C" name="Critic" scope="Chapter 412" line="Reading the scene" />
          <HelperCard letter="R" name="Reader-sim" scope="Chapter 412" line="Finished" done />
          <HelperCard
            letter="W"
            name="Writer-helper"
            scope="Ending"
            line="Drafting two shorter endings"
          />
          <HelperCard
            letter="C"
            name="Continuity-checker"
            scope="Dell’s chapters"
            line="Finished"
            done
            hints
          />
          <HelperCard letter="R" name="Reader-sim" scope="Hints" line="Finished" done hints />
          <HelperCard letter="C" name="Critic" scope="Chapter 413" line="Reading the scene" hints />
          <div className="s-me s-only-hints s-first">
            Plant it early. Three hints, nothing a reader would catch the first time.
          </div>
          <div className="s-ai s-only-hints" id="s-reply">
            {MUSE_REPLY.a.chat}
          </div>
          <div className="s-ed big s-only-hints">
            <span>Edited 4 documents</span>
            <button type="button" id="s-undo">
              Undo
            </button>
            <small>146, 263, 380, Aldous Dell</small>
          </div>
        </div>
        <div className="s-take s-only-team">
          <b>{QUESTIONS[0].text}</b>
          {QUESTIONS[0].options.map((option) => (
            <div className="s-opt" key={option.key}>
              <b>{option.label}</b>
              {option.recommended ? <span className="s-rec">Recommended</span> : null}
              <small>{option.detail}</small>
            </div>
          ))}
          <div className="s-foot">
            <span>Skip</span>
            <span>Continues in 4 min</span>
          </div>
        </div>
        <div className="s-comp s-only-hints">
          <span className="s-pill">Muse</span>
          <span className="s-pill">Auto-apply</span>
          <u />
          <span className="s-send" aria-hidden="true">
            ↑
          </span>
        </div>
      </aside>
    </div>
  );
}

function RailDocument({
  id,
  on,
  extraClass = "",
  children,
}: {
  id: string;
  on?: boolean;
  extraClass?: string;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className={`s-n in ${on ? "on" : ""} ${extraClass}`} data-doc={id}>
      {children}
    </button>
  );
}

function HelperCard({
  letter,
  name,
  scope,
  line,
  done,
  hints,
}: {
  letter: string;
  name: string;
  scope: string;
  line: string;
  done?: boolean;
  hints?: boolean;
}) {
  return (
    <div className={`s-card ${hints ? "s-only-hints s-done" : "s-only-team"}`}>
      <span className={done ? "s-ring ok" : "s-ring"}>
        <i>{letter}</i>
      </span>
      <span>
        <b>{name}</b> <span>{scope}</span>
      </span>
      <p>{line}</p>
    </div>
  );
}

export type ProductView = "project" | "page" | "chat";
export type ProductState = "team" | "hints";
export type ProductSlot = ReturnType<typeof createProductSlot>;

/** The product block's only interface. The film drives it; rail and tabs work under the visitor. */
export function createProductSlot(root: HTMLElement, store: CardStore, signal: AbortSignal) {
  const slot = root.querySelector<HTMLElement>("#slot") as HTMLElement;
  const part = (selector: string) => slot.querySelector(selector) as HTMLElement;
  const documents = [...slot.querySelectorAll<HTMLElement>(".s-doc")];
  const railDocuments = [...slot.querySelectorAll<HTMLElement>(".s-n[data-doc]")];
  const tabs = [...slot.querySelectorAll<HTMLElement>(".s-tabs button")];
  const typing = part("#s-typing");
  const reply = part("#s-reply");
  const note = part("#s-note");
  let state: ProductState | null = null;
  // Once the visitor picks a document or tab, autoplay leaves that view alone.
  let held = false;

  const open = (id: string) => {
    for (const doc of documents) doc.hidden = doc.id !== id;
    for (const row of railDocuments) row.classList.toggle("on", row.dataset.doc === id);
    part("#s-name").textContent = slot.querySelector(`#${id} h3`)?.textContent ?? "";
  };
  const view = (next: ProductView) => {
    slot.dataset.view = next;
    for (const tab of tabs) {
      tab.setAttribute("aria-pressed", String(tab.dataset.view === next));
    }
  };

  for (const row of railDocuments) {
    row.addEventListener(
      "click",
      () => {
        held = true;
        open(row.dataset.doc as string);
        view("page");
      },
      { signal },
    );
  }
  for (const tab of tabs) {
    tab.addEventListener(
      "click",
      () => {
        held = true;
        view(tab.dataset.view as ProductView);
      },
      { signal },
    );
  }
  const undo = part("#s-undo");
  undo.addEventListener(
    "click",
    () => {
      undo.textContent = undo.textContent === "Undo" ? "Redo" : "Undo";
    },
    { signal },
  );

  const followAnswers = () => {
    const words = MUSE_REPLY[store.whoIsHe()];
    reply.textContent = words.chat;
    note.textContent = words.note;
  };
  followAnswers();
  signal.addEventListener("abort", store.subscribe(followAnswers));

  return {
    element: slot,
    set(next: ProductState, progress: number) {
      if (next !== state) {
        state = next;
        held = false;
        slot.dataset.state = next;
        open(next === "hints" ? "d413" : "d412");
      }
      // The view only exists on phones: on desktop every pane is on screen.
      if (!held) view(next === "hints" && progress >= 0.45 ? "page" : "chat");
      if (next !== "hints") return;
      const line = NEXT_LINE[store.whoIsHe()][store.doesSheTell()];
      typing.textContent = line.slice(0, Math.round(line.length * progress));
    },
  };
}
