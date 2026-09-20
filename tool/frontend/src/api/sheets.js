import { requestJson } from './client.js';

const PROJECTS_ROOT = '/api/v1/projects';

function encodeSegment(value) {
  return encodeURIComponent(value ?? '');
}

export function listSheets(projectName) {
  if (!projectName) {
    return Promise.resolve({ sheets: [] });
  }
  return requestJson(`${PROJECTS_ROOT}/${encodeSegment(projectName)}/sheets`, { method: 'GET' });
}

export function createSheet(projectName, payload) {
  if (!projectName) {
    return Promise.reject(new Error('Project name is required.'));
  }
  const body = payload && typeof payload === 'object' ? payload : {};
  return requestJson(`${PROJECTS_ROOT}/${encodeSegment(projectName)}/sheets`, {
    method: 'POST',
    body,
  });
}

export function updateSheet(projectName, sheetId, payload) {
  if (!projectName || !sheetId) {
    return Promise.reject(new Error('Project and sheet identifiers are required.'));
  }
  const body = payload && typeof payload === 'object' ? payload : {};
  return requestJson(`${PROJECTS_ROOT}/${encodeSegment(projectName)}/sheets/${encodeSegment(sheetId)}`, {
    method: 'PATCH',
    body,
  });
}

export function deleteSheet(projectName, sheetId) {
  if (!projectName || !sheetId) {
    return Promise.reject(new Error('Project and sheet identifiers are required.'));
  }
  return requestJson(`${PROJECTS_ROOT}/${encodeSegment(projectName)}/sheets/${encodeSegment(sheetId)}`, {
    method: 'DELETE',
  });
}

export function setActiveSheetPreference(projectName, sheetId) {
  if (!projectName) {
    return Promise.reject(new Error('Project name is required.'));
  }
  const normalized = typeof sheetId === 'string' ? sheetId.trim() : '';
  const body = { sheetId: normalized || null };
  return requestJson(`${PROJECTS_ROOT}/${encodeSegment(projectName)}/sheets/active`, {
    method: 'PUT',
    body,
  });
}

export function setActiveCardPreference(projectName, sheetId, cardId) {
  if (!projectName || !sheetId) {
    return Promise.reject(new Error('Project and sheet identifiers are required.'));
  }
  const normalized = typeof cardId === 'string' ? cardId.trim() : '';
  const body = { cardId: normalized || null };
  return requestJson(
    `${PROJECTS_ROOT}/${encodeSegment(projectName)}/sheets/${encodeSegment(sheetId)}/active-card`,
    {
      method: 'PUT',
      body,
    },
  );
}

export const sheetsApi = {
  listSheets,
  createSheet,
  updateSheet,
  deleteSheet,
  setActiveSheetPreference,
  setActiveCardPreference,
};

export default sheetsApi;
