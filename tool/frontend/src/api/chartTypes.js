// Fetches available chart type definitions from backend

import { requestJson } from './client.js';

const CHART_TYPES_ENDPOINT = '/api/v1/chart-types';

let cachedRegistry = null;
let pendingRequest = null;

function normalizeRegistry(payload) {
  const version = Number.isFinite(payload?.version) ? payload.version : null;
  const rawTypes = Array.isArray(payload?.types) ? payload.types : [];
  const types = rawTypes
    .map(entry => {
      if (!entry || typeof entry !== 'object') return null;
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const label = typeof entry.label === 'string' ? entry.label.trim() : name;
      if (!name) return null;
      const fields = Array.isArray(entry.fields) ? entry.fields.filter(Boolean) : [];
      const defaults = entry.defaults && typeof entry.defaults === 'object' ? entry.defaults : {};
      const options = entry.options && typeof entry.options === 'object' ? entry.options : {};
      const description = typeof entry.description === 'string' ? entry.description : '';
      const metadata = entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
      return {
        ...entry,
        name,
        label: label || name,
        description,
        fields,
        defaults,
        options,
        metadata,
      };
    })
    .filter(Boolean);
  return { version, types };
}

export async function fetchChartTypes({ force = false } = {}) {
  if (!force && cachedRegistry) {
    return cachedRegistry;
  }

  // Reuse pending request to avoid duplicate fetches
  if (!force && pendingRequest) {
    return pendingRequest;
  }

  pendingRequest = requestJson(CHART_TYPES_ENDPOINT, { method: 'GET' })
    .then(payload => {
      cachedRegistry = normalizeRegistry(payload || {});
      pendingRequest = null;
      return cachedRegistry;
    })
    .catch(error => {
      pendingRequest = null;
      throw error;
    });

  return pendingRequest;
}

export function getCachedChartTypes() {
  return cachedRegistry;
}

export default {
  fetchChartTypes,
  getCachedChartTypes,
};
