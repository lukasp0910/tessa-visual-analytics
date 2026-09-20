import { fetchSubjectGroups } from '../api/subjects.js';
import { byId, formatBytes, formatDateTime } from '../ui/dom.js';
import { closeModal, openModal, isModalOpen } from '../ui/modal.js';

const FEATURE_NAME = 'projectDetails';

const SUBJECT_MODE_SINGLE = 'single';
const SUBJECT_MODE_MULTI = 'multi';
const SUBJECT_LOADING_TEXT = 'Detecting subjects…';
const SUBJECT_ERROR_TEXT = 'Subjects unavailable';
const MAX_SUBJECT_LABELS_DISPLAYED = 5;

const subjectState = {
  counts: new Map(),
  details: new Map(),
  pending: new Map(),
  nextRequestId: 0,
};

const state = {
  projects: [],
  currentProject: null,
  closedByUser: false,
};

const elements = {};
let initialized = false;

function cacheElements() {
  elements.projectSelect = byId('projectSelect');
  elements.detailsBtn = byId('projectDetailsBtn');
  elements.modal = byId('projectDetailsModal');
  elements.modalClose = byId('projectDetailsModalClose');
  elements.modalBackdrop = document.querySelector('[data-modal="details-backdrop"]');
  elements.nameHeading = byId('projectDetailsName');
  elements.nameInput = byId('projectDetailsNameInput');
  elements.description = byId('projectDetailsDescription');
  elements.meta = byId('projectDetailsMeta');
}

function projectDisplayName(project, fallback = 'Project details') {
  if (project && typeof project === 'object') {
    if (typeof project.title === 'string' && project.title.trim()) {
      return project.title.trim();
    }
    const candidates = [
      project.display_name,
      project.displayName,
      project.name,
      project.filename,
      project.file_name,
      project.fileName,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  if (typeof fallback === 'string' && fallback.trim()) {
    return fallback.trim();
  }
  return 'Project details';
}

function clearMeta() {
  if (!elements.meta) return;
  elements.meta.innerHTML = '';
}

function parseNonNegativeInteger(value) {
  if (Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

function resolveProjectName(project) {
  if (!project || typeof project !== 'object') {
    return null;
  }
  const candidates = [project.name, project.filename, project.file_name, project.fileName];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return null;
}

function resolveSubjectMode(project) {
  if (!project || typeof project !== 'object') {
    return SUBJECT_MODE_SINGLE;
  }
  const raw = project.subject_mode ?? project.subjectMode;
  return raw === SUBJECT_MODE_MULTI ? SUBJECT_MODE_MULTI : SUBJECT_MODE_SINGLE;
}

function formatSubjectCount(count) {
  if (!Number.isFinite(count)) {
    return null;
  }
  const value = Math.max(0, Math.round(count));
  const noun = value === 1 ? 'Subject' : 'Subjects';
  return `${value.toLocaleString()} ${noun}`;
}

function normalizeIdentifier(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function normalizeSubjectNameMap(value) {
  if (!value || typeof value !== 'object') {
    return new Map();
  }
  const entries = value instanceof Map ? Array.from(value.entries()) : Object.entries(value);
  const normalized = new Map();
  for (const [rawKey, rawValue] of entries) {
    const key = normalizeIdentifier(rawKey);
    if (!key) {
      continue;
    }
    const label = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue ?? '').trim();
    if (!label) {
      continue;
    }
    normalized.set(key, label);
    if (normalized.size >= 1024) {
      break;
    }
  }
  return normalized;
}

function extractSubjectSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return { count: 0, identifiers: [], names: new Map() };
  }

  const groups = Array.isArray(summary.groups) ? summary.groups : [];
  const selectedRaw = Array.isArray(summary.selected_array_ids) ? summary.selected_array_ids : [];
  const selectedIds = new Set();
  selectedRaw.forEach(item => {
    const text = normalizeIdentifier(item);
    if (text) {
      selectedIds.add(text);
    }
  });
  const enforceSelection = selectedIds.size > 0;

  const identifiers = [];
  const seenIdentifiers = new Set();
  let count = null;

  for (const group of groups) {
    if (!group || typeof group !== 'object') {
      continue;
    }

    let matchesSelection = true;
    if (enforceSelection) {
      const arrays = Array.isArray(group.arrays) ? group.arrays : [];
      matchesSelection = arrays.some(entry => {
        const identifier = normalizeIdentifier(entry?.array_id);
        return identifier && selectedIds.has(identifier);
      });
    }

    if (matchesSelection) {
      const values = Array.isArray(group.values) ? group.values : [];
      values.forEach(value => {
        const identifier = normalizeIdentifier(value);
        if (!identifier || seenIdentifiers.has(identifier)) {
          return;
        }
        seenIdentifiers.add(identifier);
        identifiers.push(identifier);
      });
    }

    const groupCount = Number.isFinite(group?.subject_count) ? group.subject_count : null;
    if (groupCount === null || !matchesSelection) {
      continue;
    }
    const normalized = Math.max(0, Math.round(groupCount));
    count = count === null ? normalized : Math.max(count, normalized);
  }

  const names = normalizeSubjectNameMap(summary.subject_names);
  for (const identifier of names.keys()) {
    if (!identifier || seenIdentifiers.has(identifier)) {
      continue;
    }
    seenIdentifiers.add(identifier);
    identifiers.push(identifier);
  }

  if (count === null) {
    count = 0;
  }

  return { count, identifiers, names };
}

function requestSubjectCount(projectName) {
  if (!projectName || subjectState.pending.has(projectName)) {
    return;
  }
  const requestId = ++subjectState.nextRequestId;
  subjectState.pending.set(projectName, requestId);
  fetchSubjectGroups(projectName)
    .then(summary => {
      if (subjectState.pending.get(projectName) !== requestId) {
        return;
      }
      const { count, identifiers, names } = extractSubjectSummary(summary);
      subjectState.counts.set(projectName, count);
      subjectState.details.set(projectName, { identifiers, names });
      if (state.currentProject?.name === projectName) {
        populateProjectDetails(state.currentProject);
      }
    })
    .catch(error => {
      if (subjectState.pending.get(projectName) !== requestId) {
        return;
      }
      console.error(`[Feature:${FEATURE_NAME}] Failed to fetch subject groups for ${projectName}:`, error);
      subjectState.counts.set(projectName, null);
      subjectState.details.delete(projectName);
      if (state.currentProject?.name === projectName) {
        populateProjectDetails(state.currentProject);
      }
    })
    .finally(() => {
      if (subjectState.pending.get(projectName) === requestId) {
        subjectState.pending.delete(projectName);
      }
    });
}

function resolveProjectSubjectNameMap(project) {
  if (!project || typeof project !== 'object') {
    return new Map();
  }
  const combined = new Map();
  const candidates = [project.subject_names, project.subjectNames];
  candidates.forEach(candidate => {
    const normalized = normalizeSubjectNameMap(candidate);
    if (!normalized.size) {
      return;
    }
    for (const [id, label] of normalized.entries()) {
      combined.set(id, label);
      if (combined.size >= 1024) {
        break;
      }
    }
  });
  return combined;
}

function formatSubjectListDisplay({ count, project, projectName }) {
  if (!Number.isFinite(count) || count <= 0) {
    return null;
  }

  const combinedNames = resolveProjectSubjectNameMap(project);
  let identifiers = [];

  if (projectName && subjectState.details.has(projectName)) {
    const details = subjectState.details.get(projectName);
    if (details?.names instanceof Map) {
      for (const [id, label] of details.names.entries()) {
        if (id) {
          combinedNames.set(id, label);
        }
      }
    }
    if (Array.isArray(details?.identifiers)) {
      identifiers = [...details.identifiers];
    }
  }

  if (!identifiers.length && combinedNames.size) {
    identifiers = Array.from(combinedNames.keys());
  }

  const ordered = [];
  const seen = new Set();
  identifiers.forEach(id => {
    const normalized = normalizeIdentifier(id);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    ordered.push(normalized);
  });

  for (const id of combinedNames.keys()) {
    const normalized = normalizeIdentifier(id);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }

  if (!ordered.length) {
    return null;
  }

  const limited = ordered.slice(0, MAX_SUBJECT_LABELS_DISPLAYED);
  const labels = limited.map(id => combinedNames.get(id) || id);
  let listText = labels.join(', ');
  if (ordered.length > limited.length) {
    listText = `${listText}, ...`;
  }
  return listText;
}

function resolveSubjectsDisplay(project) {
  const mode = resolveSubjectMode(project);
  const projectName = resolveProjectName(project);
  if (mode !== SUBJECT_MODE_MULTI) {
    const countLabel = formatSubjectCount(1);
    const subjectList = formatSubjectListDisplay({ count: 1, project, projectName });
    if (subjectList) {
      return `${countLabel} (${subjectList})`;
    }
    return countLabel;
  }
  if (!projectName) {
    return SUBJECT_ERROR_TEXT;
  }
  if (subjectState.counts.has(projectName)) {
    const cached = subjectState.counts.get(projectName);
    if (cached === null) {
      return SUBJECT_ERROR_TEXT;
    }
    const countLabel = formatSubjectCount(cached);
    const subjectList = formatSubjectListDisplay({ count: cached, project, projectName });
    if (subjectList) {
      return `${countLabel} (${subjectList})`;
    }
    return countLabel;
  }
  requestSubjectCount(projectName);
  return SUBJECT_LOADING_TEXT;
}

function populateProjectDetails(project, { emptyMessage } = {}) {
  clearMeta();

  if (elements.nameInput) {
    if (project) {
      const label = project.name || project.filename || '';
      elements.nameInput.value = label;
      elements.nameInput.disabled = true;
    } else {
      elements.nameInput.value = '';
      elements.nameInput.disabled = true;
    }
  }

  if (!project) {
    const fallbackDescription = emptyMessage
      || (state.projects.length
        ? 'Select a project to view its metadata.'
        : 'No projects available. Upload an NPZ file to begin.');
    if (elements.nameHeading) elements.nameHeading.textContent = 'Project details';
    if (elements.description) elements.description.textContent = fallbackDescription;

    if (elements.meta) {
      const overviewMessage = document.createElement('p');
      overviewMessage.className = 'text-sm text-gray-500';
      overviewMessage.textContent = emptyMessage || 'No project selected.';
      elements.meta.append(overviewMessage);
    }
    return;
  }

  const displayName = projectDisplayName(project, 'Project details');
  if (elements.nameHeading) elements.nameHeading.textContent = displayName;
  if (elements.description) {
    if (typeof project.description === 'string' && project.description.trim()) {
      elements.description.textContent = project.description.trim();
    } else {
      const summary = [];
      if (project.array_count != null) {
        summary.push(`${project.array_count} ${project.array_count === 1 ? 'array' : 'arrays'}`);
      }
      if (Number.isFinite(project.size_bytes)) {
        summary.push(formatBytes(project.size_bytes));
      }
      elements.description.textContent = summary.length
        ? `Project summary: ${summary.join(' • ')}.`
        : 'No description available for this project.';
    }
  }

  const overviewList = document.createElement('dl');
  overviewList.className = 'grid grid-cols-[auto_1fr] gap-x-4 gap-y-2';
  const addOverview = (label, value) => {
    if (value === null || value === undefined || value === '') return;
    const dt = document.createElement('dt');
    dt.className = 'text-xs font-semibold uppercase tracking-wide text-gray-500';
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.className = 'text-sm text-gray-700';
    if (value instanceof Node) {
      dd.append(value);
    } else {
      dd.textContent = value;
    }
    overviewList.append(dt, dd);
  };

  let arrayCount = null;
  const arrayCandidates = [project.array_count, project.arrayCount];
  for (const candidate of arrayCandidates) {
    const parsed = parseNonNegativeInteger(candidate);
    if (parsed !== null) {
      arrayCount = parsed;
      break;
    }
  }
  if (arrayCount === null && Array.isArray(project.arrays)) {
    arrayCount = project.arrays.length;
  }
  const formattedArrayCount = arrayCount !== null ? arrayCount.toLocaleString() : null;

  let formattedSize = null;
  const sizeCandidates = [project.size_bytes, project.sizeBytes, project.file_size, project.fileSize];
  for (const candidate of sizeCandidates) {
    const numeric = typeof candidate === 'string' && candidate.trim() ? Number(candidate) : candidate;
    if (Number.isFinite(numeric) && numeric >= 0) {
      formattedSize = formatBytes(numeric);
      break;
    }
  }

  let createdAtDisplay = null;
  const createdCandidates = [project.created_at, project.createdAt, project.created];
  for (const candidate of createdCandidates) {
    if (!candidate) continue;
    const formatted = formatDateTime(candidate);
    if (formatted) {
      createdAtDisplay = formatted;
      break;
    }
  }

  addOverview('Created At', createdAtDisplay);
  addOverview('File Size', formattedSize);
  addOverview('Number of Arrays', formattedArrayCount);
  const subjectsDisplay = resolveSubjectsDisplay(project);
  addOverview('Subjects', subjectsDisplay);

  if (elements.meta) {
    if (overviewList.childElementCount) {
      elements.meta.append(overviewList);
    } else {
      const noMeta = document.createElement('p');
      noMeta.className = 'text-sm text-gray-500';
      noMeta.textContent = 'No additional metadata available.';
      elements.meta.append(noMeta);
    }
  }
}

function openDetailsModal() {
  if (!elements.modal) return;
  state.closedByUser = false;
  openModal(elements.modal, { focusTarget: elements.modal.querySelector('[data-modal-autofocus]') });
}

function closeDetailsModal({ userInitiated = false } = {}) {
  if (!elements.modal) return;
  state.closedByUser = userInitiated;
  closeModal(elements.modal);
}

function updateButtonState(project) {
  if (!elements.detailsBtn) return;
  elements.detailsBtn.disabled = !project;
}

function findProjectByName(name) {
  if (!name) return null;
  return state.projects.find(project => project?.name === name) || null;
}

function handleProjectSelected(event) {
  const { project, projectName } = event.detail || {};
  let resolvedProject = project || null;
  if (!resolvedProject && projectName) {
    resolvedProject = findProjectByName(projectName);
  }
  state.currentProject = resolvedProject;
  updateButtonState(resolvedProject);
  populateProjectDetails(resolvedProject);

  if (resolvedProject) {
    if (state.closedByUser) {
      return;
    }
    if (elements.modal && isModalOpen(elements.modal)) {
      openDetailsModal();
    }
  } else {
    closeDetailsModal();
  }
}

function handleProjectsUpdated(event) {
  const { projects = [] } = event.detail || {};
  state.projects = Array.isArray(projects) ? [...projects] : [];
  const select = elements.projectSelect;
  let project = state.currentProject;
  if (select && select.value) {
    project = findProjectByName(select.value);
  }
  state.currentProject = project;
  updateButtonState(project);
  populateProjectDetails(project);
}

function attachEventListeners() {
  elements.detailsBtn?.addEventListener('click', () => {
    if (elements.detailsBtn.disabled) return;
    state.closedByUser = false;
    openDetailsModal();
  });

  elements.modalClose?.addEventListener('click', () => {
    closeDetailsModal({ userInitiated: true });
  });

  elements.modalBackdrop?.addEventListener('click', () => {
    closeDetailsModal({ userInitiated: true });
  });

  document.addEventListener('project:selected', handleProjectSelected);
  document.addEventListener('project:deleted', () => {
    state.currentProject = null;
    updateButtonState(null);
    populateProjectDetails(null, { emptyMessage: 'Project deleted.' });
  });
  document.addEventListener('projects:updated', handleProjectsUpdated);
}

export function init() {
  if (initialized) return;
  cacheElements();
  if (!elements.modal || !elements.detailsBtn) {
    console.warn('[Feature:projectDetails] Required elements not found.');
    return;
  }
  attachEventListeners();
  populateProjectDetails(null);
  updateButtonState(null);
  initialized = true;
  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export default { init };
