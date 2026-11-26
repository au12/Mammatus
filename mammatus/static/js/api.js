// JSON API client. Unsafe methods carry the X-Mammatus header the server requires (CSRF guard).

export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

const listeners = new Set();
export function onUnauthorized(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export async function api(path, { method = "GET", body, signal, quiet = false } = {}) {
  const headers = { "X-Mammatus": "1" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let resp;
  try {
    resp = await fetch(`/api${path}`, {
      method, credentials: "same-origin", headers, signal,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiError(navigator.onLine ? "Can't reach the server." : "You're offline.", 0);
  }
  const ct = resp.headers.get("content-type") || "";
  const data = ct.includes("json") ? await resp.json().catch(() => null) : await resp.text();
  if (resp.status === 401 && !path.startsWith("/auth/") && !quiet) listeners.forEach((fn) => fn());
  if (!resp.ok) throw new ApiError((data && data.detail) || resp.statusText || "Request failed", resp.status, data);
  return data;
}

export const get = (p, o) => api(p, o);
export const post = (p, body, o) => api(p, { ...o, method: "POST", body: body ?? {} });
export const patch = (p, body, o) => api(p, { ...o, method: "PATCH", body });
export const put = (p, body, o) => api(p, { ...o, method: "PUT", body });
export const del = (p, o) => api(p, { ...o, method: "DELETE" });
