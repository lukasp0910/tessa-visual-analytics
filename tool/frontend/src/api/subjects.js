import { requestJson } from './client.js';

function encodeSegment(value) {
  return encodeURIComponent(value ?? '');
}

export function fetchSubjectGroups(projectName) {
  if (!projectName) {
    return Promise.resolve({ project: null, groups: [], selected_array_ids: [] });
  }
  return requestJson(`/api/v1/projects/${encodeSegment(projectName)}/subjects`, { method: 'GET' });
}

export const subjectsApi = {
  fetchSubjectGroups,
};

export default subjectsApi;
