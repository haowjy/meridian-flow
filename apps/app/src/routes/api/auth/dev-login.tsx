import { createFileRoute } from "@tanstack/react-router";
import { getConfig, sessionEncryption, validateConfig } from "@workos/authkit-session";
import { getAuthkit } from "@workos/authkit-tanstack-react-start";

import { getAppServerConfig } from "@/server/config";

/**
 * Dev-only WorkOS dev-login route.
 *
 * Performs REAL WorkOS password authentication for the fixed env user and
 * mints the SAME sealed AuthKit session cookie the normal `/api/auth/callback`
 * produces. Hard-gated: 404 unless NODE_ENV !== "production" AND the dev-login
 * env creds are present.
 */

type FailurePhase = "config validation" | "WorkOS password authentication";

const ENV_CHECKLIST = [
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
  "WORKOS_DEV_LOGIN_EMAIL",
  "WORKOS_DEV_LOGIN_PASSWORD",
] as const;

interface UnwrappedError {
  code: string | undefined;
  message: string;
  status: number | undefined;
}

interface DiagnosticInputs {
  email: string | undefined;
  clientId: string | undefined;
}

function unwrapError(error: unknown): UnwrappedError {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    const code = typeof e.code === "string" ? e.code : undefined;
    const status =
      typeof e.status === "number"
        ? e.status
        : typeof e.statusCode === "number"
          ? e.statusCode
          : undefined;
    const message =
      typeof e.message === "string" && e.message.length > 0 ? e.message : String(error);
    return { code, message, status };
  }
  return { code: undefined, message: String(error), status: undefined };
}

function likelyCauseHint(
  phase: FailurePhase,
  err: UnwrappedError,
  envPresent: Record<string, boolean>,
): string {
  const missing = ENV_CHECKLIST.filter((name) => !envPresent[name]);
  if (missing.length > 0) {
    return `Missing required env: ${missing.join(", ")}. Set it in the gitignored .env and restart the dev server.`;
  }

  const haystack = `${err.code ?? ""} ${err.message}`.toLowerCase();
  if (
    haystack.includes("authentication_failed") ||
    haystack.includes("invalid_credentials") ||
    haystack.includes("invalid credentials") ||
    haystack.includes("incorrect")
  ) {
    return "Wrong WORKOS_DEV_LOGIN_PASSWORD for this user — check the password in your gitignored .env.";
  }
  if (haystack.includes("user_not_found") || haystack.includes("entity_not_found")) {
    return "No such user in this WorkOS env — WORKOS_DEV_LOGIN_EMAIL has no matching user in this Staging env.";
  }
  if (
    haystack.includes("password") &&
    (haystack.includes("not_allowed") ||
      haystack.includes("not allowed") ||
      haystack.includes("not_enabled") ||
      haystack.includes("disabled") ||
      haystack.includes("unsupported"))
  ) {
    return "Password auth not enabled for this WorkOS env (AuthKit may be magic-link/SSO only). Enable password auth in the WorkOS dashboard.";
  }
  if (phase === "config validation") {
    return "WorkOS config is invalid or incomplete — verify WORKOS_API_KEY / WORKOS_CLIENT_ID / WORKOS_COOKIE_PASSWORD.";
  }
  return "Check the error above and the WorkOS dashboard (Staging env, user, and password auth settings).";
}

export function renderDevLoginDiagnostic(args: {
  phase: FailurePhase;
  error: UnwrappedError;
  inputs: DiagnosticInputs;
  envPresent: Record<string, boolean>;
}): string {
  const { phase, error, inputs, envPresent } = args;
  const checklist = ENV_CHECKLIST.map((name) => `  ${envPresent[name] ? "✓" : "✗"} ${name}`).join(
    "\n",
  );

  return [
    "dev-login failed",
    "================",
    "",
    `Phase: ${phase}`,
    "",
    "WorkOS error:",
    `  code:    ${error.code ?? "(none)"}`,
    `  message: ${error.message}`,
    `  status:  ${error.status ?? "(none)"}`,
    "",
    "Inputs (non-secret):",
    `  email:    ${inputs.email ?? "(unset)"}`,
    `  clientId: ${inputs.clientId ?? "(unset)"}`,
    "",
    "Env presence (presence only — values never shown):",
    checklist,
    "",
    "Likely cause / fix:",
    `  ${likelyCauseHint(phase, error, envPresent)}`,
    "",
  ].join("\n");
}

function statusForFailure(phase: FailurePhase): number {
  return phase === "WorkOS password authentication" ? 401 : 500;
}

function diagnosticResponse(args: {
  phase: FailurePhase;
  error: unknown;
  inputs: DiagnosticInputs;
  envPresent: Record<string, boolean>;
}): Response {
  const unwrapped = unwrapError(args.error);
  const body = renderDevLoginDiagnostic({
    phase: args.phase,
    error: unwrapped,
    inputs: args.inputs,
    envPresent: args.envPresent,
  });
  return new Response(body, {
    status: statusForFailure(args.phase),
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function handleDevLogin(): Promise<Response> {
  const { isProduction, workosDevLogin, workosClientId } = getAppServerConfig();
  const email = workosDevLogin?.email;
  const password = workosDevLogin?.password;

  if (isProduction || !email || !password) {
    return new Response("Not Found", { status: 404 });
  }

  const envPresent: Record<string, boolean> = {};
  for (const name of ENV_CHECKLIST) {
    envPresent[name] = Boolean(process.env[name]);
  }

  let clientId: string | undefined;

  try {
    await validateConfig();
  } catch (error) {
    return diagnosticResponse({
      phase: "config validation",
      error,
      inputs: { email, clientId: workosClientId ?? undefined },
      envPresent,
    });
  }

  try {
    const authkit = await getAuthkit();
    const workos = authkit.getWorkOS();
    clientId = getConfig("clientId");
    const cookiePassword = getConfig("cookiePassword");

    const { user, accessToken, refreshToken, impersonator } =
      await workos.userManagement.authenticateWithPassword({
        clientId,
        email,
        password,
      });

    const encryptedSession = await sessionEncryption.sealData(
      { user, accessToken, refreshToken, impersonator },
      { password: cookiePassword, ttl: 0 },
    );
    const { headers } = await authkit.saveSession(undefined, encryptedSession);

    const responseHeaders = new Headers({ Location: "/" });
    const setCookie = headers?.["Set-Cookie"];
    if (Array.isArray(setCookie)) {
      for (const cookie of setCookie) responseHeaders.append("Set-Cookie", cookie);
    } else if (typeof setCookie === "string") {
      responseHeaders.append("Set-Cookie", setCookie);
    }

    return new Response(null, { status: 302, headers: responseHeaders });
  } catch (error) {
    return diagnosticResponse({
      phase: "WorkOS password authentication",
      error,
      inputs: { email, clientId: clientId ?? workosClientId ?? undefined },
      envPresent,
    });
  }
}

export const Route = createFileRoute("/api/auth/dev-login")({
  server: {
    handlers: {
      GET: () => handleDevLogin(),
    },
  },
});
