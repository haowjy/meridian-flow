import type { UserId } from "@meridian/contracts/runtime";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { HTTPError } from "nitro/h3";

export interface ResolvedUser {
  userId: UserId;
  email?: string | null;
}

const ACCESS_TOKEN_COOKIE = "meridian.sb.access-token";

let supabase: SupabaseClient | undefined;

function getSupabase(): SupabaseClient {
  if (supabase) return supabase;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY for request auth");
  }

  supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return supabase;
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;

  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
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

function accessTokenCookie(request: Request): string | null {
  return parseCookies(request.headers.get("cookie"))[ACCESS_TOKEN_COOKIE] ?? null;
}

async function resolveJwt(jwt: string): Promise<ResolvedUser | null> {
  const { data, error } = await getSupabase().auth.getUser(jwt);
  if (error || !data.user) return null;

  return {
    userId: data.user.id as UserId,
    email: data.user.email ?? null,
  };
}

export async function resolveUser(request: Request): Promise<ResolvedUser | null> {
  const token = bearerToken(request) ?? accessTokenCookie(request);
  if (!token) return null;
  return resolveJwt(token);
}

export async function requireUser(request: Request): Promise<ResolvedUser> {
  const user = await resolveUser(request);
  if (!user) {
    throw new HTTPError({ status: 401, message: "Unauthorized" });
  }
  return user;
}
