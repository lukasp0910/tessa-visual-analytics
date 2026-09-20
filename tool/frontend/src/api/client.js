const PAGE_ORIGIN = (typeof window !== 'undefined' && window.location && window.location.origin)
  ? window.location.origin
  : null;

// Prefer same-origin requests so the static frontend and API served by FastAPI share cookies/origin.
const DEFAULT_BASE_URL = PAGE_ORIGIN || 'http://127.0.0.1:8000';

let baseUrl = DEFAULT_BASE_URL;

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

export function setBaseUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    baseUrl = DEFAULT_BASE_URL;
    return baseUrl;
  }
  try {
    const normalized = new URL(url, DEFAULT_BASE_URL).toString();
    baseUrl = normalized.replace(/\/$/, '');
  } catch {
    baseUrl = DEFAULT_BASE_URL;
  }
  return baseUrl;
}

export function getBaseUrl() {
  return baseUrl;
}

export function resolveUrl(path = '') {
  if (typeof path !== 'string') {
    throw new TypeError('Path must be a string');
  }
  if (!path) {
    return baseUrl;
  }
  return new URL(path, baseUrl).toString();
}

function normalizeHeaders(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const result = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  return { ...headers };
}

function shouldStringifyBody(body) {
  if (body == null) return false;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return false;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return false;
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return false;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return false;
  return isObject(body) || Array.isArray(body);
}

export async function requestJson(path, options = {}) {
  const url = resolveUrl(path);
  const {
    method = options.body ? 'POST' : 'GET',
    body,
    headers,
    skipStringify = false,
    ...rest
  } = options;

  const finalHeaders = normalizeHeaders(headers);
  const init = {
    ...rest,
    method: method.toUpperCase(),
    headers: finalHeaders,
  };

  if (body !== undefined) {
    if (!skipStringify && shouldStringifyBody(body)) {
      if (!finalHeaders['Content-Type'] && !finalHeaders['content-type']) {
        finalHeaders['Content-Type'] = 'application/json';
      }
      init.body = JSON.stringify(body);
    } else {
      init.body = body;
    }
  }

  if (!finalHeaders['Accept'] && !finalHeaders['accept']) {
    finalHeaders['Accept'] = 'application/json';
  }

  const response = await fetch(url, init);
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    error.url = url;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  // Attempt to parse JSON even when the header is missing.
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

export async function ping(path = '/api/health') {
  try {
    await requestJson(path, { method: 'GET' });
    return true;
  } catch (error) {
    console.warn('[api:client] Health check failed:', error);
    return false;
  }
}

export const client = {
  get baseUrl() {
    return getBaseUrl();
  },
  setBaseUrl,
  requestJson,
  resolveUrl,
  ping,
};

export default client;
