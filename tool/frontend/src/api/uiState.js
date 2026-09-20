import { requestJson } from './client.js';

const INTERACTION_MODE_ENDPOINT = '/api/v1/ui-state/interaction-mode';
const ACTIVE_PROJECT_ENDPOINT = '/api/v1/ui-state/active-project';

export async function fetchInteractionMode() {
  return requestJson(INTERACTION_MODE_ENDPOINT, { method: 'GET' });
}

export async function updateInteractionMode(mode) {
  return requestJson(INTERACTION_MODE_ENDPOINT, {
    method: 'POST',
    body: { mode },
  });
}

export async function fetchActiveProject() {
  return requestJson(ACTIVE_PROJECT_ENDPOINT, { method: 'GET' });
}

export async function updateActiveProject(projectName) {
  return requestJson(ACTIVE_PROJECT_ENDPOINT, {
    method: 'POST',
    body: { project_name: projectName ?? null },
  });
}

export default {
  fetchInteractionMode,
  updateInteractionMode,
  fetchActiveProject,
  updateActiveProject,
};
