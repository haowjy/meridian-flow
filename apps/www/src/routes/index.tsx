import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import type { FormEvent } from "react";
import { useId, useState } from "react";
import { submitWaitlistEmail } from "~/features/waitlist/waitlist.functions";
import { waitlistSubmissionSchema } from "~/features/waitlist/waitlist.schema";

const WAITLIST_SUCCESS_MESSAGE = "Thanks — you’re on the waitlist.";
const WAITLIST_ERROR_MESSAGE = "Something went wrong. Please try again.";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

type SubmitState =
  | { tone: "idle"; message: null; isValidationError: false }
  | { tone: "success"; message: string; isValidationError: false }
  | { tone: "error"; message: string; isValidationError: boolean };

const idleSubmitState: SubmitState = {
  tone: "idle",
  message: null,
  isValidationError: false,
};

const successSubmitState: SubmitState = {
  tone: "success",
  isValidationError: false,
  message: WAITLIST_SUCCESS_MESSAGE,
};

const serverErrorSubmitState: SubmitState = {
  tone: "error",
  isValidationError: false,
  message: WAITLIST_ERROR_MESSAGE,
};

function resolveSubmitStateFromSearch(search: Record<string, unknown>): SubmitState {
  if (search.waitlist === "success") {
    return successSubmitState;
  }

  if (search.waitlist === "error") {
    return serverErrorSubmitState;
  }

  return idleSubmitState;
}

function HomeComponent() {
  const search = Route.useSearch() as Record<string, unknown>;
  const submit = useServerFn(submitWaitlistEmail);
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>(() =>
    resolveSubmitStateFromSearch(search),
  );

  const emailHintId = useId();
  const statusId = useId();

  const hasEmailValidationError = submitState.tone === "error" && submitState.isValidationError;
  const emailDescribedBy = hasEmailValidationError ? `${emailHintId} ${statusId}` : emailHintId;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const parsed = waitlistSubmissionSchema.safeParse({ email });
    if (!parsed.success) {
      setSubmitState({
        tone: "error",
        isValidationError: true,
        message: "Please enter a valid email address.",
      });
      return;
    }

    setIsSubmitting(true);
    setSubmitState(idleSubmitState);

    try {
      await submit({ data: parsed.data });
      setEmail("");
      setSubmitState(successSubmitState);
    } catch {
      setSubmitState({
        tone: "error",
        isValidationError: false,
        message: WAITLIST_ERROR_MESSAGE,
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="relative z-10 flex h-dvh flex-col px-6 pt-6 pb-4 sm:px-14 sm:pt-10 sm:pb-8">
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
        <img
          className="mesh-blob-primary absolute right-[-280px] bottom-[-300px] block w-[620px] opacity-[0.16] contrast-[0.72] sm:right-[-640px] sm:bottom-[-760px] sm:w-[min(92vw,1480px)] sm:opacity-[0.18]"
          src="/assets/blobs_A_transparent.png"
          alt=""
        />
        <img
          className="mesh-blob-secondary absolute left-[-200px] top-[-150px] block w-[420px] opacity-[0.12] contrast-[0.72] sm:left-[-750px] sm:top-[-450px] sm:w-[1480px] sm:opacity-[0.13]"
          src="/assets/blobs_B_transparent.png"
          alt=""
        />
      </div>

      <div className="relative z-10 flex min-h-0 flex-1 flex-col w-full max-w-[1500px] mx-auto">
        <p className="shrink-0 max-w-[1240px] text-base font-[750] tracking-normal sm:text-[2rem]">
          Meridian
        </p>

        <section
          className="my-auto flex flex-col justify-center max-w-[1240px]"
          aria-labelledby="page-title"
        >
          <h1
            id="page-title"
            className="m-0 font-[‘Fraunces’,Georgia,serif] text-[clamp(2.2rem,7vw,4.6rem)] leading-[0.98] font-[750] tracking-normal sm:text-[clamp(3.5rem,7.5vw,8.4rem)]"
          >
            Automating the work between raw input and trusted results.
          </h1>

          <p className="mt-4 max-w-[760px] text-[clamp(0.95rem,1.6vw,1.35rem)] leading-[1.5] text-[#5b6f67] sm:mt-6">
            Agent-driven workflows for teams moving from source data to analysis, evidence,
            artifacts, review, and publication-ready outputs.
          </p>

          <div className="mt-6 sm:mt-8">
            <p className="mb-2 text-sm font-semibold tracking-[0.01em] text-[#124839]">
              Join the waitlist
            </p>
            <form
              className="flex w-full flex-col gap-3 sm:max-w-[760px] sm:flex-row sm:items-center"
              action={submitWaitlistEmail.url}
              method="post"
              onSubmit={handleSubmit}
              aria-describedby={statusId}
            >
              <input
                id="waitlist-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (hasEmailValidationError) {
                    setSubmitState(idleSubmitState);
                  }
                }}
                placeholder="you@example.com"
                className="h-[48px] w-full rounded-[8px] border border-[#dce7e2] bg-white px-4 text-base text-[#10211c] shadow-[0_12px_28px_rgba(18,72,57,0.08)] outline-none transition focus:border-[#1d6b57] focus:ring-3 focus:ring-[#1d6b5738] sm:flex-1"
                aria-describedby={emailDescribedBy}
                aria-invalid={hasEmailValidationError ? true : undefined}
                disabled={isSubmitting}
              />
              <button
                type="submit"
                className="inline-flex h-[48px] w-full shrink-0 items-center justify-center rounded-[8px] border border-[#1d6b57] bg-[#1d6b57] px-7 text-base font-bold text-white shadow-[0_12px_28px_rgba(18,72,57,0.14),inset_0_1px_0_rgba(255,255,255,0.14)] transition hover:border-[#124839] hover:bg-[#124839] hover:shadow-[0_16px_34px_rgba(18,72,57,0.18),inset_0_1px_0_rgba(255,255,255,0.12)] focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[#1d6b5738] motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Joining…" : "Join waitlist"}
              </button>
            </form>
            <p id={emailHintId} className="mt-1.5 text-sm text-[#5b6f67]">
              We’ll only use your email for waitlist updates.
            </p>
            <p
              id={statusId}
              className="mt-1 min-h-5 text-sm"
              aria-live="polite"
              aria-atomic="true"
              role="status"
            >
              {submitState.message ? (
                <span className={submitState.tone === "error" ? "text-rose-700" : "text-[#124839]"}>
                  {submitState.message}
                </span>
              ) : null}
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
