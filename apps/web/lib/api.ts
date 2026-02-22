import { API_BASE } from "./config";
import { MOCK_API_ENABLED, mockApiFetch } from "./mock";
import { supabase } from "./supabase";

export async function apiFetch<T>(path: string, init?: RequestInit & { bandId?: string }): Promise<T> {
  if (MOCK_API_ENABLED) {
    return mockApiFetch<T>(path, init);
  }

  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;

  if (!token) {
    throw new Error("未ログインです");
  }

  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  if (init?.bandId) headers.set("x-band-id", init.bandId);

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error ?? `API Error ${res.status}`);
  }

  return json as T;
}
