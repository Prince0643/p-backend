export class ApiError extends Error {}
export class UnauthorizedError extends ApiError {}

export async function apiFetch<T = unknown>(
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      (data as { error?: string; message?: string })?.error ||
      (data as { error?: string; message?: string })?.message ||
      `Request failed (${res.status})`;
    if (res.status === 401) throw new UnauthorizedError(message);
    throw new ApiError(message);
  }
  return data as T;
}
