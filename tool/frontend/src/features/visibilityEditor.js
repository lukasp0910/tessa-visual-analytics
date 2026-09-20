import { getProject, updateProject, updateArrayColumnNames } from '../api/projects.js';
import { byId, setStatusMessage, toggleHidden } from '../ui/dom.js';

const FEATURE_NAME = 'visibilityEditor';

const state = {
  initialized: false,
  projects: [],
  currentProjectName: '',
  projectDetails: null,
  draft: null,
  editing: false,
};

const elements = {};
let defaultEditButtonContent = null;

function ensureDefaultEditButtonContent() {
  if (!elements.editBtn) return;
  if (defaultEditButtonContent === null) {
    defaultEditButtonContent = elements.editBtn.innerHTML;
  }
}

function ensureEditButtonStructure() {
  if (!elements.editBtn) return;
  ensureDefaultEditButtonContent();
  const hasEditIcon = Boolean(elements.editBtn.querySelector('[data-icon="edit"]'));
  const hasSaveIcon = Boolean(elements.editBtn.querySelector('[data-icon="save"]'));
  if (!hasEditIcon || !hasSaveIcon) {
    elements.editBtn.innerHTML = defaultEditButtonContent ?? '';
  }
}

function setEditButtonStatus(label) {
  if (!elements.editBtn) return;
  ensureDefaultEditButtonContent();
  elements.editBtn.innerHTML = `<span class="text-sm font-medium">${label}</span>`;
  elements.editBtn.setAttribute('aria-label', label);
  elements.editBtn.setAttribute('title', label);
}

function cacheElements() {
  elements.projectSelect = byId('projectSelect');
  elements.arraySelect = byId('arraySelect');
  elements.editBtn = byId('editVisibilityBtn');
  ensureDefaultEditButtonContent();
  elements.cancelBtn = byId('cancelEditVisibilityBtn');
  elements.visibilityToggle = byId('arrayVisibilityToggle');
  elements.visibilityStatus = byId('arrayVisibilityStatus');
}

function formatTone(tone) {
  if (tone === 'error') {
    return { tone: 'error', isError: true };
  }
  if (tone === 'success') {
    return { tone: 'success', isError: false };
  }
  if (tone === 'info') {
    return { tone: 'info', isError: false };
  }
  return { tone: 'muted', isError: false };
}

function setVisibilityStatus(message, tone = 'muted') {
  if (!elements.visibilityStatus) return;
  setStatusMessage(elements.visibilityStatus, message, formatTone(tone));
}

function normalizeColumnNameMap(value) {
  if (value == null) return {};

  const entries = [];

  if (value instanceof Map) {
    value.forEach((name, key) => {
      entries.push([key, name]);
    });
  } else if (Array.isArray(value)) {
    value.forEach((name, index) => {
      entries.push([index + 1, name]);
    });
  } else if (typeof value === 'object') {
    for (const [rawIndex, name] of Object.entries(value)) {
      entries.push([rawIndex, name]);
    }
  }

  const normalized = [];
  entries.forEach(([rawIndex, rawName]) => {
    const index = Number.parseInt(rawIndex, 10);
    if (!Number.isInteger(index) || index < 1) return;
    const text = String(rawName ?? '').trim();
    if (!text) return;
    normalized.push([index, text]);
  });

  normalized.sort((a, b) => a[0] - b[0]);
  const result = {};
  normalized.forEach(([index, name]) => {
    result[String(index)] = name;
  });
  return result;
}

function parseColumnCount(array) {
  if (!array || typeof array !== 'object') return null;
  const explicit = Number.parseInt(array.column_count, 10);
  if (Number.isFinite(explicit) && explicit >= 0) {
    return explicit;
  }
  const shape = Array.isArray(array.shape) ? array.shape : [];
  if (!shape.length) return null;
  const last = Number.parseInt(shape[shape.length - 1], 10);
  return Number.isFinite(last) && last >= 0 ? last : null;
}

function getSelectedArrayId() {
  const value = elements.arraySelect?.value ?? '';
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProjectDetails(project) {
  const name = typeof project?.name === 'string' && project.name.trim()
    ? project.name.trim()
    : typeof project?.filename === 'string' && project.filename.trim()
      ? project.filename.trim()
      : typeof project?.file_name === 'string' && project.file_name.trim()
        ? project.file_name.trim()
        : '';

  const arrays = Array.isArray(project?.arrays) ? project.arrays : [];
  const visibility = project?.visibility && typeof project.visibility === 'object'
    ? project.visibility.arrays || {}
    : {};

  const normalized = [];
  const seen = new Set();

  arrays.forEach(array => {
    const id = typeof array?.id === 'string' && array.id.trim()
      ? array.id.trim()
      : typeof array?.name === 'string' && array.name.trim()
        ? array.name.trim()
        : '';
    if (!id) return;
    const visibilityEntry = visibility[id];
    const enabled = visibilityEntry ? visibilityEntry.enabled !== false : array?.enabled !== false;
    const columnNames = normalizeColumnNameMap(array?.column_names);
    const columnCount = parseColumnCount(array);
    normalized.push({
      id,
      name: typeof array?.name === 'string' && array.name.trim() ? array.name.trim() : id,
      enabled,
      columnNames,
      columnCount,
    });
    seen.add(id);
  });

  for (const [id, entry] of Object.entries(visibility)) {
    if (!id || seen.has(id)) continue;
    normalized.push({
      id,
      name: id,
      enabled: entry?.enabled !== false,
      columnNames: normalizeColumnNameMap(entry?.column_names),
      columnCount: null,
    });
  }

  return {
    name,
    arrays: normalized,
  };
}

function buildDraft(details) {
  if (!details || !details.name) {
    return null;
  }
  const draft = { project: details.name, arrays: {} };
  details.arrays.forEach(array => {
    draft.arrays[array.id] = {
      id: array.id,
      name: array.name,
      enabled: array.enabled !== false,
    };
  });
  return draft;
}

function getArrayInfo(arrayId) {
  if (!arrayId) return null;
  const detailsEntry = state.projectDetails?.arrays?.find(array => array.id === arrayId) || null;
  const draftEntry = state.draft?.arrays?.[arrayId] || null;
  if (detailsEntry && draftEntry) {
    return { ...detailsEntry, ...draftEntry };
  }
  return draftEntry || detailsEntry || null;
}

function updateEditButton() {
  const hasProject = Boolean(state.currentProjectName);
  if (elements.editBtn) {
    ensureEditButtonStructure();
    const isEditing = state.editing;
    const label = isEditing ? 'Save changes' : 'Edit data';
    elements.editBtn.disabled = !hasProject && !isEditing;
    elements.editBtn.setAttribute('aria-label', label);
    elements.editBtn.setAttribute('title', label);
    const labelEl = elements.editBtn.querySelector('[data-label]');
    if (labelEl) {
      labelEl.textContent = label;
    }
    const editIcon = elements.editBtn.querySelector('[data-icon="edit"]');
    const saveIcon = elements.editBtn.querySelector('[data-icon="save"]');
    toggleHidden(editIcon, isEditing);
    toggleHidden(saveIcon, !isEditing);
  }
  if (elements.cancelBtn) {
    const shouldShow = state.editing;
    const cancelLabel = 'Cancel editing';
    toggleHidden(elements.cancelBtn, !shouldShow);
    elements.cancelBtn.disabled = !shouldShow;
    elements.cancelBtn.setAttribute('aria-label', cancelLabel);
    elements.cancelBtn.setAttribute('title', cancelLabel);
    const cancelLabelEl = elements.cancelBtn.querySelector('[data-label]');
    if (cancelLabelEl) {
      cancelLabelEl.textContent = cancelLabel;
    }
  }
}

function emitEditModeChange() {
  document.dispatchEvent(new CustomEvent('visibility:edit-mode-changed', {
    detail: { editing: state.editing },
  }));
}

function syncToggleWithDraft() {
  const toggle = elements.visibilityToggle;
  if (!toggle) return;

  const arrayId = getSelectedArrayId();
  if (!arrayId) {
    toggle.checked = true;
    toggle.disabled = true;
    setVisibilityStatus('Select an array to view availability.', 'muted');
    return;
  }

  const info = getArrayInfo(arrayId);
  if (!info) {
    toggle.checked = true;
    toggle.disabled = true;
    setVisibilityStatus('Array metadata unavailable. Reload projects to try again.', 'error');
    return;
  }

  if (!state.editing) {
    toggle.checked = true;
    toggle.disabled = true;
    setVisibilityStatus('Visibility editing available in the dedicated editor.', 'muted');
    return;
  }

  toggle.checked = info.enabled !== false;
  toggle.disabled = false;
  setVisibilityStatus(
    info.enabled !== false
      ? 'Uncheck to hide this array from visualizations.'
      : 'Array will be hidden until you re-enable it.',
    'info',
  );
}

function resetEditorState() {
  state.projectDetails = null;
  state.draft = null;
}

function exitEditMode({ notify = true, message } = {}) {
  if (!state.editing) {
    if (message) {
      setVisibilityStatus(message.text, message.tone);
    }
    return;
  }
  state.editing = false;
  resetEditorState();
  updateEditButton();
  syncToggleWithDraft();
  if (notify) {
    emitEditModeChange();
  }
  if (message) {
    setVisibilityStatus(message.text, message.tone);
  } else {
    setVisibilityStatus('Visibility editing available in the dedicated editor.', 'muted');
  }
}

async function enterEditMode() {
  if (state.editing) {
    syncToggleWithDraft();
    return;
  }

  const projectName = state.currentProjectName;
  if (!projectName) {
    setVisibilityStatus('Select a project before editing visibility.', 'error');
    return;
  }

  if (elements.editBtn) {
    elements.editBtn.disabled = true;
    setEditButtonStatus('Loading…');
  }
  setVisibilityStatus('Loading project details…', 'info');

  try {
    const project = await getProject(projectName);
    const details = normalizeProjectDetails(project);
    if (!details.arrays.length) {
      resetEditorState();
      setVisibilityStatus('This project does not contain any arrays to configure.', 'muted');
      if (elements.editBtn) {
        elements.editBtn.disabled = false;
      }
      updateEditButton();
      return;
    }
    state.projectDetails = details;
    state.draft = buildDraft(details);
    state.editing = true;
    updateEditButton();
    emitEditModeChange();
    setVisibilityStatus('Adjust array visibility, then save.', 'info');
    syncToggleWithDraft();
  } catch (error) {
    console.error('[Feature:visibilityEditor] Failed to load project details', error);
    setVisibilityStatus('Failed to load project details.', 'error');
  } finally {
    if (elements.editBtn) {
      elements.editBtn.disabled = false;
    }
    updateEditButton();
  }
}

function buildVisibilityPayload(draft) {
  if (!draft || !draft.project) {
    return { arrays: {} };
  }
  const payload = { arrays: {} };
  Object.entries(draft.arrays).forEach(([id, entry]) => {
    if (!id || !entry) return;
    const enabled = entry.enabled !== false;
    if (enabled) {
      return;
    }
    payload.arrays[id] = {
      enabled: false,
      disabled_columns: [],
    };
  });
  return payload;
}

async function saveChanges() {
  if (!state.editing || !state.draft) {
    return;
  }

  const projectName = state.currentProjectName;
  if (!projectName) {
    setVisibilityStatus('Select a project before saving.', 'error');
    return;
  }

  const payload = buildVisibilityPayload(state.draft);
  if (elements.editBtn) {
    elements.editBtn.disabled = true;
    setEditButtonStatus('Saving…');
  }
  setVisibilityStatus('Saving visibility settings…', 'info');

  try {
    await updateProject(projectName, { visibility: payload });
    setVisibilityStatus('Visibility settings saved.', 'success');
    exitEditMode({ notify: true });
    document.dispatchEvent(new CustomEvent('projects:refresh-requested', {
      detail: { preferredProject: projectName, reason: 'visibility-updated' },
    }));
  } catch (error) {
    console.error('[Feature:visibilityEditor] Failed to save visibility', error);
    setVisibilityStatus('Failed to save visibility settings. Try again.', 'error');
    if (elements.editBtn) {
      elements.editBtn.disabled = false;
    }
    updateEditButton();
  }
}

function handleToggleChange() {
  if (!state.editing || !state.draft) {
    syncToggleWithDraft();
    return;
  }
  const arrayId = getSelectedArrayId();
  if (!arrayId || !elements.visibilityToggle) return;
  const entry = state.draft.arrays[arrayId];
  if (!entry) return;
  entry.enabled = elements.visibilityToggle.checked;
  syncToggleWithDraft();
}

function handleEditButtonClick() {
  if (state.editing) {
    saveChanges();
  } else {
    enterEditMode();
  }
}

function handleCancelClick(event) {
  event.preventDefault();
  exitEditMode({ notify: true, message: { text: 'Visibility changes discarded.', tone: 'muted' } });
}

function handleProjectSelected(event) {
  const { projectName, project } = event.detail || {};
  const resolvedName = typeof projectName === 'string' && projectName.trim()
    ? projectName.trim()
    : typeof project?.name === 'string' && project.name.trim()
      ? project.name.trim()
      : '';

  if (resolvedName !== state.currentProjectName) {
    exitEditMode({ notify: true });
    resetEditorState();
  }
  state.currentProjectName = resolvedName;
  updateEditButton();
  syncToggleWithDraft();
}

function handleProjectsUpdated(event) {
  const { projects = [] } = event.detail || {};
  state.projects = Array.isArray(projects) ? projects : [];
  updateEditButton();
}

function handleProjectDataUploaded(event) {
  const { projectName } = event.detail || {};
  if (!projectName || projectName !== state.currentProjectName) return;
  exitEditMode({ notify: true, message: { text: 'Project data changed. Restart visibility editing.', tone: 'info' } });
}

function handleArrayRenamed(event) {
  const { projectName, arrayId, nextName } = event.detail || {};
  if (!projectName || projectName !== state.currentProjectName) return;
  if (!arrayId || !nextName) return;
  const normalizedName = typeof nextName === 'string' && nextName.trim() ? nextName.trim() : arrayId;
  if (state.projectDetails) {
    state.projectDetails.arrays = state.projectDetails.arrays.map(array => (
      array.id === arrayId ? { ...array, name: normalizedName } : array
    ));
  }
  if (state.draft?.arrays?.[arrayId]) {
    state.draft.arrays[arrayId].name = normalizedName;
  }
}

function handleColumnNamesOpenRequest() {
  if (!state.editing) {
    setVisibilityStatus('Enter visibility edit mode to rename columns.', 'error');
    return;
  }
  const arrayId = getSelectedArrayId();
  const info = getArrayInfo(arrayId);
  if (!arrayId || !info) {
    setVisibilityStatus('Select an array to rename its columns.', 'error');
    return;
  }
  document.dispatchEvent(new CustomEvent('column-names:open', {
    detail: {
      projectName: state.currentProjectName,
      arrayId,
      arrayName: info.name,
      columnCount: Number.isFinite(info.columnCount) ? info.columnCount : null,
      columnNames: info.columnNames || {},
    },
  }));
}

async function handleColumnNamesUpdateRequest(event) {
  const detail = event.detail || {};
  const targetProject = detail.projectName || state.currentProjectName;
  const arrayId = detail.arrayId;
  const progressMessage = detail.progressMessage;
  const successMessage = detail.successMessage;
  const overrides = normalizeColumnNameMap(detail.overrides);

  if (!state.editing) {
    setVisibilityStatus('Enter visibility edit mode to rename columns.', 'error');
    document.dispatchEvent(new CustomEvent('column-names:update-complete', {
      detail: { success: false, projectName: targetProject || null, arrayId, error: new Error('Not editing') },
    }));
    return;
  }

  if (!targetProject || targetProject !== state.currentProjectName || !arrayId) {
    document.dispatchEvent(new CustomEvent('column-names:update-complete', {
      detail: { success: false, projectName: targetProject || null, arrayId, error: new Error('Invalid column rename request') },
    }));
    setVisibilityStatus('Select a project and array before renaming columns.', 'error');
    return;
  }

  document.dispatchEvent(new CustomEvent('column-names:update-started', {
    detail: { progressMessage },
  }));

  try {
    const response = await updateArrayColumnNames(targetProject, arrayId, overrides);

    if (state.projectDetails) {
      state.projectDetails.arrays = state.projectDetails.arrays.map(array => (
        array.id === arrayId
          ? {
            ...array,
            columnNames: { ...overrides },
          }
          : array
      ));
    }

    document.dispatchEvent(new CustomEvent('column-names:update-complete', {
      detail: {
        success: true,
        projectName: targetProject,
        arrayId,
        columnNames: { ...overrides },
        response,
        successMessage,
      },
    }));

    setVisibilityStatus(successMessage || 'Column names updated.', 'success');
  } catch (error) {
    console.error('[Feature:visibilityEditor] Failed to update column names', error);
    document.dispatchEvent(new CustomEvent('column-names:update-complete', {
      detail: { success: false, projectName: targetProject, arrayId, error },
    }));
    setVisibilityStatus('Failed to update column names. Try again.', 'error');
  }
}

function handleArrayDeleted(event) {
  const { projectName, arrayId } = event.detail || {};
  if (!projectName || projectName !== state.currentProjectName) return;
  if (!arrayId) return;

  if (state.projectDetails) {
    state.projectDetails.arrays = state.projectDetails.arrays.filter(array => array.id !== arrayId);
  }
  if (state.draft?.arrays) {
    delete state.draft.arrays[arrayId];
  }

  if (!state.editing) {
    return;
  }

  if (!state.projectDetails?.arrays?.length) {
    exitEditMode({
      notify: true,
      message: { text: 'All arrays removed from this project. Exiting edit mode.', tone: 'info' },
    });
    return;
  }

  setVisibilityStatus('Array deleted. Select another array to continue editing.', 'info');
  syncToggleWithDraft();
}

function registerEventListeners() {
  elements.editBtn?.addEventListener('click', handleEditButtonClick);
  elements.cancelBtn?.addEventListener('click', handleCancelClick);
  elements.arraySelect?.addEventListener('change', () => {
    syncToggleWithDraft();
  });
  elements.visibilityToggle?.addEventListener('change', handleToggleChange);

  document.addEventListener('project:selected', handleProjectSelected);
  document.addEventListener('projects:updated', handleProjectsUpdated);
  document.addEventListener('project:data-uploaded', handleProjectDataUploaded);
  document.addEventListener('array:renamed', handleArrayRenamed);
  document.addEventListener('column-names:open-request', handleColumnNamesOpenRequest);
  document.addEventListener('column-names:update-request', handleColumnNamesUpdateRequest);
  document.addEventListener('array:deleted', handleArrayDeleted);
}

export function init() {
  if (state.initialized) return;
  cacheElements();
  if (!elements.editBtn || !elements.visibilityToggle) {
    console.warn('[Feature:visibilityEditor] Required elements not found.');
    return;
  }
  state.initialized = true;
  updateEditButton();
  syncToggleWithDraft();
  setVisibilityStatus('Select a project to manage visibility.', 'muted');
  registerEventListeners();
  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export default { init };
