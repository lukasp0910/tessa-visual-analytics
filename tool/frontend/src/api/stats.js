import { requestJson } from './client.js';

function encodeSegment(value) {
  return encodeURIComponent(value ?? '');
}

export function normalizeStatisticValue(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return value;
    }
    return Number.isNaN(value) ? null : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? trimmed : parsed;
  }
  return value;
}

export async function fetchColumnStatistics(projectName, arrayId, columnIndex) {
  if (!projectName || !arrayId || !Number.isInteger(columnIndex)) {
    throw new Error('Invalid column reference.');
  }
  const url = `/api/v1/statistics/projects/${encodeSegment(projectName)}/arrays/${encodeSegment(arrayId)}/columns/${columnIndex}/stats`;
  const response = await requestJson(url, { method: 'GET' });
  if (!response || typeof response !== 'object') {
    return null;
  }
  const { statistics } = response;
  if (!statistics || typeof statistics !== 'object') {
    return null;
  }
  const normalized = {};
  for (const key of ['min', 'max', 'average', 'mean', 'median']) {
    normalized[key] = normalizeStatisticValue(statistics[key]);
  }
  return normalized;
}

export function formatStatistic(value, { precision = 4 } = {}) {
  if (value == null) return '–';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toFixed(precision);
  }
  return String(value);
}

export const statsApi = {
  fetchColumnStatistics,
  normalizeStatisticValue,
  formatStatistic,
};

export default statsApi;
