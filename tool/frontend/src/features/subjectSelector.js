import { fetchSubjectGroups } from '../api/subjects.js';
import { getSnapshot, subscribe } from '../state/store.js';
import { byId, clearChildren, toggleHidden } from '../ui/dom.js';
import { closeModal, isModalOpen, openModal } from '../ui/modal.js';

const FEATURE_NAME = 'subjectSelector';

const state = {
  initialized: false,
  loading: false,
  currentProject: null,
  subjectsByProject: new Map(), // projectName -> { items: Array<{ value, label }>, error: string | null }
  selectionByProject: new Map(), // projectName -> Set<string>
  unsubscribeStore: null,
};

const elements = {
  button: null,
  modal: null,
  list: null,
  empty: null,
  status: null,
  selectAll: null,
  clear: null,
  done: null,
  cancel: null,
  close: null,
};

function sanitizeText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).trim();
  return String(value).trim();
}

function isValidSubjectValue(value) {
  const text = sanitizeText(value);
  // Skip empty and placeholder zero IDs; expected subjects start at 1 for current datasets
  return Boolean(text) && text !== '0';
}

function normalizeSubjectMode(value) {
  if (typeof value === 'string') {
    const cleaned = value.trim().toLowerCase();
    if (!cleaned) return 'single';
    if (cleaned === 'multi' || cleaned === 'multi-subject') return 'multi';
    if (cleaned === 'single' || cleaned === 'single-subject') return 'single';
    const collapsed = cleaned.replace(/[_\s-]+/g, ' ');
    if (collapsed === 'multi subject' || collapsed === 'multiple subjects') return 'multi';
    if (collapsed === 'single subject') return 'single';
  } else if (typeof value === 'boolean') {
    return value ? 'multi' : 'single';
  }
  return 'single';
}

function getProjectFromStore(projectName) {
  if (!projectName) return null;
  const snapshot = getSnapshot();
  const projects = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
  return projects.find(project => project?.name === projectName) || null;
}

function isProjectMultiSubject(projectName) {
  const project = getProjectFromStore(projectName);
  const mode = normalizeSubjectMode(project?.subject_mode ?? project?.subjectMode);
  return mode === 'multi';
}

function cacheElements() {
  elements.button = byId('subjectSelectorButton');
  elements.modal = byId('subjectSelectorModal');
  elements.list = byId('subjectSelectorList');
  elements.empty = byId('subjectSelectorEmpty');
  elements.status = byId('subjectSelectorStatus');
  elements.selectAll = byId('subjectSelectorSelectAll');
  elements.clear = byId('subjectSelectorClear');
  elements.done = byId('subjectSelectorDone');
  elements.cancel = byId('subjectSelectorCancel');
  elements.close = byId('subjectSelectorClose');
}

function setLoading(isLoading, message = '') {
  state.loading = isLoading;
  if (elements.selectAll) {
    elements.selectAll.disabled = isLoading;
    elements.selectAll.setAttribute('aria-busy', isLoading ? 'true' : 'false');
  }
  if (elements.clear) {
    elements.clear.disabled = isLoading;
    elements.clear.setAttribute('aria-busy', isLoading ? 'true' : 'false');
  }
  if (elements.done) {
    elements.done.disabled = isLoading;
  }
  if (elements.status) {
    elements.status.textContent = message;
  }
}

function getSubjects(projectName) {
  if (!projectName) return [];
  const entry = state.subjectsByProject.get(projectName);
  if (!entry || !Array.isArray(entry.items)) return [];
  return entry.items;
}

function getSelection(projectName) {
  if (!projectName) return new Set();
  const entry = state.selectionByProject.get(projectName);
  return entry instanceof Set ? new Set(entry) : new Set();
}

function setSelection(projectName, values) {
  if (!projectName) return;
  const next = new Set(Array.isArray(values) ? values : values instanceof Set ? [...values] : []);
  state.selectionByProject.set(projectName, next);
}

function mapSubjectNamesToOptions(record) {
  if (!record || typeof record !== 'object') return [];
  return Object.entries(record)
    .map(([value, label]) => {
      const id = sanitizeText(value);
      const text = sanitizeText(label) || id;
      return isValidSubjectValue(id) ? { value: id, label: text } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
}

function extractSubjectsFromGroups(payload, nameMap = {}) {
  const groups = Array.isArray(payload?.groups) ? payload.groups : [];
  const values = new Set();
  groups.forEach(group => {
    const summaries = Array.isArray(group?.arrays) ? group.arrays : [];
    summaries.forEach(summary => {
      const subjects = Array.isArray(summary?.values) ? summary.values : [];
      subjects.forEach(subject => {
        const value = sanitizeText(subject);
        if (isValidSubjectValue(value)) {
          values.add(value);
        }
      });
    });
  });
  return Array.from(values)
    .map(value => ({ value, label: nameMap[value] || value }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
}

function ensureSelection(projectName, subjects) {
  const current = getSelection(projectName);
  const allowed = new Set(subjects.map(item => item.value));
  if (current.size) {
    const filtered = [...current].filter(value => allowed.has(value));
    state.selectionByProject.set(projectName, new Set(filtered));
    return state.selectionByProject.get(projectName);
  }
  const next = new Set(allowed);
  state.selectionByProject.set(projectName, next);
  return next;
}

function renderStatus() {
  if (!elements.status) return;
  if (state.loading) return;
  const entry = state.subjectsByProject.get(state.currentProject);
  if (entry?.error) {
    elements.status.textContent = entry.error;
    return;
  }
  const subjects = getSubjects(state.currentProject);
  const selection = getSelection(state.currentProject);
  if (!subjects.length) {
    elements.status.textContent = 'No subjects available';
    return;
  }
  elements.status.textContent = `${selection.size}/${subjects.length} selected`;
}

function renderSubjectList() {
  const list = elements.list;
  if (!list) return;

  clearChildren(list);
  const subjects = getSubjects(state.currentProject);
  const selection = getSelection(state.currentProject);

  const hasSubjects = subjects.length > 0;
  toggleHidden(elements.empty, hasSubjects);
  toggleHidden(list, !hasSubjects);

  if (!hasSubjects) {
    renderStatus();
    return;
  }

  subjects.forEach((subject, index) => {
    const optionId = `subjectSelectorOption-${index}`;
    const li = document.createElement('li');
    li.className = 'flex items-center gap-3 px-4 py-3';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = optionId;
    checkbox.value = subject.value;
    checkbox.checked = selection.has(subject.value);
    checkbox.className = 'h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500';
    checkbox.dataset.subjectValue = subject.value;
    checkbox.setAttribute('role', 'option');
    checkbox.setAttribute('aria-selected', checkbox.checked ? 'true' : 'false');

    checkbox.addEventListener('change', () => {
      const next = getSelection(state.currentProject);
      if (checkbox.checked) {
        next.add(subject.value);
      } else {
        next.delete(subject.value);
      }
      setSelection(state.currentProject, next);
      checkbox.setAttribute('aria-selected', checkbox.checked ? 'true' : 'false');
      renderStatus();
      dispatchSelectionChange();
    });

    const label = document.createElement('label');
    label.htmlFor = optionId;
    label.className = 'flex flex-1 items-center justify-between gap-3 text-sm text-gray-800';
    label.textContent = subject.label || subject.value;

    li.append(checkbox, label);
    list.append(li);
  });

  renderStatus();
}

async function loadSubjects(projectName) {
  if (!projectName) return;
  setLoading(true, 'Loading subjects...');
  try {
    const project = getProjectFromStore(projectName);
    const nameMap = project?.subject_names ?? project?.subjectNames ?? {};
    let items = mapSubjectNamesToOptions(nameMap);

    if (!items.length) {
      try {
        const payload = await fetchSubjectGroups(projectName);
        items = extractSubjectsFromGroups(payload, nameMap);
      } catch (error) {
        console.warn(`[features:${FEATURE_NAME}] Failed to load subjects`, error);
        state.subjectsByProject.set(projectName, { items: [], error: 'Failed to load subjects' });
        setLoading(false, 'Failed to load subjects');
        renderSubjectList();
        return;
      }
    }

    state.subjectsByProject.set(projectName, { items, error: null });
    ensureSelection(projectName, items);
    renderSubjectList();
  } finally {
    setLoading(false, '');
    renderStatus();
  }
}

function handleSelectAll() {
  const subjects = getSubjects(state.currentProject);
  const allValues = subjects.map(item => item.value);
  setSelection(state.currentProject, allValues);
  renderSubjectList();
  dispatchSelectionChange();
}

function handleDeselectAll() {
  setSelection(state.currentProject, []);
  renderSubjectList();
  dispatchSelectionChange();
}

function dispatchSelectionChange() {
  const projectName = state.currentProject;
  if (!projectName) return;
  const selection = Array.from(getSelection(projectName));
  document.dispatchEvent(new CustomEvent('subject-selector:changed', {
    detail: { projectName, subjects: selection },
  }));
}

function renderAvailability() {
  if (!elements.button) return;
  const shouldShow = isProjectMultiSubject(state.currentProject);
  toggleHidden(elements.button, !shouldShow);
  elements.button.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
  elements.button.toggleAttribute('disabled', !shouldShow);

  if (!shouldShow && isModalOpen(elements.modal)) {
    closeModal(elements.modal);
  }
}

function handleProjectSelected(event) {
  const detail = event?.detail || {};
  const projectName = detail.projectName || detail.project?.name || null;
  if (projectName === state.currentProject) {
    renderAvailability();
    return;
  }
  state.currentProject = projectName;
  renderAvailability();
  renderSubjectList();
}

function handleProjectsUpdated() {
  if (state.currentProject) {
    state.subjectsByProject.delete(state.currentProject);
  }
  renderAvailability();
}

function bindEvents() {
  elements.selectAll?.addEventListener('click', handleSelectAll);
  elements.clear?.addEventListener('click', handleDeselectAll);

  const closeHandlers = [elements.close, elements.done, elements.cancel];
  closeHandlers.forEach(btn => {
    btn?.addEventListener('click', () => closeModal(elements.modal));
  });

  document.addEventListener('project:selected', handleProjectSelected);
  document.addEventListener('projects:updated', handleProjectsUpdated);

  state.unsubscribeStore = subscribe(() => {
    renderAvailability();
  });
}

export function openSubjectSelectorModal() {
  const projectName = state.currentProject;
  if (!projectName || !isProjectMultiSubject(projectName)) {
    return;
  }
  openModal(elements.modal, { focusTarget: elements.done || elements.close });
  if (!getSubjects(projectName).length) {
    loadSubjects(projectName).catch(error => {
      console.error(`[features:${FEATURE_NAME}] Failed to fetch subjects`, error);
    });
  } else {
    renderSubjectList();
  }
}

export function init() {
  if (state.initialized) return;
  cacheElements();
  if (!elements.button || !elements.modal) {
    console.warn(`[features:${FEATURE_NAME}] Required elements not found.`);
    return;
  }
  state.initialized = true;
  bindEvents();
  renderAvailability();
  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export default { init, openSubjectSelectorModal };
