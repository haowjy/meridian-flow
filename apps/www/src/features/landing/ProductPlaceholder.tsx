import type { CardStore } from "./card-store";
import { LORE_ARRIVES } from "./dragon-actor";
import {
  ALIVE,
  BEAST_PAGE,
  CHARACTERS,
  characterName,
  DRAGON_PAGE,
  FELL,
  museReply,
  NOTES,
  PROLOGUE,
  SURVIVED,
  type WikiPage,
} from "./story";

/**
 * A drawing of the real app, to be replaced by captured footage. The page only
 * calls `set` from `createProductSlot`; footage would seek there, and the box, the
 * night grade and the motion stay.
 */
export function ProductPlaceholder() {
  return (
    <div className="slot" id="slot" data-state="start" data-view="chat">
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
        <RailDocument id="dbeast" rowId="s-beast-row">
          The Beast
        </RailDocument>
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
            <p className="s-only-start">
              <i className="s-car" />
            </p>
            <p className="s-draft">{PROLOGUE.opening}</p>
            {PROLOGUE.lines.map((line) => (
              <p className="s-draft" key={line}>
                {line}
              </p>
            ))}
            <p className="s-draft">{PROLOGUE.turn}</p>
            <p className="s-only-hints">
              <span id="s-typing" />
              <i className="s-car" />
            </p>
          </article>
          {CHARACTERS.map((character) => (
            <article
              className="s-doc"
              id={`d${character.key}`}
              data-folder="Knowledge Base"
              hidden
              key={character.key}
            >
              <div className="name">{character.name}</div>
              <PageBody page={character} statusId={`s-note-${character.key}`} />
            </article>
          ))}
          <article className="s-doc" id="dbeast" data-folder="Knowledge Base" hidden>
            <div className="name">The Beast</div>
            <PageBody page={BEAST_PAGE} />
          </article>
          <article className="s-doc" id="ddragon" data-folder="Knowledge Base" hidden>
            <div className="name">The Dragon</div>
            <figure className="s-fig">
              <i id="s-dragon" />
            </figure>
            <PageBody page={DRAGON_PAGE} />
          </article>
        </div>
      </div>
      <aside className="s-chat" aria-label="Chat">
        <div className="s-ct">
          Prologue <span className="s-only-team">2 running</span>
        </div>
        <div className="s-msgs">
          <div className="s-me s-only-start">Let’s write the prologue.</div>
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
        <div className="s-comp">
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

const CHARACTER_NAME = new RegExp(`\\b(${CHARACTERS.map(({ name }) => name).join("|")})\\b`);

/** A page's text with the party's names linked to their pages, the way a wiki links them. */
function Linked({ text }: { text: string }) {
  let offset = 0;
  return text.split(CHARACTER_NAME).map((part) => {
    const at = offset;
    offset += part.length;
    const character = CHARACTERS.find(({ name }) => name === part);
    return character ? (
      <button type="button" className="s-link" data-open={`d${character.key}`} key={at}>
        {part}
      </button>
    ) : (
      part
    );
  });
}

function PageBody({ page, statusId }: { page: WikiPage; statusId?: string }) {
  return (
    <>
      <p>
        <Linked text={page.lead} />
      </p>
      <ul className="s-facts">
        {statusId ? (
          <li>
            <b>Status:</b> <span id={statusId}>{ALIVE}</span>
          </li>
        ) : null}
        {page.facts.map(([label, value]) => (
          <li key={label}>
            <b>{label}:</b> {value}
          </li>
        ))}
      </ul>
      {page.sections.map(([heading, body]) => (
        <section className={heading === NOTES ? "s-notes" : undefined} key={heading}>
          <h3>{heading}</h3>
          {typeof body === "string" ? (
            <p>
              <Linked text={body} />
            </p>
          ) : (
            body.map(([label, text]) => (
              <p key={label}>
                <b>
                  <Linked text={label} />
                </b>{" "}
                <Linked text={text} />
              </p>
            ))
          )}
        </section>
      ))}
    </>
  );
}

function RailDocument({
  id,
  rowId,
  on,
  children,
}: {
  id: string;
  rowId?: string;
  on?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button type="button" id={rowId} className={`s-n in ${on ? "on" : ""}`} data-doc={id}>
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
type ProductState = "start" | "team" | "lore" | "ask" | "hints";
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
  const dragonRow = part("#s-beast-row");
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

  slot.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLElement>("[data-doc], [data-open]");
      if (!link) return;
      held = true;
      open((link.dataset.doc ?? link.dataset.open) as string);
      view("page");
    },
    { signal },
  );
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
      const fate = key === protagonist ? SURVIVED : FELL;
      part(`#s-note-${key}`).textContent = state === "hints" ? fate : ALIVE;
    }
  };
  followAnswers();
  signal.addEventListener("abort", store.subscribe(followAnswers));

  return {
    element: slot,
    set(next: ProductState, progress: number) {
      const arrived = next === "lore" && progress >= LORE_ARRIVES;
      const named = next === "ask" || next === "hints" || arrived;
      dragonRow.textContent = named ? "The Dragon" : "The Beast";
      dragonRow.dataset.doc = named ? "ddragon" : "dbeast";
      if (next !== state) {
        state = next;
        held = false;
        slot.dataset.state = next;
        followAnswers();
        open("dprologue");
      }
      if (next === "lore" && !held) open(arrived ? "ddragon" : "dprologue");
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
