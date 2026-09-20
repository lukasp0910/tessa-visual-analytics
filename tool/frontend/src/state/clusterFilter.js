// Cluster filtering (row indices to labels per sheet)

const sheetClusters = new Map();
const sheetListeners = new Map();
const globalListeners = new Set();

function normalizeSheetId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeLabel(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

function normalizeClusterPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const rawLabels = Array.isArray(payload.labels) || payload.labels instanceof Int32Array
    ? Array.from(payload.labels)
    : null;
  if (!rawLabels || !rawLabels.length) return null;

  const labels = [];
  rawLabels.forEach(label => {
    const normalized = normalizeLabel(label);
    if (normalized == null) return;
    labels.push(normalized);
  });
  if (!labels.length) return null;

  const rawRowIndices = Array.isArray(payload.rowIndices) || payload.rowIndices instanceof Int32Array
    ? Array.from(payload.rowIndices)
    : null;

  const rowIndices = rawRowIndices && rawRowIndices.length
    ? rawRowIndices.map(index => normalizeLabel(index)).filter(index => index != null)
    : null;

  const labelSet = new Set();
  labels.forEach(label => {
    if (label >= 0) labelSet.add(label);
  });

  return {
    labels: Int32Array.from(labels),
    rowIndices: rowIndices ? Int32Array.from(rowIndices) : null,
    clusterCount: labelSet.size,
  };
}

function cloneClusterData(clusterData) {
  if (!clusterData) return null;
  return {
    labels: Int32Array.from(clusterData.labels),
    rowIndices: clusterData.rowIndices ? Int32Array.from(clusterData.rowIndices) : null,
    clusterCount: clusterData.clusterCount,
  };
}

function notify(sheetId) {
  const normalizedSheetId = normalizeSheetId(sheetId);
  const clusterData = sheetClusters.get(normalizedSheetId) || null;
  const snapshot = cloneClusterData(clusterData);

  if (normalizedSheetId && sheetListeners.has(normalizedSheetId)) {
    sheetListeners.get(normalizedSheetId).forEach(listener => {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('[clusterFilter] Listener error', error);
      }
    });
  }

  globalListeners.forEach(listener => {
    try {
      listener({ sheetId: normalizedSheetId, cluster: snapshot });
    } catch (error) {
      console.error('[clusterFilter] Global listener error', error);
    }
  });
}

export function setClusterFilter(sheetId, payload) {
  const normalizedSheetId = normalizeSheetId(sheetId);
  if (!normalizedSheetId) return null;

  const normalized = normalizeClusterPayload(payload);
  if (!normalized) {
    clearClusterFilter(normalizedSheetId);
    return null;
  }

  const previous = sheetClusters.get(normalizedSheetId) || null;
  if (
    previous
    && previous.labels.length === normalized.labels.length
    && previous.labels.every((value, idx) => value === normalized.labels[idx])
  ) {
    return cloneClusterData(previous);
  }

  sheetClusters.set(normalizedSheetId, normalized);
  notify(normalizedSheetId);
  return cloneClusterData(normalized);
}

export function clearClusterFilter(sheetId) {
  const normalizedSheetId = normalizeSheetId(sheetId);
  if (!normalizedSheetId) return;
  if (!sheetClusters.has(normalizedSheetId)) return;
  sheetClusters.delete(normalizedSheetId);
  notify(normalizedSheetId);
}

export function getClusterFilter(sheetId) {
  const normalizedSheetId = normalizeSheetId(sheetId);
  if (!normalizedSheetId) return null;
  const stored = sheetClusters.get(normalizedSheetId) || null;
  return cloneClusterData(stored);
}

export function hasClusterFilter(sheetId) {
  const normalizedSheetId = normalizeSheetId(sheetId);
  if (!normalizedSheetId) return false;
  const entry = sheetClusters.get(normalizedSheetId);
  return !!(entry && entry.labels && entry.labels.length);
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
    listener(getClusterFilter(normalizedSheetId));
  } catch (error) {
    console.error('[clusterFilter] Initial listener error', error);
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
  if (!sheetClusters.size) return;
  const sheetIds = Array.from(sheetClusters.keys());
  sheetClusters.clear();
  sheetIds.forEach(sheetId => {
    notify(sheetId);
  });
}

export default {
  setClusterFilter,
  clearClusterFilter,
  getClusterFilter,
  hasClusterFilter,
  subscribe,
  subscribeAll,
  resetAll,
};
