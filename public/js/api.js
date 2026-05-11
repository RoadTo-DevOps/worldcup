const TOKEN_KEY = 'worldcup.pick.token';

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let body = options.body;
  if (body && typeof body !== 'string') {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }
  const response = await fetch(path, {
    ...options,
    headers,
    body
  });
  const payload = await response.json().catch(() => ({
    success: false,
    message: response.statusText || 'Request failed'
  }));
  if (!response.ok || payload.success === false) {
    throw new ApiError(payload.message || 'Request failed', response.status, payload);
  }
  return payload.data;
}
