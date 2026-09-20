// Time range filtering (start/end indices per sheet)

const sheetRanges = new Map();
const sheetListeners = new Map();
const globalListeners = new Set();

function normalizeSheetId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeIndex(value) {
  if (Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const candidate = Math.trunc(value);
    return candidate >= 0 ? candidate : null;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function cloneRange(range) {
  if (!range) return null;
  return {
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    domainStartIndex: range.domainStartIndex,
    domainEndIndex: range.domainEndIndex,
  };
}

function notify(sheetId) {
  const normalizedSheetId = normalizeSheetId(sheetId);
  const range = sheetRanges.get(normalizedSheetId) || null;
  const snapshot = cloneRange(range);

  if (normalizedSheetId && sheetListeners.has(normalizedSheetId)) {
    sheetListeners.get(normalizedSheetId).forEach(listener => {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('[timeRangeFilter] Listener error', error);
      }
    });
  }

  globalListeners.forEach(listener => {
    try {
      listener({ sheetId: normalizedSheetId, range: snapshot });
    } catch (error) {
      console.error('[timeRangeFilter] Global listener error', error);
    }
  });
}

function areRangesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.startIndex === b.startIndex
    && a.endIndex === b.endIndex
    && a.domainStartIndex === b.domainStartIndex
    && a.domainEndIndex === b.domainEndIndex;
}

function buildRange(startIndex, endIndex) {
  const normalizedStart = normalizeIndex(startIndex);
  const normalizedEnd = normalizeIndex(endIndex);

  if (normalizedStart == null || normalizedEnd == null) {
    return null;
  }

  const start = Math.min(normalizedStart, normalizedEnd);
  const end = Math.max(normalizedStart, normalizedEnd);

  return {
    startIndex: start,
    endIndex: end,
    domainStartIndex: start,
    domainEndIndex: end,
  };
}

export function setTimeRange(sheetId, range) {
  const normalizedSheetId = normalizeSheetId(sheetId);
  if (!normalizedSheetId) return null;

  if (!range || typeof range !== 'object') {
    clearTimeRange(normalizedSheetId);
    return null;
  }

  const next = buildRange(range.startIndex, range.endIndex);
  if (!next) {
    clearTimeRange(normalizedSheetId);
    return null;
  }

  const previous = sheetRanges.get(normalizedSheetId) || null;
  if (areRangesEqual(previous, next)) {
    return cloneRange(previous);
  }

  sheetRanges.set(normalizedSheetId, next);
  notify(normalizedSheetId);
  return cloneRange(next);
}

export function clearTimeRange(sheetId) {
  const normalizedSheetId = normalizeSheetId(sheetId);
  if (!normalizedSheetId) return;

  if (!sheetRanges.has(normalizedSheetId)) return;

  sheetRanges.delete(normalizedSheetId);
  notify(normalizedSheetId);
}

export function getTimeRange(sheetId) {
  const normalizedSheetId = normalizeSheetId(sheetId);
  if (!normalizedSheetId) return null;
  const stored = sheetRanges.get(normalizedSheetId) || null;
  return cloneRange(stored);
}

export function getActiveDomain(sheetId) {
  const range = getTimeRange(sheetId);
  if (!range) return null;
  return {
    domainStartIndex: range.domainStartIndex,
    domainEndIndex: range.domainEndIndex,
  };
}

export function clampIndex(sheetId, value) {
  const domain = getActiveDomain(sheetId);
  const parsed = normalizeIndex(value);
  if (parsed == null) {
    return domain ? domain.domainStartIndex : null;
  }
  if (!domain) {
    return parsed;
  }
  const start = Math.min(domain.domainStartIndex, domain.domainEndIndex);
  const end = Math.max(domain.domainStartIndex, domain.domainEndIndex);
  return Math.min(Math.max(parsed, start), end);
}

export function subscribe(sheetId, listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('listener must be a function');
  }
  const normalizedSheetId = normalizeSheetId(sheetId);
  if (!normalizedSheetId) {
    return () => {};
  }
  if (!sheetListeners.has(normalizedSheetId)) {
    sheetListeners.set(normalizedSheetId, new Set());
  }
  const listeners = sheetListeners.get(normalizedSheetId);
  listeners.add(listener);
  try {
    listener(getActiveDomain(normalizedSheetId));
  } catch (error) {
    console.error('[timeRangeFilter] Initial listener error', error);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      sheetListeners.delete(normalizedSheetId);
    }
  };
}

export function subscribeAll(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('listener must be a function');
  }
  globalListeners.add(listener);
  return () => {
    globalListeners.delete(listener);
  };
}

export function resetAll() {
  if (!sheetRanges.size) return;
  const sheetIds = Array.from(sheetRanges.keys());
  sheetRanges.clear();
  sheetIds.forEach(sheetId => {
    notify(sheetId);
  });
}

export default {
  setTimeRange,
  clearTimeRange,
  getTimeRange,
  getActiveDomain,
  clampIndex,
  subscribe,
  subscribeAll,
  resetAll,
};
