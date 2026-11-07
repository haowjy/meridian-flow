import { useEffect, useRef, useState } from "react";
import { bindStoryChoice, createCardStore } from "./card-store";
import { startFilm } from "./film";
import { createProductSlot, ProductPlaceholder } from "./ProductPlaceholder";
import { QuestionCard } from "./QuestionCard";
import { SECTIONS } from "./timeline";

const NIGHT = { "data-ui-theme": "dark" } as const;

export function LandingPage({ appOrigin }: { appOrigin: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [store] = useState(createCardStore);
  const startUrl = `${appOrigin}/signup`;

  useEffect(() => {
    const root = rootRef.current as HTMLElement;
    const controller = new AbortController();
    const slot = createProductSlot(root, store, controller.signal);
    const unbindStory = bindStoryChoice(root, store);
    const stopFilm = startFilm(root, store, slot);
    return () => {
      controller.abort();
      unbindStory();
      stopFilm();
    };
  }, [store]);

  return (
    <div className="landing" ref={rootRef}>
      <TopBar signInUrl={`${appOrigin}/login`} startUrl={startUrl} />
      <canvas id="sky" />

      <main id="top">
        <section className="film">
          <div className="stage">
            <div className="capshade" id="capshade" />

            <div className="hero" id="hero" {...NIGHT}>
              <h1>
                Build a world.<span>Bring it to life with a team of agents.</span>
              </h1>
              <p className="plain">An AI writing app for Royal Road and web serial writers.</p>
            </div>

            <div className="slotwrap">
              <ProductPlaceholder />
            </div>

            <div className="world" id="the-world" {...NIGHT}>
              <svg className="wlines" id="wlines" aria-hidden="true" />
              <WorldNote id="w0" title="The Harrow">
                Eleven months out of Sarn, past the edge of every chart she carries.
              </WorldNote>
              <WorldNote id="w1" title="Aldous Dell">
                Captain. A scar across his left palm, from chapter 9.
              </WorldNote>
              <WorldNote id="w2" title="Ise Varo">
                Navigator. Trusts her log over anyone’s memory.
              </WorldNote>
              <WorldNote id="w3" title="The stars">
                Nobody aboard can read them now but her.
              </WorldNote>
            </div>

            <article className="ms" id="chapter" {...NIGHT}>
              <p className="open">
                On the four hundred and twelfth night, the stars came back wrong.
              </p>
              <p>
                <span id="ty1">
                  Ise Varo went below and read her own handwriting.{" "}
                  <i>
                    Ninth night out of Sarn. A boy with a cargo hook opened the captain’s left palm
                    to the bone. Nine stitches. He did not make a sound.
                  </i>
                </span>
              </p>
              <p>
                <span id="ty2">
                  Above her the hatch scraped. Captain Dell came down the ladder with the lantern,
                  the way he had every night since Sarn, and asked her where they were.
                </span>
              </p>
              <p id="p3">
                <span id="ty3">
                  “Close,” she said, and watched him lift his right hand to hang the lamp on its
                  hook. The scar ran white across the palm.
                </span>
              </p>
              <p id="r-a">
                <span id="tra">
                  She looked down at her own handwriting. <i>Left hand.</i> A man who had only ever
                  seen that scar from across a table would get it backwards.
                </span>
              </p>
              <p id="r-b" hidden>
                <span id="trb">
                  She looked down at her own handwriting. <i>Left hand.</i> She had rewritten that
                  page from memory, in a week, with a fever. How much else in the log had she made
                  up?
                </span>
              </p>
            </article>

            <ol className="sub" {...NIGHT}>
              <li className="y" data-b="s1">
                <b>You</b>Chapter 412. She reads the log, he comes down the ladder, and neither of
                them says what they’re thinking.
              </li>
              <li data-b="s2">
                <b>Muse</b>Drafting it now. Keep typing, I’ll work around you.
              </li>
            </ol>

            <div className="team" id="the-team" {...NIGHT}>
              <svg className="lines" id="lines" aria-hidden="true" />
              <div className="hub" aria-hidden="true">
                <b>412. Dead Reckoning</b>Ise Varo went below and read her own handwriting. Above
                her the hatch scraped.
              </div>
              <Agent
                letter="R"
                name="Reader-sim"
                live="Reading as a serial reader"
                report="Attention dips in the log entry and comes back hard on the scar."
              />
              <Agent
                letter="C"
                name="Critic"
                live="Reading the scene"
                report="The lantern clause adds nothing. Cut it."
              />
              <Agent
                letter="W"
                name="Writer-helper"
                live="Drafting two shorter endings"
                report="Both endings are ready. The second stops on the scar."
              />
              <Agent
                letter="C"
                name="Continuity-checker"
                live="Reading Aldous Dell"
                report="Chapter 9 puts Dell’s scar on his left hand. This scene has the right."
                isKey
              />
            </div>

            <ol className="sub" {...NIGHT}>
              <li className="y" data-b="s3">
                <b>You</b>Have the team read it.
              </li>
              <li data-b="s4">
                <b>Muse</b>Continuity-checker found something I can’t settle for you.
              </li>
            </ol>

            <div className="ask" id="your-decisions">
              <QuestionCard store={store} />
            </div>

            <div className="twist" id="the-twist" {...NIGHT}>
              <blockquote id="tw-a">The man on the ladder was not Aldous Dell.</blockquote>
              <blockquote id="tw-b" hidden>
                The log was wrong, and she had written it.
              </blockquote>
            </div>

            <div className="dawn">
              <div className="cap" id="the-workspace" {...NIGHT}>
                <h2>Muse edits the old chapters while you write the next one.</h2>
                <p>
                  Critic, Continuity-checker and Reader-sim read your project and report back to
                  you. Muse and Writer write the prose into your manuscript, and you can type
                  anywhere while they work.
                </p>
              </div>
              <div className="workspot" />
            </div>
          </div>
        </section>

        <section className="end" id="end" {...NIGHT}>
          <h2>Chapter One</h2>
          {/* biome-ignore lint/a11y/useSemanticElements: it should feel like the page, not a form field. */}
          <div
            className="blank"
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            tabIndex={0}
            aria-label="Your first line"
            spellCheck={false}
          />
          <a className="go big" href={startUrl}>
            Start writing
          </a>
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
      <div className="row2">
        <PlayControl />
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
