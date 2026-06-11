import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getRequestHeader, getRequestHost, getRequestProtocol } from "@tanstack/react-start/server";

export const SUPABASE_ACCESS_TOKEN_COOKIE = "meridian.sb.access-token";
export const SUPABASE_REFRESH_TOKEN_COOKIE = "meridian.sb.refresh-token";

export interface CurrentUser {
  userId: string;
  email: string | null;
}

let supabase: SupabaseClient | undefined;

function getSupabase(): SupabaseClient {
  if (supabase) return supabase;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  }

  supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return supabase;
}

export function parseCookieHeader(cookieHeader: string | null | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  for (const cookie of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = cookie.trim().split("=");
    if (!rawName) continue;
    try {
      cookies[rawName] = decodeURIComponent(rawValue.join("="));
    } catch {
      cookies[rawName] = rawValue.join("=");
    }
  }

  return cookies;
}

export async function resolveCurrentUserFromCookieHeader(
  cookieHeader: string | null | undefined,
): Promise<CurrentUser | null> {
  const accessToken = parseCookieHeader(cookieHeader)[SUPABASE_ACCESS_TOKEN_COOKIE];
  if (!accessToken) return null;

  const { data, error } = await getSupabase().auth.getUser(accessToken);
  if (error || !data.user) return null;

  return {
    userId: data.user.id,
    email: data.user.email ?? null,
  };
}

export async function resolveCurrentUserFromRequest(): Promise<CurrentUser | null> {
  return resolveCurrentUserFromCookieHeader(getRequestHeader("cookie"));
}

export function serializeSupabaseSessionCookies(input: {
  accessToken: string;
  refreshToken: string;
  host: string;
  protocol: string;
}): string[] {
  const attributes = [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${60 * 60 * 24 * 7}`,
    ...cookieDomainAttributes(input.host),
    ...(input.protocol === "https" ? ["Secure"] : []),
  ];

  return [
    `${SUPABASE_ACCESS_TOKEN_COOKIE}=${encodeURIComponent(input.accessToken)}; ${attributes.join("; ")}`,
    `${SUPABASE_REFRESH_TOKEN_COOKIE}=${encodeURIComponent(input.refreshToken)}; ${attributes.join("; ")}`,
  ];
}

export function serializeClearedSupabaseSessionCookies(): string[] {
  const attributes = ["Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  return [
    `${SUPABASE_ACCESS_TOKEN_COOKIE}=; ${attributes.join("; ")}`,
    `${SUPABASE_REFRESH_TOKEN_COOKIE}=; ${attributes.join("; ")}`,
  ];
}

export function currentRequestCookieContext(): { host: string; protocol: string } {
  return {
    host: getRequestHost({ xForwardedHost: true }) ?? getRequestHeader("host") ?? "localhost",
    protocol: getRequestProtocol({ xForwardedProto: true }) ?? "http",
  };
}

export async function signInTestUser(): Promise<{ accessToken: string; refreshToken: string }> {
  const email = process.env.TEST_USER_EMAIL;
  const password = process.env.TEST_USER_PASSWORD;
  if (!email || !password) {
    throw new Error("Missing TEST_USER_EMAIL or TEST_USER_PASSWORD");
  }

  const { data, error } = await getSupabase().auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.session) throw new Error("Supabase password grant did not return a session");

  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
  };
}

export function devLoginEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    Boolean(process.env.TEST_USER_EMAIL) &&
    Boolean(process.env.TEST_USER_PASSWORD) &&
    Boolean(process.env.SUPABASE_URL) &&
    Boolean(process.env.SUPABASE_ANON_KEY)
  );
}

function cookieDomainAttributes(host: string): string[] {
  const hostname = host.split(":")[0] ?? host;
  if (hostname === "app.meridian.localhost" || hostname.endsWith(".app.meridian.localhost")) {
    return ["Domain=.meridian.localhost"];
  }
  if (hostname === "meridian.localhost" || hostname.endsWith(".meridian.localhost")) {
    return ["Domain=.meridian.localhost"];
  }
  return [];
}
