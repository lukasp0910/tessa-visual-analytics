import { requestJson } from './client.js';

const PROJECTS_ROOT = '/api/v1/projects';

function encodeSegment(value) {
  return encodeURIComponent(value ?? '');
}

export function listProjects() {
  return requestJson(PROJECTS_ROOT, { method: 'GET' });
}

export function getProject(projectName) {
  if (!projectName) return Promise.resolve(null);
  return requestJson(`${PROJECTS_ROOT}/${encodeSegment(projectName)}`, { method: 'GET' });
}

export function createProject(payload) {
  const hasFormData = typeof FormData !== 'undefined';
  const hasBlob = typeof Blob !== 'undefined';
  if ((hasFormData && payload instanceof FormData) || (hasBlob && payload instanceof Blob)) {
    return requestJson(`${PROJECTS_ROOT}/import`, {
      method: 'POST',
      body: payload,
      skipStringify: true,
    });
  }
  return requestJson(PROJECTS_ROOT, {
    method: 'POST',
    body: payload,
  });
}

export function importProjectZip(formData) {
  // Accept only FormData (ZIP upload)
  if (!(formData instanceof FormData)) {
    const next = new FormData();
    if (formData && formData.file) {
      next.append('file', formData.file);
      formData = next;
    } else {
      throw new Error('ZIP upload requires FormData with a file field.');
    }
  }
  return requestJson(`${PROJECTS_ROOT}/import-zip`, {
    method: 'POST',
    body: formData,
    skipStringify: true,
  });
}

export function updateProject(projectName, patch) {
  if (!projectName) {
    return Promise.reject(new Error('Project name is required.'));
  }
  return requestJson(`${PROJECTS_ROOT}/${encodeSegment(projectName)}`, {
    method: 'PUT',
    body: patch,
  });
}

export function deleteProject(projectName) {
  if (!projectName) {
    return Promise.reject(new Error('Project name is required.'));
  }
  return requestJson(`${PROJECTS_ROOT}/${encodeSegment(projectName)}`, {
    method: 'DELETE',
  });
}

function updateArrayMetadata(projectName, arrayId, payload) {
  if (!projectName || !arrayId) {
    return Promise.reject(new Error('Project and array identifiers are required.'));
  }
  if (!payload || typeof payload !== 'object' || (!('name' in payload) && !('column_names' in payload))) {
    return Promise.reject(new Error('No updates requested.'));
  }
  return requestJson(`${PROJECTS_ROOT}/${encodeSegment(projectName)}/arrays/${encodeSegment(arrayId)}`, {
    method: 'PATCH',
    body: payload,
  });
}

export function renameArray(projectName, arrayId, nextName) {
  if (typeof nextName !== 'string' || !nextName.trim()) {
    return Promise.reject(new Error('Next array name is required.'));
  }
  return updateArrayMetadata(projectName, arrayId, { name: nextName });
}

export function updateArrayColumnNames(projectName, arrayId, columnNames) {
  if (!columnNames || typeof columnNames !== 'object') {
    return Promise.reject(new Error('Column name overrides are required.'));
  }
  return updateArrayMetadata(projectName, arrayId, { column_names: columnNames });
}

export function removeArray(projectName, arrayId) {
  if (!projectName || !arrayId) {
    return Promise.reject(new Error('Project and array identifiers are required.'));
  }
  return requestJson(`${PROJECTS_ROOT}/${encodeSegment(projectName)}/arrays/${encodeSegment(arrayId)}`, {
    method: 'DELETE',
  });
}

export function addArray(projectName, fileLike) {
  if (!projectName) {
    return Promise.reject(new Error('Project name is required.'));
  }
  const endpoint = `${PROJECTS_ROOT}/${encodeSegment(projectName)}/arrays`;
  if (typeof FormData !== 'undefined' && fileLike instanceof FormData) {
    return requestJson(endpoint, {
      method: 'POST',
      body: fileLike,
      skipStringify: true,
    });
  }

  if (typeof FormData === 'undefined') {
    return requestJson(endpoint, {
      method: 'POST',
      body: fileLike,
      skipStringify: true,
    });
  }

  const formData = new FormData();
  if (typeof File !== 'undefined' && fileLike instanceof File) {
    formData.append('file', fileLike);
  } else if (fileLike && typeof fileLike === 'object' && typeof fileLike.file !== 'undefined') {
    const file = fileLike.file;
    if (typeof File === 'undefined' || file instanceof File) {
      formData.append('file', file);
    }
  }

  return requestJson(endpoint, {
    method: 'POST',
    body: formData,
    skipStringify: true,
  });
}

export function listArrays(projectName) {
  if (!projectName) {
    return Promise.resolve([]);
  }
  return requestJson(`${PROJECTS_ROOT}/${encodeSegment(projectName)}/arrays`, {
    method: 'GET',
  });
}

export const projectsApi = {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  listArrays,
  addArray,
  renameArray,
  updateArrayColumnNames,
  removeArray,
  importProjectZip,
};

export default projectsApi;
