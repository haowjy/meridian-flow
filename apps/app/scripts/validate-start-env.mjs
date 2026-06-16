#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

const PLACEHOLDER_PATTERNS = {
  SUPABASE_URL: [/^empty$/i, /^https?:\/\/127\.0\.0\.1/, /^https?:\/\/localhost/],
  SUPABASE_ANON_KEY: [/^empty$/i, /^anon[_-]?key$/i, /^dev-/i],
  MERIDIAN_API_ORIGIN: [/^empty$/i],
  WORKOS_API_KEY: [/^dev-workos-key$/i, /^empty$/i],
  WORKOS_CLIENT_ID: [/^dev-workos-client$/i, /^client_\.\.\.$/i, /^client_ci$/i, /^empty$/i],
  WORKOS_COOKIE_PASSWORD: [/^empty$/i],
  WORKOS_REDIRECT_URI: [/^empty$/i],
};

const WORKOS_TEST_API_KEY_PATTERN = /^sk_test_/i;

function isPlaceholder(name, value, options = {}) {
  const patterns = PLACEHOLDER_PATTERNS[name] ?? [];
  if (patterns.some((pattern) => pattern.test(value))) return true;
  return (
    name === "WORKOS_API_KEY" &&
    !options.allowWorkosTestApiKey &&
    WORKOS_TEST_API_KEY_PATTERN.test(value)
  );
}

function requireHttpUrl(name, value, issues) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      issues.push({ name, issue: "must use http:// or https://" });
    }
  } catch {
    issues.push({ name, issue: "must be a valid absolute URL" });
  }
}

export function validateStartEnv(env = process.env) {
  const isProduction = env.NODE_ENV === "production";
  const allowWorkosTestApiKey = env.APP_ENV === "staging";
  if (!isProduction) {
    return { ok: true, skipped: true, issues: [] };
  }

  const issues = [];

  function readRequiredEnv(name) {
    const value = env[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      issues.push({ name, issue: "is missing or empty" });
      return null;
    }

    const trimmed = value.trim();
    if (isPlaceholder(name, trimmed, { allowWorkosTestApiKey })) {
      issues.push({ name, issue: "must not use a development placeholder value" });
      return null;
    }

    return trimmed;
  }

  const supabaseUrl = readRequiredEnv("SUPABASE_URL");
  readRequiredEnv("SUPABASE_ANON_KEY");
  const meridianApiOrigin = readRequiredEnv("MERIDIAN_API_ORIGIN");

  readRequiredEnv("WORKOS_API_KEY");
  readRequiredEnv("WORKOS_CLIENT_ID");
  const workosCookiePassword = readRequiredEnv("WORKOS_COOKIE_PASSWORD");
  const workosRedirectUri = readRequiredEnv("WORKOS_REDIRECT_URI");

  if (supabaseUrl) requireHttpUrl("SUPABASE_URL", supabaseUrl, issues);
  if (meridianApiOrigin) requireHttpUrl("MERIDIAN_API_ORIGIN", meridianApiOrigin, issues);

  if (workosCookiePassword && workosCookiePassword.length < 32) {
    issues.push({
      name: "WORKOS_COOKIE_PASSWORD",
      issue: "must be at least 32 characters",
    });
  }

  if (workosRedirectUri) {
    try {
      const parsed = new URL(workosRedirectUri);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        issues.push({
          name: "WORKOS_REDIRECT_URI",
          issue: "must use http:// or https://",
        });
      }
      if (parsed.pathname !== "/api/auth/callback") {
        issues.push({
          name: "WORKOS_REDIRECT_URI",
          issue: "must use the /api/auth/callback path",
        });
      }
    } catch {
      issues.push({
        name: "WORKOS_REDIRECT_URI",
        issue: "must be a valid absolute URL",
      });
    }
  }

  return { ok: issues.length === 0, skipped: false, issues };
}

function runCli() {
  const result = validateStartEnv(process.env);

  if (result.skipped) {
    console.log(
      "[@meridian/app] Skipping production start env validation (NODE_ENV is not production).",
    );
    return 0;
  }

  if (!result.ok) {
    console.error("[@meridian/app] Production start blocked: invalid environment configuration.");
    console.error("Fix the following environment variables before starting:");
    for (const { name, issue } of result.issues) {
      console.error(`  - ${name}: ${issue}`);
    }
    return 1;
  }

  console.log("[@meridian/app] Production start env validation passed.");
  return 0;
}

const isDirectExecution =
  process.argv[1] != null && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  process.exit(runCli());
}
