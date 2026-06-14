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
    const url = `${this.supabaseUrl}/auth/v1/admin/users`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`list users failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as ListUsersResponse;
    const match = data.users?.find((u) => u.email === email);
    return match?.id ?? null;
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
