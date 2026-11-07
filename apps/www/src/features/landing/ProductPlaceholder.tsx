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
  PLACE_PAGES,
  PROLOGUE,
  QUESTION,
  SERIES_BIBLE,
  SURVIVED,
  SYSTEM,
  type WikiPage,
  WORLD_PAGES,
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
        <RailSection label="Manuscript" icon={SCROLL_QUILL}>
          <RailDocument id="dprologue" on>
            Prologue
          </RailDocument>
        </RailSection>
        <RailSection label="Knowledge Base" icon={LIBRARY}>
          <RailFolder name={CHARACTERS_FOLDER}>
            {CHARACTERS.map(({ key, name }) => (
              <RailDocument key={key} id={`d${key}`} nested>
                {name}
              </RailDocument>
            ))}
          </RailFolder>
          <RailFolder name={WORLD_FOLDER}>
            <RailDocument id="dbeast" rowId="s-beast-row" nested>
              The Beast
            </RailDocument>
            {WORLD_PAGES.map(({ key, name }) => (
              <RailDocument key={key} id={`d${key}`} nested>
                {name}
              </RailDocument>
            ))}
          </RailFolder>
          <RailFolder name={PLACES_FOLDER} closed>
            {PLACE_PAGES.map(({ key, name }) => (
              <RailDocument key={key} id={`d${key}`} nested>
                {name}
              </RailDocument>
            ))}
          </RailFolder>
          <RailDocument id="dbible">{BIBLE_NAME}</RailDocument>
        </RailSection>
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
            <p className="s-draft sys s-sys">{SYSTEM.tutorial}</p>
            <p className="s-only-hints">
              <span id="s-typing" />
              <i className="s-car" />
            </p>
          </article>
          {CHARACTERS.map((character) => (
            <article
              className="s-doc"
              id={`d${character.key}`}
              data-folder={`Knowledge Base › ${CHARACTERS_FOLDER}`}
              hidden
              key={character.key}
            >
              <div className="name">{character.name}</div>
              <PageBody page={character} statusId={`s-note-${character.key}`} />
            </article>
          ))}
          <article className="s-doc" id="dbeast" data-folder={WORLD_PATH} hidden>
            <div className="name">The Beast</div>
            <PageBody page={BEAST_PAGE} />
          </article>
          <article className="s-doc" id="ddragon" data-folder={WORLD_PATH} hidden>
            <div className="name">The Dragon</div>
            <figure className="s-fig">
              <i id="s-dragon" />
            </figure>
            <PageBody page={DRAGON_PAGE} />
          </article>
          {WORLD_PAGES.map(({ key, name, page }) => (
            <article className="s-doc" id={`d${key}`} data-folder={WORLD_PATH} hidden key={key}>
              <div className="name">{name}</div>
              <PageBody page={page} />
            </article>
          ))}
          <article className="s-doc" id="dbible" data-folder="Knowledge Base" hidden>
            <div className="name">{BIBLE_NAME}</div>
            <PageBody page={SERIES_BIBLE} />
          </article>
          {PLACE_PAGES.map(({ key, name, page }) => (
            <article className="s-doc" id={`d${key}`} data-folder={PLACES_PATH} hidden key={key}>
              <div className="name">{name}</div>
              <PageBody page={page} />
            </article>
          ))}
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
        <div className="s-take s-only-ask">
          <b>{QUESTION}</b>
          {CHARACTERS.map(({ key, name, pitch }) => (
            <div className="s-opt" key={key}>
              <b>{name}</b>
              <small>{pitch}</small>
            </div>
          ))}
          <div className="s-foot">
            <span>Skip</span>
          </div>
        </div>
        <div className="s-comp">
          <span className="s-ph s-only-team">Chime in</span>
          <span className="s-ph s-only-start s-only-hints">What’s next?</span>
          <div className="s-tools">
            <span className="s-pill">Muse</span>
            <span className="s-pill">Auto-apply</span>
            <u />
            <span className="s-send" aria-hidden="true">
              ↑
            </span>
          </div>
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

const CHARACTERS_FOLDER = "Characters";
const WORLD_FOLDER = "World";
const WORLD_PATH = `Knowledge Base › ${WORLD_FOLDER}`;
const PLACES_FOLDER = "Places";
const BIBLE_NAME = "Series Bible";
const PLACES_PATH = `Knowledge Base › ${PLACES_FOLDER}`;

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
  nested,
  children,
}: {
  id: string;
  rowId?: string;
  on?: boolean;
  /** Inside a Knowledge Base folder. */
  nested?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      id={rowId}
      className={`s-n in ${nested ? "deep" : ""} ${on ? "on" : ""}`}
      data-doc={id}
    >
      <span className="s-tw" />
      <Glyph paths={FILE_TEXT} />
      <span className="s-nm">{children}</span>
    </button>
  );
}

/** A tree section, drawn as the app's rail draws it: open, with its rows in a guided group. */
function RailSection({
  label,
  icon,
  children,
}: {
  label: string;
  icon: readonly string[];
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="s-h">
        <Glyph paths={CHEVRON} twistie />
        <Glyph paths={icon} />
        <span className="s-nm">{label}</span>
      </div>
      <div className="s-g">{children}</div>
    </>
  );
}

/** A folder the visitor can open and close, as in the app. `closed` folders start shut. */
function RailFolder({
  name,
  closed,
  children,
}: {
  name: string;
  closed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <button type="button" className="s-f" aria-expanded={!closed}>
        <Glyph paths={CHEVRON} twistie />
        <Glyph paths={FOLDER} shut />
        <Glyph paths={FOLDER_OPEN} />
        <span className="s-nm">{name}</span>
      </button>
      <div className="s-g" hidden={closed}>
        {children}
      </div>
    </>
  );
}

/** A lucide glyph at the tree's icon size, inlined because www imports no icon package. */
function Glyph({
  paths,
  twistie,
  shut,
}: {
  paths: readonly string[];
  twistie?: boolean;
  /** The closed-folder icon; CSS shows it in place of the open one. */
  shut?: boolean;
}) {
  return (
    <span className={twistie ? "s-tw" : shut ? "s-ic shut" : "s-ic"}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    </span>
  );
}

const CHEVRON = ["m9 18 6-6-6-6"];
const FOLDER = [
  "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
];
const FOLDER_OPEN = [
  "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2",
];
const FILE_TEXT = [
  "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
  "M14 2v5a1 1 0 0 0 1 1h5",
  "M10 9H8",
  "M16 13H8",
  "M16 17H8",
];
const LIBRARY = ["m16 6 4 14", "M12 6v14", "M8 8v12", "M4 4v16"];
const SCROLL_QUILL = [
  "M19 17v-5.5",
  "M14.5 3H4",
  "M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3",
  "M16.37 13.15a1.1 1.1 0 0 0 .78-.32l3.38-3.39a3.3 3.3 0 0 0-4.67-4.67L12.47 8.15a1.1 1.1 0 0 0-.32.78v3.67a.55.55 0 0 0 .55.55z",
  "M18.2 7.1 10.5 14.8",
];

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
  const dragonName = part("#s-beast-row .s-nm");
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
      const folder = event.target.closest<HTMLElement>(".s-f");
      if (folder) {
        const opening = folder.getAttribute("aria-expanded") !== "true";
        folder.setAttribute("aria-expanded", String(opening));
        (folder.nextElementSibling as HTMLElement).hidden = !opening;
        return;
      }
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
    const answer = store.getAnswer();
    part("#s-choice").textContent = answer ? characterName(answer) : "";
    reply.textContent = answer ? museReply(answer) : "";
    for (const { key } of CHARACTERS) {
      const fate = key === answer ? SURVIVED : FELL;
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
      dragonName.textContent = named ? "The Dragon" : "The Beast";
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
      const line = CHARACTERS.find(({ key }) => key === store.getAnswer())?.lastLine ?? "";
      typing.textContent = line.slice(0, Math.round(line.length * progress));
    },
  };
}
