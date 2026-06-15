/** Minimal Supabase Auth Admin API client (service role). */

type AdminUser = { id: string; email?: string };

type ListUsersResponse = { users: AdminUser[] };

type CreateUserResponse = { id: string; email?: string };

export class SupabaseAdminClient {
  constructor(
    private readonly supabaseUrl: string,
    private readonly serviceRoleKey: string,
  ) {}

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.serviceRoleKey}`,
      apikey: this.serviceRoleKey,
      "Content-Type": "application/json",
    };
  }

  async getUserIdByEmail(email: string): Promise<string | null> {
    // GoTrue's admin list endpoint paginates (default ~50/page). Walk pages so a
    // pre-existing dev user is found regardless of how many users accumulated;
    // otherwise ensureUser falls through to createUser and hits the unique-email
    // constraint, making bootstrap non-idempotent.
    const target = email.toLowerCase();
    for (let page = 1; page <= 100; page++) {
      const url = `${this.supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=200`;
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`list users failed (${res.status}): ${body}`);
      }
      const data = (await res.json()) as ListUsersResponse;
      const users = data.users ?? [];
      const match = users.find((u) => u.email?.toLowerCase() === target);
      if (match) return match.id;
      if (users.length === 0) break;
    }
    return null;
  }

  async createUser(email: string, password: string): Promise<string> {
    const url = `${this.supabaseUrl}/auth/v1/admin/users`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      // Idempotency safety net: if the user already exists (unique-email
      // conflict from a prior bootstrap), recover by looking it up instead of
      // failing the whole bootstrap.
      if (res.status === 422 || res.status === 409 || /already|duplicate|exists/i.test(body)) {
        const existing = await this.getUserIdByEmail(email);
        if (existing) return existing;
      }
      throw new Error(`create user failed (${res.status}): ${body}`);
    }
    const data = JSON.parse(body) as CreateUserResponse;
    if (!data.id) {
      throw new Error(`create user: missing id in response: ${body}`);
    }
    return data.id;
  }

  async ensureUser(email: string, password: string): Promise<string> {
    const existing = await this.getUserIdByEmail(email);
    if (existing) {
      return existing;
    }
    return this.createUser(email, password);
  }
}

export async function signInWithPassword(
  supabaseUrl: string,
  anonKey: string,
  email: string,
  password: string,
): Promise<string> {
  const url = `${supabaseUrl}/auth/v1/token?grant_type=password`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: anonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`sign in failed (${res.status}): ${body}`);
  }
  const data = JSON.parse(body) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("sign in: no access_token in response");
  }
  return data.access_token;
}
