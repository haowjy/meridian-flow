import { useEffect, useRef, useState } from "react";
import { createCardStore } from "./card-store";
import { startFilm } from "./film";
import { createProductSlot, ProductPlaceholder } from "./ProductPlaceholder";
import { QuestionCard } from "./QuestionCard";
import { CHARACTERS, type CharacterKey, END, PROLOGUE, SHEETS, SYSTEM } from "./story";
import { SECTIONS } from "./timeline";

const NIGHT = { "data-ui-theme": "dark" } as const;

/** Left to right as they sit round the fire: the ring in `forest.ts` puts Sigrun's row rightmost. */
const SEATED: readonly CharacterKey[] = ["maren", "oskar", "tam", "sigrun"];

export function LandingPage({ appOrigin }: { appOrigin: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [store] = useState(createCardStore);
  const startUrl = `${appOrigin}/signup`;

  useEffect(() => {
    const root = rootRef.current as HTMLElement;
    const controller = new AbortController();
    const slot = createProductSlot(root, store, controller.signal);
    const stopFilm = startFilm(root, store, slot);
    return () => {
      controller.abort();
      stopFilm();
    };
  }, [store]);

  return (
    <div className="landing" ref={rootRef}>
      <TopBar signInUrl={`${appOrigin}/login`} startUrl={startUrl} />
      <canvas id="sky" />
      <canvas id="treeline" />

      <main id="top">
        <section className="film">
          <div className="stage">
            <div className="capshade" id="capshade" />
            <div className="forest" id="forest" aria-hidden="true">
              <canvas />
            </div>
            <div className="sheets" id="sheets">
              {SEATED.map((key) => (
                <div className="sys sheet" key={key}>
                  {SHEETS[key].map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              ))}
            </div>
            <div className="walkers" id="walkers" aria-hidden="true">
              <b className="camp" />
              <b className="ward" />
              <b className="spark" />
              <b className="rune" />
              <b className="song" />
              <b className="hit" />
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>

            <div className="hero" id="hero" {...NIGHT}>
              <h1>
                Build a world.<span>Bring it to life with a team of agents.</span>
              </h1>
              <p className="plain">AI writing app for serial storytellers.</p>
            </div>

            <div className="slotwrap">
              <ProductPlaceholder />
            </div>

            <div className="flyer" id="flyer" aria-hidden="true">
              <i />
            </div>
            <div className="updraft" id="updraft" aria-hidden="true">
              <i />
            </div>

            <div className="world" id="the-world" {...NIGHT}>
              <svg className="wlines" id="wlines" aria-hidden="true" />
              {CHARACTERS.map((character, index) => (
                <WorldNote key={character.key} id={`w${index}`} title={character.name}>
                  {character.note}
                </WorldNote>
              ))}
            </div>

            <article className="ms" id="chapter" {...NIGHT}>
              <p className="open">{PROLOGUE.opening}</p>
              <p>
                <span id="ty1">{PROLOGUE.lines[0]}</span>
              </p>
              <p>
                <span id="ty2">{PROLOGUE.lines[1]}</span>
              </p>
              <p id="p3">
                <span id="ty3">{PROLOGUE.lines[2]}</span>
              </p>
              <p id="p4">
                <span id="ty4">{PROLOGUE.turn}</span>
              </p>
            </article>

            <ol className="sub" {...NIGHT}>
              <li className="y" data-b="s1">
                <b>You</b>Write the prologue. Four heroes, one beast, nine days north.
              </li>
              <li data-b="s2">
                <b>Muse</b>Drafting it now. Keep typing, I’ll work around you.
              </li>
            </ol>

            <div className="team" id="the-team" {...NIGHT}>
              <svg className="lines" id="lines" aria-hidden="true" />
              <div className="hub" aria-hidden="true">
                <b>Prologue</b>
                {PROLOGUE.opening}
              </div>
              <Agent
                letter="R"
                name="Reader-sim"
                live="Reading as a serial reader"
                report="Attention dips on the party introductions and comes back hard at the frozen army."
              />
              <Agent
                letter="C"
                name="Critic"
                live="Reading the climax"
                report="It’s night, but the sun shows through. Make it stars."
              />
              <Agent
                letter="W"
                name="Writer-helper"
                live="Drafting the four endings"
                report="Four endings ready, one for each survivor."
              />
              <Agent
                letter="C"
                name="Continuity-checker"
                live="Reading Tam"
                report="Tam’s page says his spark won’t catch in deep cold. Here it takes the dragon’s eye."
                isKey
              />
            </div>

            <ol className="sub" {...NIGHT}>
              <li className="y" data-b="s3">
                <b>You</b>Have the team read it.
              </li>
              <li data-b="s4">
                <b>Muse</b>Fixed it: Sigrun’s ward warms the air, so the spark catches. Writing the
                ending now.
              </li>
            </ol>

            <div className="twist" id="the-twist" {...NIGHT}>
              <div className="sys sys-big">
                <p>{SYSTEM.death}</p>
              </div>
            </div>
            <canvas className="flame" id="flame" />

            <div className="dawn">
              <div className="cap" id="knowledge-base" {...NIGHT}>
                <h2>Every dragon gets a page.</h2>
              </div>
              <div className="workspot" id="the-workspace" />
            </div>

            <div className="ask" id="your-decisions">
              <QuestionCard store={store} />
            </div>

            <div className="skill" id="skill" {...NIGHT}>
              <div className="sys sys-skill" role="status">
                {SYSTEM.skill.map((line) => (
                  <p key={line}>{line}</p>
                ))}
                <button type="button" className="sys-act" data-rekindle>
                  {SYSTEM.rekindle}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="end" id="end" {...NIGHT}>
          <form className="book" action={startUrl}>
            <label htmlFor="book">{END.question}</label>
            <div className="book-row">
              <input
                id="book"
                name="book"
                placeholder={END.placeholder}
                spellCheck={false}
                autoComplete="off"
              />
              <button type="submit" className="go big">
                {END.start}
              </button>
            </div>
          </form>
          <footer>Meridian Flow</footer>
        </section>
      </main>
    </div>
  );
}

function TopBar({ signInUrl, startUrl }: { signInUrl: string; startUrl: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const controller = new AbortController();
    const close = () => setMenuOpen(false);
    addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        close();
        menuButton.current?.focus();
      },
      { signal: controller.signal },
    );
    addEventListener(
      "pointerdown",
      (event) => {
        if (event.target instanceof Element && !event.target.closest("#menu, #here")) close();
      },
      { signal: controller.signal, passive: true },
    );
    return () => controller.abort();
  }, [menuOpen]);

  return (
    <header className="bar" {...NIGHT}>
      <div className="row">
        <a className="word" href="#top">
          Meridian Flow
        </a>
        <button
          type="button"
          className="here"
          id="here"
          ref={menuButton}
          aria-expanded={menuOpen}
          aria-controls="menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span id="herel">Jump to</span>
          <svg viewBox="0 0 10 6" aria-hidden="true">
            <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
        <PlayControl />
        <nav className="jumps" aria-label="Sections">
          {SECTIONS.map(({ hash, label }) => (
            <a key={hash} href={hash}>
              {label}
            </a>
          ))}
        </nav>
        <div className="acct">
          <a className="signin" href={signInUrl}>
            Sign in
          </a>
          <a className="go" href={startUrl}>
            Start writing
          </a>
        </div>
      </div>
      <nav className="menu jumps" id="menu" aria-label="Sections, phone" hidden={!menuOpen}>
        {SECTIONS.map(({ hash, label }) => (
          <a key={hash} href={hash} onClick={() => setMenuOpen(false)}>
            {label}
          </a>
        ))}
      </nav>
    </header>
  );
}

function PlayControl() {
  return (
    <button
      type="button"
      className="ctrl"
      data-play
      aria-label="Play the story"
      title="Play the story"
    >
      <PlayIcon />
    </button>
  );
}

function PlayIcon() {
  return (
    <svg className="ic" viewBox="0 0 12 12" aria-hidden="true">
      <path className="ic-play" d="M2 1l9 5-9 5z" />
      <path className="ic-pause" d="M2 1h3v10H2zM7 1h3v10H7z" />
    </svg>
  );
}

function WorldNote({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="wn">
      <div className="name">{title}</div>
      <p>
        <span id={id}>{children}</span>
      </p>
    </div>
  );
}

function Agent({
  letter,
  name,
  live,
  report,
  isKey,
}: {
  letter: string;
  name: string;
  live: string;
  report: string;
  isKey?: boolean;
}) {
  return (
    <div className={isKey ? "ag key" : "ag"}>
      <div className="ring">
        <span>{letter}</span>
      </div>
      <div className="name">{name}</div>
      <p className="live">{live}</p>
      <p className="rep">{report}</p>
    </div>
  );
}
