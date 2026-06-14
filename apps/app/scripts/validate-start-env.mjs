#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

const PLACEHOLDER_PATTERNS = {
  SUPABASE_URL: [/^empty$/i, /^https?:\/\/127\.0\.0\.1/, /^https?:\/\/localhost/],
  SUPABASE_ANON_KEY: [/^empty$/i, /^anon[_-]?key$/i, /^dev-/i],
  MERIDIAN_API_ORIGIN: [/^empty$/i],
};

function isPlaceholder(name, value) {
  const patterns = PLACEHOLDER_PATTERNS[name] ?? [];
  return patterns.some((pattern) => pattern.test(value));
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
    if (isPlaceholder(name, trimmed)) {
      issues.push({ name, issue: "must not use a development placeholder value" });
      return null;
    }

    return trimmed;
  }

  const supabaseUrl = readRequiredEnv("SUPABASE_URL");
  readRequiredEnv("SUPABASE_ANON_KEY");
  const meridianApiOrigin = readRequiredEnv("MERIDIAN_API_ORIGIN");

  if (supabaseUrl) requireHttpUrl("SUPABASE_URL", supabaseUrl, issues);
  if (meridianApiOrigin) requireHttpUrl("MERIDIAN_API_ORIGIN", meridianApiOrigin, issues);

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
