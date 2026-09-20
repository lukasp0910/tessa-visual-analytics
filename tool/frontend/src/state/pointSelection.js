// Point selections per sheet (only one active at a time)

const sheetSelections = new Map();
const sheetListeners = new Map();
const globalListeners = new Set();

function normalizeSheetId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizePointIndices(indices) {
  if (!indices) return null;
  
  // Handle Set
  if (indices instanceof Set) {
    const arr = Array.from(indices).filter(idx => Number.isInteger(idx) && idx >= 0);
    return arr.length > 0 ? new Set(arr) : null;
  }
  
  // Handle Array
  if (Array.isArray(indices)) {
    const arr = indices.filter(idx => Number.isInteger(idx) && idx >= 0);
    return arr.length > 0 ? new Set(arr) : null;
  }
  
  return null;
}

function cloneSelection(selection) {
  if (!selection || !(selection instanceof Set)) return null;
  return new Set(selection);
}

function notify(sheetId) {
  const normalizedSheetId = normalizeSheetId(sheetId);
  const selection = sheetSelections.get(normalizedSheetId) || null;
  const snapshot = cloneSelection(selection);

  // Notify sheet listeners
  if (normalizedSheetId && sheetListeners.has(normalizedSheetId)) {
    sheetListeners.get(normalizedSheetId).forEach(listener => {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('[pointSelection] Listener error', error);
      }
    });
  }

  globalListeners.forEach(listener => {
    try {
      listener({ sheetId: normalizedSheetId, selection: snapshot });
    } catch (error) {
      console.error('[pointSelection] Global listener error', error);
    }
  });
}

function areSelectionsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (!(a instanceof Set) || !(b instanceof Set)) return false;
  if (a.size !== b.size) return false;
  
  for (const idx of a) {
    if (!b.has(idx)) return false;
  }
  return true;
}

export function setPointSelection(sheetId, indices) {
  const normalizedSheetId = normalizeSheetId(sheetId);
  if (!normalizedSheetId) return null;

  const normalized = normalizePointIndices(indices);
  if (!normalized) {
    clearPointSelection(normalizedSheetId);
    return null;
  }

  const previous = sheetSelections.get(normalizedSheetId) || null;
  if (areSelectionsEqual(previous, normalized)) {
    return cloneSelection(previous);
  }

  // Clear other sheets (only one selection allowed)
  const otherSheetIds = Array.from(sheetSelections.keys()).filter(id => id !== normalizedSheetId);
  for (const otherId of otherSheetIds) {
    sheetSelections.delete(otherId);
    notify(otherId);
  }

  sheetSelections.set(normalizedSheetId, normalized);
  notify(normalizedSheetId);
  return cloneSelection(normalized);
}

export function clearPointSelection(sheetId) {
  const normalizedSheetId = normalizeSheetId(sheetId);
  if (!normalizedSheetId) return;

  if (!sheetSelections.has(normalizedSheetId)) return;

  sheetSelections.delete(normalizedSheetId);
  notify(normalizedSheetId);
}

export function getPointSelection(sheetId) {
  const normalizedSheetId = normalizeSheetId(sheetId);
  if (!normalizedSheetId) return null;
  const stored = sheetSelections.get(normalizedSheetId) || null;
  return cloneSelection(stored);
}

export function hasPointSelection(sheetId) {
  const normalizedSheetId = normalizeSheetId(sheetId);
  if (!normalizedSheetId) return false;
  const selection = sheetSelections.get(normalizedSheetId);
  return selection instanceof Set && selection.size > 0;
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
    listener(getPointSelection(normalizedSheetId));
  } catch (error) {
    console.error('[pointSelection] Initial listener error', error);
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
  if (!sheetSelections.size) return;
  const sheetIds = Array.from(sheetSelections.keys());
  sheetSelections.clear();
  sheetIds.forEach(sheetId => {
    notify(sheetId);
  });
}

export default {
  setPointSelection,
  clearPointSelection,
  getPointSelection,
  hasPointSelection,
  subscribe,
  subscribeAll,
  resetAll,
};
