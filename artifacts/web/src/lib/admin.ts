import { useQuery } from "@tanstack/react-query";

// Reads are public. Writes, collection runs, key changes and the Excel export
// need the administrator session (an HttpOnly cookie set by the server).
export const ADMIN_REQUIRED_EVENT = "nodeul:admin-required";
export const ADMIN_REQUIRED_MESSAGE = "관리자 로그인이 필요합니다. 로그인한 뒤 다시 시도해 주세요.";
export const ADMIN_SESSION_KEY = ["admin-session"] as const;

export function isAdminRequired(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || (error instanceof Error && /^HTTP 401\b/.test(error.message));
}

export function requestAdminLogin(reason: "required" | "manual" = "required"): void {
  window.dispatchEvent(new CustomEvent(ADMIN_REQUIRED_EVENT, { detail: { reason } }));
}

// For plain fetch calls: turn a 401 into the login prompt and a clear message.
export function ensureAuthorized(response: Response): void {
  if (response.status === 401) {
    requestAdminLogin("required");
    throw new Error(ADMIN_REQUIRED_MESSAGE);
  }
}

export function useAdminSession() {
  return useQuery<{ admin: boolean }>({
    queryKey: ADMIN_SESSION_KEY,
    queryFn: async () => {
      const response = await fetch("/api/admin/session");
      if (!response.ok) return { admin: false };
      return response.json();
    },
    staleTime: 60_000,
  });
}

export async function startAdminSession(password: string): Promise<string | null> {
  const response = await fetch("/api/admin/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (response.ok) return null;
  const data = await response.json().catch(() => ({}));
  return typeof data.error === "string" ? data.error : `로그인하지 못했습니다. (HTTP ${response.status})`;
}

export async function endAdminSession(): Promise<void> {
  await fetch("/api/admin/session", { method: "DELETE" });
}
