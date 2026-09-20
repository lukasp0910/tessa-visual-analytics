export function qs(selector, root = document) {
  if (!selector || !root) return null;
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  if (!selector || !root) return [];
  return Array.from(root.querySelectorAll(selector));
}

export function byId(id, root = document) {
  if (!id || !root) return null;
  return root.getElementById(id);
}

export function setStatusMessage(element, message, { tone = 'info', isError = false } = {}) {
  if (!element) return;
  const text = typeof message === 'string' ? message : '';
  element.textContent = text;
  if (element.dataset) {
    element.dataset.tone = isError ? 'error' : tone;
  }
  element.classList.toggle('text-red-600', isError || tone === 'error');
  element.classList.toggle('text-green-600', tone === 'success');
}

export function clearChildren(element) {
  if (!element) return;
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

export function formatBytes(bytes, { precision = 1 } = {}) {
  const size = typeof bytes === 'number' ? bytes : Number(bytes);
  if (!Number.isFinite(size) || size < 0) {
    return 'unknown size';
  }
  if (size === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / 1024 ** index;
  const digits = value >= 10 ? Math.max(0, precision - 1) : precision;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatDate(value, options) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleDateString(undefined, options);
}

export function formatDateTime(value, options) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const formatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...options,
  });
  return formatter.format(date);
}

export function toggleHidden(element, shouldHide) {
  if (!element) return;
  element.classList.toggle('hidden', Boolean(shouldHide));
  if (element.hasAttribute && element.hasAttribute('aria-hidden')) {
    element.setAttribute('aria-hidden', shouldHide ? 'true' : 'false');
  }
}

export function safeText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' && Number.isFinite(content)) {
    return String(content);
  }
  return '';
}

export const dom = {
  qs,
  qsa,
  byId,
  setStatusMessage,
  clearChildren,
  formatBytes,
  formatDate,
  formatDateTime,
  toggleHidden,
  safeText,
};

export default dom;
