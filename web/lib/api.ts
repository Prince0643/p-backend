export class ApiError extends Error {}

export async function apiFetch<T = unknown>(
  path: string,
  apiKey: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      (data as { error?: string; message?: string })?.error ||
        (data as { error?: string; message?: string })?.message ||
        `Request failed (${res.status})`
    );
  }
  return data as T;
}
