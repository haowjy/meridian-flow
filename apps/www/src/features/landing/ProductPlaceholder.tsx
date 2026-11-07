import type { CardStore } from "./card-store";
import { LORE_ARRIVES } from "./dragon-actor";
import { CHARACTERS, characterName, FELL, museReply, PROLOGUE, QUESTION, SURVIVED } from "./story";

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
        <RailDocument id="dprologue" on>
          Prologue
        </RailDocument>
        <div className="s-h">KNOWLEDGE BASE</div>
        {CHARACTERS.map(({ key, name }) => (
          <RailDocument key={key} id={`d${key}`}>
            {name}
          </RailDocument>
        ))}
        <RailDocument id="ddragon">The Beast</RailDocument>
      </aside>
      <div className="s-pane">
        <div className="s-top">
          <span id="s-folder">Manuscript</span>
          <span>›</span>
          <b id="s-name">Prologue</b>
        </div>
        <div className="s-body">
          <article className="s-doc" id="dprologue">
            <div className="name">Prologue</div>
            <p>{PROLOGUE.opening}</p>
            {PROLOGUE.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p>{PROLOGUE.turn}</p>
            <p className="s-only-hints">
              <span id="s-typing" />
              <i className="s-car" />
            </p>
          </article>
          {CHARACTERS.map(({ key, name, note, facts, sections }) => (
            <article className="s-doc" id={`d${key}`} data-folder="Knowledge Base" hidden key={key}>
              <div className="name">{name}</div>
              <p className="s-only-hints s-status" id={`s-note-${key}`} />
              <p>{note}</p>
              <dl className="s-facts">
                {facts.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              {sections.map(([heading, text]) => (
                <section key={heading}>
                  <h3>{heading}</h3>
                  <p>{text}</p>
                </section>
              ))}
            </article>
          ))}
          <article className="s-doc" id="ddragon" data-folder="Knowledge Base" hidden>
            <div className="name">The Dragon</div>
            <figure className="s-fig">
              <i id="s-dragon" />
            </figure>
            <p>The beast in the Greenlands. Nobody who went north was told what it was.</p>
          </article>
        </div>
      </div>
      <aside className="s-chat" aria-label="Chat">
        <div className="s-ct">
          Prologue <span className="s-only-team">2 running</span>
        </div>
        <div className="s-msgs">
          <div className="s-me s-only-team">Have the team read it.</div>
          <HelperCard letter="C" name="Continuity-checker" scope="Prologue" line="Finished" done />
          <HelperCard letter="C" name="Critic" scope="Prologue" line="Reading the scene" />
          <HelperCard letter="R" name="Reader-sim" scope="Prologue" line="Finished" done />
          <HelperCard
            letter="W"
            name="Writer-helper"
            scope="Ending"
            line="Drafting two shorter endings"
          />
          <HelperCard
            letter="C"
            name="Continuity-checker"
            scope="All four pages"
            line="Finished"
            done
            hints
          />
          <HelperCard letter="R" name="Reader-sim" scope="Prologue" line="Finished" done hints />
          <HelperCard letter="C" name="Critic" scope="Prologue" line="Reading the scene" hints />
          <div className="s-me s-only-hints s-first" id="s-choice" />
          <div className="s-ai s-only-hints" id="s-reply" />
          <div className="s-ed big s-only-hints">
            <span>Edited 5 documents</span>
            <button type="button" id="s-undo">
              Undo
            </button>
            <small>Prologue, Tam, Sigrun, Oskar, Maren</small>
          </div>
        </div>
        <div className="s-take s-only-team">
          <b>{QUESTION}</b>
          {CHARACTERS.map(({ key, name, pitch }) => (
            <div className="s-opt" key={key}>
              <b>{name}</b>
              <small>{pitch}</small>
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
  );
}

function RailDocument({
  id,
  on,
  children,
}: {
  id: string;
  on?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className={`s-n in ${on ? "on" : ""}`} data-doc={id}>
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

type ProductView = "project" | "page" | "chat";
type ProductState = "team" | "lore" | "hints";
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
  const dragonRow = part(".s-n[data-doc='ddragon']");
  let state: ProductState | null = null;
  // Once the visitor picks a document or tab, autoplay leaves that view alone.
  let held = false;

  const open = (id: string) => {
    for (const doc of documents) doc.hidden = doc.id !== id;
    for (const row of railDocuments) row.classList.toggle("on", row.dataset.doc === id);
    const doc = part(`#${id}`);
    part("#s-folder").textContent = doc.dataset.folder ?? "Manuscript";
    part("#s-name").textContent = doc.querySelector(".name")?.textContent ?? "";
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
    const protagonist = store.protagonist();
    part("#s-choice").textContent = characterName(protagonist);
    reply.textContent = museReply(protagonist);
    for (const { key } of CHARACTERS) {
      part(`#s-note-${key}`).textContent = key === protagonist ? SURVIVED : FELL;
    }
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
        open("dprologue");
      }
      const arrived = next === "lore" && progress >= LORE_ARRIVES;
      if (next === "lore" && !held) open(arrived ? "ddragon" : "dprologue");
      dragonRow.textContent = next === "hints" || arrived ? "The Dragon" : "The Beast";
      dragonRow.classList.toggle("s-landed", arrived && progress < 0.8);
      // The view only exists on phones: on desktop every pane is on screen.
      if (!held) view((next === "hints" && progress >= 0.45) || arrived ? "page" : "chat");
      if (next !== "hints") return;
      const protagonist = CHARACTERS.find(({ key }) => key === store.protagonist());
      const line = protagonist?.lastLine ?? "";
      typing.textContent = line.slice(0, Math.round(line.length * progress));
    },
  };
}
