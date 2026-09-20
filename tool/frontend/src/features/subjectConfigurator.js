import { updateProject } from '../api/projects.js';
import { fetchSubjectGroups } from '../api/subjects.js';
import { byId, clearChildren, toggleHidden } from '../ui/dom.js';
import { closeModal, openModal, isModalOpen } from '../ui/modal.js';

const FEATURE_NAME = 'subjectConfigurator';

const SUBJECT_MODE_SINGLE = 'single';
const SUBJECT_MODE_MULTI = 'multi';
const SUBJECT_MODAL_MODE_LIST = 'list';
const SUBJECT_MODAL_MODE_LABEL = 'label';
const SUBJECT_NAME_LIMIT = 1024;

const state = {
  projects: [],
  currentProject: null,
  mode: SUBJECT_MODE_SINGLE,
  saving: false,
  selectedArrayIds: new Set(),
  subjectGroups: [],
  subjectGroupsProject: null,
  subjectGroupsLoading: false,
  subjectGroupsError: null,
  subjectGroupsRequestId: 0,
  subjectNameOverrides: new Map(),
  subjectNamesSaving: false,
  subjectsModalMode: SUBJECT_MODAL_MODE_LIST,
};

function createEmptySubjectPreview(selectedArrayCount = 0) {
  return {
    values: [],
    details: [],
    truncated: false,
    selectedArrayCount,
    hasSubjects: false,
  };
}

let selectedSubjectPreview = createEmptySubjectPreview();
let subjectNameEditorInputs = [];

const elements = {};
let initialized = false;

function normalizeSubjectMode(value) {
  if (typeof value === 'string') {
    const cleaned = value.trim().toLowerCase();
    if (!cleaned) {
      return SUBJECT_MODE_SINGLE;
    }
    if (cleaned === SUBJECT_MODE_MULTI || cleaned === 'multi-subject') {
      return SUBJECT_MODE_MULTI;
    }
    if (cleaned === SUBJECT_MODE_SINGLE || cleaned === 'single-subject') {
      return SUBJECT_MODE_SINGLE;
    }
    const collapsed = cleaned.replace(/[\s_-]+/g, ' ');
    if (collapsed === 'multi subject' || collapsed === 'multiple subjects') {
      return SUBJECT_MODE_MULTI;
    }
    if (collapsed === 'single subject') {
      return SUBJECT_MODE_SINGLE;
    }
  }
  return SUBJECT_MODE_SINGLE;
}

function cacheElements() {
  elements.configureBtn = byId('configureSubjectsBtn');
  elements.modal = byId('subjectConfiguratorModal');
  elements.modalClose = byId('subjectConfiguratorModalClose');
  elements.modalBackdrop = document.querySelector('[data-modal="subject-configurator-backdrop"]');
  elements.modeToggle = byId('subjectConfiguratorModeToggle');
  elements.modeLabel = byId('subjectConfiguratorModeLabel');
  elements.modeIndicator = elements.modal?.querySelector('[data-subject-configurator="mode-indicator"]') ?? null;
  elements.cancelBtn = byId('subjectConfiguratorCancelBtn');
  elements.saveBtn = byId('subjectConfiguratorSaveBtn');
  elements.projectSelect = byId('projectSelect');
  elements.multiSection = byId('subjectConfiguratorMultiSection');
  elements.groupStatus = byId('subjectConfiguratorGroupStatus');
  elements.groupList = byId('subjectConfiguratorGroupList');
  elements.subjectPreviewSection = byId('subjectConfiguratorSubjectPreview');
  elements.subjectPreviewEmpty = byId('subjectConfiguratorSubjectPreviewEmpty');
  elements.subjectPreviewWrapper = byId('subjectConfiguratorSubjectPreviewListWrapper');
  elements.subjectPreviewList = byId('subjectConfiguratorSubjectPreviewList');
  elements.subjectPreviewListViewBtn = byId('subjectConfiguratorSubjectPreviewListView');
  elements.subjectPreviewLabelBtn = byId('subjectConfiguratorSubjectPreviewLabel');
  elements.subjectPreviewMeta = byId('subjectConfiguratorSubjectPreviewMeta');
  elements.subjectsModal = byId('subjectConfiguratorSubjectsModal');
  elements.subjectsModalBackdrop = document.querySelector('[data-modal="subject-configurator-subjects-backdrop"]');
  elements.subjectsModalClose = byId('subjectConfiguratorSubjectsModalClose');
  elements.subjectsModalDone = byId('subjectConfiguratorSubjectsModalDone');
  elements.subjectsModalSave = byId('subjectConfiguratorSubjectsModalSave');
  elements.subjectsModalList = byId('subjectConfiguratorSubjectsList');
  elements.subjectsModalMeta = byId('subjectConfiguratorSubjectsMeta');
}

function normalizeSubjectValue(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value == null) {
    return '';
  }
  return String(value).trim();
}

function normalizeSubjectLabel(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value == null) {
    return '';
  }
  return String(value).trim();
}

function normalizeSubjectNameMap(source) {
  const map = new Map();
  if (!source) {
    return map;
  }

  let entries;
  if (source instanceof Map) {
    entries = source.entries();
  } else if (Array.isArray(source)) {
    entries = source;
  } else if (typeof source === 'object') {
    entries = Object.entries(source);
  } else {
    return map;
  }

  for (const entry of entries) {
    let rawKey;
    let rawValue;
    if (Array.isArray(entry)) {
      [rawKey, rawValue] = entry;
    } else if (entry && typeof entry === 'object') {
      const pairs = Object.entries(entry);
      if (!pairs.length) {
        // eslint-disable-next-line no-continue
        continue;
      }
      [rawKey, rawValue] = pairs[0];
    } else {
      // Unsupported entry format
      // eslint-disable-next-line no-continue
      continue;
    }
    const key = normalizeSubjectValue(rawKey);
    if (!key) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const label = normalizeSubjectLabel(rawValue);
    if (!label) {
      // eslint-disable-next-line no-continue
      continue;
    }
    map.set(key, label);
    if (map.size >= SUBJECT_NAME_LIMIT) {
      break;
    }
  }

  return map;
}

function serializeSubjectNameOverrides() {
  const result = {};
  state.subjectNameOverrides.forEach((label, value) => {
    const key = normalizeSubjectValue(value);
    const text = normalizeSubjectLabel(label);
    if (!key || !text) {
      return;
    }
    result[key] = text;
  });
  return result;
}

function getSubjectLabel(value) {
  const key = normalizeSubjectValue(value);
  if (!key) {
    return '';
  }
  return state.subjectNameOverrides.get(key) ?? '';
}

function setSubjectNameOverridesFromProject(project) {
  if (!project) {
    state.subjectNameOverrides = new Map();
    return;
  }
  const record =
    typeof project.subject_names !== 'undefined'
      ? project.subject_names
      : project.subjectNames;
  state.subjectNameOverrides = normalizeSubjectNameMap(record);
}

function setSubjectNamesSaving(isSaving) {
  const saving = Boolean(isSaving);
  state.subjectNamesSaving = saving;
  const { subjectsModalSave } = elements;
  if (subjectsModalSave) {
    subjectsModalSave.disabled = saving;
    if (saving) {
      subjectsModalSave.setAttribute('aria-busy', 'true');
    } else {
      subjectsModalSave.removeAttribute('aria-busy');
    }
  }
}

function updateSubjectsModalMode() {
  const isLabelMode = state.subjectsModalMode === SUBJECT_MODAL_MODE_LABEL;
  toggleHidden(elements.subjectsModalSave, !isLabelMode);
  if (elements.subjectsModalDone) {
    elements.subjectsModalDone.textContent = isLabelMode ? 'Cancel' : 'Close';
  }
}

function serializeSubjectNameInputs() {
  const entries = {};
  subjectNameEditorInputs.forEach(input => {
    if (!input) {
      return;
    }
    const rawKey = input.dataset?.subjectId;
    const key = normalizeSubjectValue(rawKey);
    if (!key) {
      return;
    }
    const label = normalizeSubjectLabel(input.value);
    if (!label) {
      return;
    }
    entries[key] = label;
  });
  return entries;
}

function applySubjectNameUpdate(projectName, record) {
  const normalized = normalizeSubjectNameMap(record);
  state.subjectNameOverrides = normalized;
  const serialized = serializeSubjectNameOverrides();
  const projects = Array.isArray(state.projects) ? state.projects : [];
  const updatedProjects = projects.map(entry => {
    if (!entry || entry.name !== projectName) {
      return entry;
    }
    return {
      ...entry,
      subject_names: serialized,
    };
  });
  state.projects = updatedProjects;
  if (state.currentProject?.name === projectName) {
    const refreshed = findProjectByName(projectName);
    state.currentProject = refreshed || {
      ...state.currentProject,
      subject_names: serialized,
    };
  }
}

function findProjectByName(name) {
  if (!name) return null;
  return state.projects.find(project => project?.name === name) || null;
}

function getProjectArrays(project) {
  if (!project || typeof project !== 'object') return [];
  const arrays = project.arrays;
  return Array.isArray(arrays) ? arrays : [];
}

function buildArrayIdSet(project, candidates) {
  const arrays = getProjectArrays(project);
  const validIds = new Set();
  arrays.forEach(array => {
    if (!array || typeof array !== 'object') return;
    const id = typeof array.id === 'string' ? array.id.trim() : '';
    if (id) {
      validIds.add(id);
    }
  });

  const selected = new Set();
  if (!candidates) {
    return selected;
  }

  let values;
  if (candidates instanceof Set) {
    values = Array.from(candidates);
  } else if (Array.isArray(candidates)) {
    values = candidates;
  } else {
    values = [candidates];
  }

  values.forEach(value => {
    const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
    if (!text) return;
    if (validIds.size && !validIds.has(text)) return;
    selected.add(text);
  });

  return selected;
}

function setSelectedArrays(project, candidates) {
  const targetProject = project || state.currentProject;
  state.selectedArrayIds = buildArrayIdSet(targetProject, candidates);
}

function syncSelectedArrays(project) {
  const targetProject = project || state.currentProject;
  if (!targetProject) {
    state.selectedArrayIds = new Set();
    return;
  }
  const stored = Array.isArray(targetProject.subject_arrays)
    ? targetProject.subject_arrays
    : Array.isArray(targetProject.subjectArrays)
      ? targetProject.subjectArrays
      : [];
  state.selectedArrayIds = buildArrayIdSet(targetProject, stored);
}

function pruneSelectedArrayIds(project) {
  const targetProject = project || state.currentProject;
  state.selectedArrayIds = buildArrayIdSet(targetProject, Array.from(state.selectedArrayIds));
}

function getSelectedArrayIds() {
  return Array.from(state.selectedArrayIds);
}

function getCurrentProjectName() {
  return state.currentProject?.name ?? null;
}

function toggleSubjectArraySelection(arrayId, shouldSelect) {
  const text = typeof arrayId === 'string' ? arrayId.trim() : String(arrayId ?? '').trim();
  if (!text) return;
  if (shouldSelect) {
    state.selectedArrayIds.add(text);
  } else {
    state.selectedArrayIds.delete(text);
  }
}

function formatArrayLabel(arrayId, fallbackName) {
  const arrays = getProjectArrays(state.currentProject);
  const entry = arrays.find(array => array?.id === arrayId) || null;
  const base = [
    entry?.display_name,
    entry?.displayName,
    entry?.name,
    fallbackName,
    arrayId,
  ].find(value => typeof value === 'string' && value.trim());
  const label = base ? base.trim() : arrayId;

  let shapeLabel = '';
  if (entry) {
    if (Array.isArray(entry.shape) && entry.shape.length) {
      shapeLabel = entry.shape.join('×');
    } else if (typeof entry.shapeLabel === 'string' && entry.shapeLabel.trim()) {
      shapeLabel = entry.shapeLabel.trim();
    } else if (typeof entry.shape_label === 'string' && entry.shape_label.trim()) {
      shapeLabel = entry.shape_label.trim();
    }
  }

  return shapeLabel ? `${label} · ${shapeLabel}` : label;
}

function formatGroupTitle(group) {
  if (!group || typeof group !== 'object') {
    return 'No subjects detected';
  }
  const count = Number.isFinite(group.subject_count) ? group.subject_count : 0;
  const approximate = Boolean(group.values_truncated || group.sample_limited);
  if (count <= 0) {
    return 'No subjects detected';
  }
  if (approximate) {
    return count === 1
      ? 'At least 1 possible subject detected'
      : `At least ${count.toLocaleString()} possible subjects detected`;
  }
  return count === 1
    ? 'Identified 1 possible subject'
    : `Identified ${count.toLocaleString()} possible subjects`;
}

function setGroupStatus(message, { tone = 'muted' } = {}) {
  const el = elements.groupStatus;
  if (!el) return;
  const text = typeof message === 'string' ? message : '';
  if (!text) {
    el.textContent = '';
    el.classList.add('hidden');
    el.classList.remove('text-red-600');
    el.classList.add('text-gray-500');
    return;
  }
  el.textContent = text;
  el.classList.remove('hidden');
  el.classList.toggle('text-red-600', tone === 'error');
  el.classList.toggle('text-gray-500', tone !== 'error');
}

function resetSubjectGroupState() {
  state.subjectGroups = [];
  state.subjectGroupsProject = null;
  state.subjectGroupsError = null;
  state.subjectGroupsLoading = false;
  state.subjectGroupsRequestId += 1;
}

function computeSelectedSubjectPreview() {
  const selectedIds = getSelectedArrayIds();
  const selectedCount = selectedIds.length;
  if (!selectedCount) {
    return createEmptySubjectPreview(0);
  }

  const selectedSet = new Set(selectedIds);
  const orderedValues = [];
  const valueToArrays = new Map();
  let truncated = false;
  let hasSubjects = false;

  state.subjectGroups.forEach(group => {
    if (!group || typeof group !== 'object') {
      return;
    }
    const summaries = Array.isArray(group.arrays) ? group.arrays : [];
    summaries.forEach(summary => {
      if (!summary || typeof summary !== 'object') {
        return;
      }
      const arrayId = typeof summary.array_id === 'string' ? summary.array_id : '';
      if (!arrayId || !selectedSet.has(arrayId)) {
        return;
      }

      const valueCount = Number.isFinite(summary.value_count) ? summary.value_count : 0;
      if (valueCount > 0) {
        hasSubjects = true;
      }

      const values = Array.isArray(summary.values) ? summary.values : [];
      if (
        summary.values_truncated
        || summary.sample_limited
        || valueCount > values.length
      ) {
        truncated = true;
      }

      const arrayLabel = formatArrayLabel(summary.array_id, summary.array_name);

      values.forEach(rawValue => {
        const text = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue ?? '').trim();
        if (!text) {
          return;
        }
        if (!valueToArrays.has(text)) {
          valueToArrays.set(text, new Set());
          orderedValues.push(text);
        }
        valueToArrays.get(text).add(arrayLabel);
      });
    });
  });

  const details = orderedValues.map(value => ({
    value,
    label: getSubjectLabel(value),
    arrays: Array.from(valueToArrays.get(value) ?? []),
  }));

  return {
    values: orderedValues,
    details,
    truncated,
    selectedArrayCount: selectedCount,
    hasSubjects,
  };
}

function renderSelectedSubjectsPreview() {
  const section = elements.subjectPreviewSection;
  if (!section) return;

  const {
    subjectPreviewEmpty: empty,
    subjectPreviewWrapper: wrapper,
    subjectPreviewList: list,
    subjectPreviewListViewBtn: listViewBtn,
    subjectPreviewLabelBtn: labelBtn,
    subjectPreviewMeta: meta,
  } = elements;

  const disableActions = () => {
    if (listViewBtn) listViewBtn.disabled = true;
    if (labelBtn) labelBtn.disabled = true;
  };

  const isMulti = state.mode === SUBJECT_MODE_MULTI;
  section.classList.toggle('hidden', !isMulti);

  if (!isMulti) {
    selectedSubjectPreview = createEmptySubjectPreview();
    if (list) clearChildren(list);
    if (wrapper) wrapper.classList.add('hidden');
    disableActions();
    if (empty) {
      empty.textContent = 'Enable multi-subject mode to inspect identified subjects.';
      empty.classList.remove('hidden');
    }
    if (meta) {
      meta.textContent = '';
      meta.classList.add('hidden');
    }
    return;
  }

  const selectedIds = getSelectedArrayIds();
  const selectedCount = selectedIds.length;

  if (!selectedCount) {
    selectedSubjectPreview = createEmptySubjectPreview(0);
    if (list) clearChildren(list);
    if (wrapper) wrapper.classList.add('hidden');
    disableActions();
    if (empty) {
      empty.textContent = 'Select subject arrays to preview the identified subjects.';
      empty.classList.remove('hidden');
    }
    if (meta) {
      meta.textContent = '';
      meta.classList.add('hidden');
    }
    return;
  }

  if (state.subjectGroupsLoading && !state.subjectGroups.length) {
    selectedSubjectPreview = createEmptySubjectPreview(selectedCount);
    if (list) clearChildren(list);
    if (wrapper) wrapper.classList.add('hidden');
    disableActions();
    if (empty) {
      empty.textContent = 'Scanning selected arrays for subject identifiers…';
      empty.classList.remove('hidden');
    }
    if (meta) {
      const arrayLabel = selectedCount === 1 ? '1 selected array' : `${selectedCount} selected arrays`;
      meta.textContent = `Based on ${arrayLabel}.`;
      meta.classList.remove('hidden');
    }
    return;
  }

  const preview = computeSelectedSubjectPreview();
  preview.selectedArrayCount = selectedCount;
  selectedSubjectPreview = preview;

  if (!preview.values.length) {
    if (list) clearChildren(list);
    if (wrapper) wrapper.classList.add('hidden');
    disableActions();
    if (empty) {
      if (preview.hasSubjects && preview.truncated) {
        empty.textContent =
          'Subjects were detected, but their values could not be previewed because of sampling limits.';
      } else {
        empty.textContent = 'No subjects identified yet for the selected arrays.';
      }
      empty.classList.remove('hidden');
    }
    if (meta) {
      const arrayLabel = selectedCount === 1 ? '1 selected array' : `${selectedCount} selected arrays`;
      let note = `Based on ${arrayLabel}.`;
      if (preview.truncated) {
        note += ' Subject previews may be limited because the sampled data is truncated.';
      }
      meta.textContent = note;
      meta.classList.remove('hidden');
    }
    return;
  }

  if (empty) {
    empty.textContent = '';
    empty.classList.add('hidden');
  }

  if (list) {
    clearChildren(list);
    const displayValues = preview.values.slice(0, 5);
    displayValues.forEach(value => {
      const item = document.createElement('li');
      item.className =
        'inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700';
      const label = getSubjectLabel(value);
      const displayText = label || value;
      item.textContent = displayText;
      if (label) {
        item.title = `Subject ID: ${value}`;
      }
      list.appendChild(item);
    });
    const needsEllipsis = preview.values.length > displayValues.length || preview.truncated;
    if (needsEllipsis) {
      const more = document.createElement('li');
      more.className =
        'inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500';
      more.textContent = '…';
      list.appendChild(more);
    }
  }

  if (wrapper) {
    wrapper.classList.remove('hidden');
  }

  if (listViewBtn) {
    listViewBtn.disabled = false;
  }
  if (labelBtn) {
    labelBtn.disabled = preview.values.length === 0;
  }

  if (meta) {
    const arrayLabel = selectedCount === 1 ? '1 selected array' : `${selectedCount} selected arrays`;
    const visibleCount = Math.min(5, preview.values.length);
    let text;
    if (preview.values.length <= 5 && !preview.truncated) {
      text = `Showing all ${preview.values.length} identified subject${preview.values.length === 1 ? '' : 's'} from ${arrayLabel}.`;
    } else {
      text = `Showing ${visibleCount} of ${preview.values.length} identified subject${preview.values.length === 1 ? '' : 's'} from ${arrayLabel}.`;
    }
    if (preview.truncated) {
      text += ' Some subject values may be hidden because of sampling limits.';
    }
    text += ' Open List View to explore every subject.';
    meta.textContent = text;
    meta.classList.remove('hidden');
  }
}

function renderSubjectPreviewModalContent(preview) {
  const list = elements.subjectsModalList;
  if (!list) return;
  clearChildren(list);
  subjectNameEditorInputs = [];

  const meta = elements.subjectsModalMeta;
  if (meta) {
    meta.textContent = '';
    meta.classList.add('hidden');
  }
  const selectedCount = preview?.selectedArrayCount ?? 0;
  const arrayLabel = selectedCount === 1 ? '1 selected array' : `${selectedCount} selected arrays`;
  const isLabelMode = state.subjectsModalMode === SUBJECT_MODAL_MODE_LABEL;

  if (!preview || !preview.values.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'px-3 py-3 text-sm text-gray-500';
    if (!selectedCount) {
      cell.textContent = 'Select subject arrays to view the identified subjects.';
    } else if (preview?.hasSubjects && preview.truncated) {
      cell.textContent = 'Subjects were detected, but their values could not be listed because of sampling limits.';
    } else {
      cell.textContent = 'No subjects identified for the selected arrays.';
    }
    row.appendChild(cell);
    list.appendChild(row);
    if (meta) {
      let message = !selectedCount
        ? 'Select subject arrays to view identified subjects.'
        : `No subjects identified from ${arrayLabel}.`;
      if (preview?.truncated && selectedCount) {
        message += ' Subject details may be limited because the sampled data is truncated.';
      }
      meta.textContent = message;
      meta.classList.remove('hidden');
    }
    return;
  }

  preview.details.forEach((entry, index) => {
    const row = document.createElement('tr');
    row.className = index % 2 === 0 ? 'bg-white' : 'bg-gray-50';

    const numberCell = document.createElement('td');
    numberCell.className = 'px-3 py-2 text-sm text-gray-500';
    numberCell.textContent = String(index + 1);

    const valueCell = document.createElement('td');
    valueCell.className = 'px-3 py-2 text-sm font-medium text-gray-900';
    valueCell.textContent = entry.value;

    const labelCell = document.createElement('td');
    if (isLabelMode) {
      labelCell.className = 'px-3 py-2';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = entry.label || '';
      input.placeholder = 'Add name';
      input.dataset.subjectId = entry.value;
      input.className =
        'w-full rounded-lg border border-gray-300 px-2 py-1 text-sm text-gray-700 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';
      input.setAttribute('aria-label', `Name for subject ${entry.value}`);
      labelCell.appendChild(input);
      subjectNameEditorInputs.push(input);
    } else {
      labelCell.className = 'px-3 py-2 text-sm text-gray-500';
      labelCell.textContent = entry.label || '—';
    }

    const arraysCell = document.createElement('td');
    arraysCell.className = 'px-3 py-2 text-sm text-gray-500';
    arraysCell.textContent = entry.arrays && entry.arrays.length ? entry.arrays.join(', ') : '—';

    row.append(numberCell, valueCell, labelCell, arraysCell);
    list.appendChild(row);
  });

  if (meta) {
    let text = `Showing ${preview.values.length} subject${preview.values.length === 1 ? '' : 's'} from ${arrayLabel}.`;
    if (preview.truncated) {
      text += ' Some subject values may be hidden because of sampling limits.';
    }
    if (isLabelMode) {
      text += ' Add or edit names, then save to store them.';
    }
    meta.textContent = text;
    meta.classList.remove('hidden');
  }
}

function openSubjectsModal({ mode = SUBJECT_MODAL_MODE_LIST } = {}) {
  if (!elements.subjectsModal) return;
  state.subjectsModalMode =
    mode === SUBJECT_MODAL_MODE_LABEL ? SUBJECT_MODAL_MODE_LABEL : SUBJECT_MODAL_MODE_LIST;
  updateSubjectsModalMode();
  setSubjectNamesSaving(false);
  renderSubjectPreviewModalContent(selectedSubjectPreview);
  const focusTarget =
    state.subjectsModalMode === SUBJECT_MODAL_MODE_LABEL
      ? subjectNameEditorInputs.find(input => input && !input.disabled)
          || elements.subjectsModalSave
          || elements.subjectsModalDone
      : elements.subjectsModalDone;
  openModal(elements.subjectsModal, {
    focusTarget,
  });
}

function closeSubjectsModal() {
  if (!elements.subjectsModal) return;
  closeModal(elements.subjectsModal);
  state.subjectsModalMode = SUBJECT_MODAL_MODE_LIST;
  setSubjectNamesSaving(false);
  updateSubjectsModalMode();
  subjectNameEditorInputs = [];
}

function renderSubjectGroups() {
  const list = elements.groupList;
  if (!list) return;
  clearChildren(list);

  if (state.mode !== SUBJECT_MODE_MULTI) {
    setGroupStatus('', { tone: 'muted' });
    renderSelectedSubjectsPreview();
    return;
  }

  const projectName = getCurrentProjectName();
  if (!projectName) {
    setGroupStatus('Select a project to inspect arrays for subjects.', { tone: 'muted' });
    renderSelectedSubjectsPreview();
    return;
  }

  if (state.subjectGroupsLoading) {
    setGroupStatus('Scanning arrays for subject identifiers…', { tone: 'muted' });
    renderSelectedSubjectsPreview();
    return;
  }

  if (state.subjectGroupsError) {
    setGroupStatus(state.subjectGroupsError, { tone: 'error' });
    renderSelectedSubjectsPreview();
    return;
  }

  if (!state.subjectGroups.length) {
    setGroupStatus('No subject identifiers detected yet. Select arrays manually if needed.', { tone: 'muted' });
    renderSelectedSubjectsPreview();
    return;
  }

  setGroupStatus('', { tone: 'muted' });

  const sortedGroups = Array.isArray(state.subjectGroups)
    ? [...state.subjectGroups].sort((a, b) => {
      const aCount = Number.isFinite(a?.subject_count) ? a.subject_count : Number.POSITIVE_INFINITY;
      const bCount = Number.isFinite(b?.subject_count) ? b.subject_count : Number.POSITIVE_INFINITY;
      if (aCount !== bCount) {
        return aCount - bCount;
      }
      const aArrayCount = Array.isArray(a?.arrays) ? a.arrays.length : 0;
      const bArrayCount = Array.isArray(b?.arrays) ? b.arrays.length : 0;
      if (aArrayCount !== bArrayCount) {
        return bArrayCount - aArrayCount;
      }
      const aKey = typeof a?.id === 'string' ? a.id : '';
      const bKey = typeof b?.id === 'string' ? b.id : '';
      return aKey.localeCompare(bKey);
    })
    : [];

  sortedGroups.forEach(group => {
    const card = document.createElement('div');
    card.className = 'space-y-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm';

    const header = document.createElement('div');
    header.className = 'flex flex-wrap items-start justify-between gap-2';

    const title = document.createElement('h4');
    title.className = 'text-sm font-semibold text-gray-900';
    title.textContent = formatGroupTitle(group);
    header.appendChild(title);

    const countBadge = document.createElement('span');
    countBadge.className = 'rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700';
    const arrayCount = Array.isArray(group.arrays) ? group.arrays.length : 0;
    countBadge.textContent = arrayCount === 1 ? '1 array' : `${arrayCount} arrays`;
    header.appendChild(countBadge);

    card.appendChild(header);

    if (Array.isArray(group.values) && group.values.length) {
      const valuesList = document.createElement('ul');
      valuesList.className = 'flex flex-wrap gap-1.5';
      group.values.forEach(value => {
        const item = document.createElement('li');
        item.className = 'inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700';
        item.textContent = value;
        valuesList.appendChild(item);
      });
      if (group.values_truncated) {
        const more = document.createElement('li');
        more.className = 'inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500';
        more.textContent = '…';
        valuesList.appendChild(more);
      } else if (
        Number.isFinite(group.subject_count)
        && group.subject_count > group.values.length
      ) {
        const extra = document.createElement('li');
        extra.className = 'inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500';
        const remaining = group.subject_count - group.values.length;
        extra.textContent = `+${remaining}`;
        valuesList.appendChild(extra);
      }
      card.appendChild(valuesList);
    }

    if (group.sample_limited) {
      const note = document.createElement('p');
      note.className = 'text-xs text-gray-500';
      note.textContent = 'Values estimated from a sample of rows.';
      card.appendChild(note);
    }

    const checkboxList = document.createElement('div');
    checkboxList.className = 'flex flex-col gap-2 sm:flex-row sm:flex-wrap';

    const summaries = Array.isArray(group.arrays)
      ? [...group.arrays].sort((a, b) => {
        const aCount = Number.isFinite(a?.value_count) ? a.value_count : Number.POSITIVE_INFINITY;
        const bCount = Number.isFinite(b?.value_count) ? b.value_count : Number.POSITIVE_INFINITY;
        if (aCount !== bCount) {
          return aCount - bCount;
        }
        const aName = typeof a?.array_name === 'string' && a.array_name.trim()
          ? a.array_name.trim().toLowerCase()
          : typeof a?.array_id === 'string'
            ? a.array_id.toLowerCase()
            : '';
        const bName = typeof b?.array_name === 'string' && b.array_name.trim()
          ? b.array_name.trim().toLowerCase()
          : typeof b?.array_id === 'string'
            ? b.array_id.toLowerCase()
            : '';
        return aName.localeCompare(bName);
      })
      : [];

    summaries.forEach(summary => {
      const item = document.createElement('label');
      item.className = 'flex w-full items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm shadow-sm transition hover:border-indigo-300 hover:bg-white focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-200 sm:w-auto';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = summary.array_id;
      checkbox.className = 'h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500';
      checkbox.checked = state.selectedArrayIds.has(summary.array_id);
      checkbox.addEventListener('change', event => {
        toggleSubjectArraySelection(summary.array_id, event.target.checked);
        renderSelectedSubjectsPreview();
      });

      const label = document.createElement('span');
      label.className = 'font-medium text-gray-800';
      label.textContent = formatArrayLabel(summary.array_id, summary.array_name);

      const meta = document.createElement('span');
      meta.className = 'text-xs text-gray-500';
      const uniqueCount = Number.isFinite(summary.value_count) ? summary.value_count : null;
      meta.textContent = uniqueCount === null
        ? ''
        : uniqueCount === 1
          ? '1 unique value'
          : `${uniqueCount} unique values`;

      item.appendChild(checkbox);
      const textWrapper = document.createElement('span');
      textWrapper.className = 'flex flex-col';
      textWrapper.appendChild(label);
      if (meta.textContent) {
        textWrapper.appendChild(meta);
      }
      item.appendChild(textWrapper);

      checkboxList.appendChild(item);
    });

    card.appendChild(checkboxList);
    list.appendChild(card);
  });

  renderSelectedSubjectsPreview();
}

async function loadSubjectGroupsForProject(projectName) {
  if (!projectName) {
    return;
  }
  const requestId = ++state.subjectGroupsRequestId;
  state.subjectGroupsLoading = true;
  state.subjectGroupsError = null;
  renderSubjectGroups();
  try {
    const response = await fetchSubjectGroups(projectName);
    if (state.subjectGroupsRequestId !== requestId) {
      return;
    }
    const groups = Array.isArray(response?.groups) ? response.groups : [];
    state.subjectGroups = groups;
    if (response && typeof response.subject_names !== 'undefined') {
      applySubjectNameUpdate(projectName, response.subject_names);
    }
    state.subjectGroupsProject = response?.project || projectName;
    const selectedIds = Array.isArray(response?.selected_array_ids)
      ? response.selected_array_ids
      : [];
    if (selectedIds.length) {
      setSelectedArrays(state.currentProject, selectedIds);
    } else {
      pruneSelectedArrayIds(state.currentProject);
    }
  } catch (error) {
    if (state.subjectGroupsRequestId !== requestId) {
      return;
    }
    console.error(`[Feature:${FEATURE_NAME}] Failed to load subject groups`, error);
    const message = error?.message || 'Unable to analyze subjects for this project.';
    state.subjectGroupsError = message;
    state.subjectGroups = [];
  } finally {
    if (state.subjectGroupsRequestId === requestId) {
      state.subjectGroupsLoading = false;
      renderSubjectGroups();
    }
  }
}

function ensureSubjectGroupsLoaded() {
  if (state.mode !== SUBJECT_MODE_MULTI) {
    renderSubjectGroups();
    return;
  }
  const projectName = getCurrentProjectName();
  if (!projectName) {
    renderSubjectGroups();
    return;
  }
  if (state.subjectGroupsLoading) {
    return;
  }
  if (state.subjectGroupsProject === projectName && !state.subjectGroupsError) {
    renderSubjectGroups();
    return;
  }
  void loadSubjectGroupsForProject(projectName);
}

function updateModeDisplay() {
  const isMulti = state.mode === SUBJECT_MODE_MULTI;
  const { modeToggle, modeLabel, modeIndicator } = elements;

  if (modeToggle) {
    modeToggle.setAttribute('aria-checked', isMulti ? 'true' : 'false');
    modeToggle.dataset.mode = state.mode;
    modeToggle.classList.toggle('bg-indigo-600', isMulti);
    modeToggle.classList.toggle('bg-gray-200', !isMulti);
  }

  if (modeLabel) {
    modeLabel.textContent = isMulti ? 'Multi-subject' : 'Single subject';
  }

  if (modeIndicator) {
    modeIndicator.classList.toggle('translate-x-5', isMulti);
    modeIndicator.classList.toggle('translate-x-1', !isMulti);
  }

  toggleHidden(elements.multiSection, !isMulti);
  toggleHidden(elements.subjectPreviewSection, !isMulti);
  if (isMulti) {
    ensureSubjectGroupsLoaded();
  } else {
    setGroupStatus('', { tone: 'muted' });
    if (elements.groupList) {
      clearChildren(elements.groupList);
    }
  }

  renderSelectedSubjectsPreview();
}

function setMode(mode) {
  state.mode = normalizeSubjectMode(mode);
  updateModeDisplay();
}

function toggleMode() {
  setMode(state.mode === SUBJECT_MODE_SINGLE ? SUBJECT_MODE_MULTI : SUBJECT_MODE_SINGLE);
}

function setSavingState(isSaving) {
  const saving = Boolean(isSaving);
  state.saving = saving;
  const { saveBtn } = elements;
  if (saveBtn) {
    saveBtn.disabled = saving;
    if (saving) {
      saveBtn.setAttribute('aria-busy', 'true');
    } else {
      saveBtn.removeAttribute('aria-busy');
    }
  }
}

function resolveProjectMode(project) {
  if (!project || typeof project !== 'object') {
    return SUBJECT_MODE_SINGLE;
  }
  const rawMode =
    typeof project.subject_mode !== 'undefined'
      ? project.subject_mode
      : project.subjectMode;
  return normalizeSubjectMode(rawMode);
}

function updateButtonState(project) {
  if (elements.configureBtn) {
    elements.configureBtn.disabled = !project;
  }
}

function handleProjectSelected(event) {
  const { project, projectName } = event.detail || {};
  let resolved = project || null;
  if (!resolved && projectName) {
    resolved = findProjectByName(projectName);
  }
  const previousName = state.currentProject?.name ?? null;
  const nextName = resolved?.name ?? null;
  state.currentProject = resolved;
  setSubjectNameOverridesFromProject(resolved);
  syncSelectedArrays(resolved);
  if (previousName !== nextName) {
    resetSubjectGroupState();
  } else {
    pruneSelectedArrayIds(resolved);
  }
  setMode(resolveProjectMode(resolved));
  updateButtonState(resolved);
  if (state.mode !== SUBJECT_MODE_MULTI) {
    renderSubjectGroups();
  }
  if (!resolved && elements.modal && isModalOpen(elements.modal)) {
    closeSubjectConfigurator({ userInitiated: false });
  }
}

function handleProjectsUpdated(event) {
  const { projects = [] } = event.detail || {};
  state.projects = Array.isArray(projects) ? [...projects] : [];
  const selectValue = elements.projectSelect?.value;
  const projectName = selectValue || state.currentProject?.name;
  const nextProject = projectName ? findProjectByName(projectName) : null;
  const previousName = state.currentProject?.name ?? null;
  const nextName = nextProject?.name ?? null;
  state.currentProject = nextProject;
  setSubjectNameOverridesFromProject(nextProject);
  syncSelectedArrays(nextProject);
  if (previousName !== nextName) {
    resetSubjectGroupState();
  } else {
    pruneSelectedArrayIds(nextProject);
  }
  setMode(resolveProjectMode(nextProject));
  updateButtonState(nextProject);
  if (state.mode !== SUBJECT_MODE_MULTI) {
    renderSubjectGroups();
  }
}

function handleProjectDeleted() {
  state.currentProject = null;
  state.selectedArrayIds = new Set();
  setSubjectNameOverridesFromProject(null);
  resetSubjectGroupState();
  setMode(SUBJECT_MODE_SINGLE);
  updateButtonState(null);
  if (elements.modal && isModalOpen(elements.modal)) {
    closeSubjectConfigurator({ userInitiated: false });
  }
  renderSubjectGroups();
}

function openSubjectConfigurator() {
  if (!elements.modal || !elements.configureBtn || elements.configureBtn.disabled) return;
  setSavingState(false);
  updateModeDisplay();
  openModal(elements.modal, {
    focusTarget: elements.modeToggle,
  });
}

function closeSubjectConfigurator({ userInitiated = false } = {}) {
  void userInitiated;
  closeSubjectsModal();
  if (!elements.modal) return;
  closeModal(elements.modal);
}

function emitSaveEvent() {
  const detail = {
    mode: state.mode,
    project: state.currentProject || null,
  };
  const event = new CustomEvent('subject-configurator:save', { detail });
  document.dispatchEvent(event);
}

async function persistSubjectNames() {
  const projectName = getCurrentProjectName();
  if (!projectName || state.subjectNamesSaving) {
    return false;
  }

  const entries = serializeSubjectNameInputs();
  setSubjectNamesSaving(true);

  try {
    await updateProject(projectName, { subject_names: entries });
    applySubjectNameUpdate(projectName, entries);
    renderSelectedSubjectsPreview();
    return true;
  } catch (error) {
    console.error('[Feature:subjectConfigurator] Failed to save subject names', error);
    return false;
  } finally {
    setSubjectNamesSaving(false);
  }
}

async function persistSubjectConfiguration() {
  const project = state.currentProject;
  if (!project || !project.name || state.saving) {
    return false;
  }

  const projectName = project.name;
  setSavingState(true);

  try {
    const selectedIds = state.mode === SUBJECT_MODE_MULTI ? getSelectedArrayIds() : [];
    const subjectNames = serializeSubjectNameOverrides();
    await updateProject(projectName, {
      subject_mode: state.mode,
      subject_arrays: selectedIds,
      subject_names: subjectNames,
    });
    const projects = Array.isArray(state.projects) ? state.projects : [];
    const updatedProjects = projects.map(entry => {
      if (!entry || entry.name !== projectName) {
        return entry;
      }
      return {
        ...entry,
        subject_mode: state.mode,
        subject_arrays: selectedIds,
        subject_names: subjectNames,
      };
    });
    state.projects = updatedProjects;
    state.currentProject = findProjectByName(projectName) || {
      ...project,
      subject_mode: state.mode,
      subject_arrays: selectedIds,
      subject_names: subjectNames,
    };
    setSubjectNameOverridesFromProject(state.currentProject);
    syncSelectedArrays(state.currentProject);
    if (state.mode === SUBJECT_MODE_MULTI) {
      pruneSelectedArrayIds(state.currentProject);
    }
    renderSubjectGroups();
    emitSaveEvent();
    document.dispatchEvent(
      new CustomEvent('projects:refresh-requested', {
        detail: {
          reason: 'subject-configurator:saved',
          preferredProject: projectName,
          projectName,
        },
      }),
    );
    return true;
  } catch (error) {
    console.error('[Feature:subjectConfigurator] Failed to save subject mode', error);
    return false;
  } finally {
    setSavingState(false);
  }
}

function attachEventListeners() {
  elements.configureBtn?.addEventListener('click', () => {
    openSubjectConfigurator();
  });

  elements.modalClose?.addEventListener('click', () => {
    closeSubjectConfigurator({ userInitiated: true });
  });

  elements.modalBackdrop?.addEventListener('click', () => {
    closeSubjectConfigurator({ userInitiated: true });
  });

  elements.cancelBtn?.addEventListener('click', () => {
    closeSubjectConfigurator({ userInitiated: true });
  });

  elements.saveBtn?.addEventListener('click', () => {
    persistSubjectConfiguration()
      .then(success => {
        if (success) {
          closeSubjectConfigurator({ userInitiated: true });
        }
      })
      .catch(error => {
        console.error('[Feature:subjectConfigurator] Unexpected save error', error);
      });
  });

  elements.modeToggle?.addEventListener('click', () => {
    toggleMode();
  });

  elements.subjectPreviewListViewBtn?.addEventListener('click', () => {
    openSubjectsModal({ mode: SUBJECT_MODAL_MODE_LIST });
  });

  elements.subjectPreviewLabelBtn?.addEventListener('click', () => {
    openSubjectsModal({ mode: SUBJECT_MODAL_MODE_LABEL });
  });

  elements.subjectsModalClose?.addEventListener('click', () => {
    closeSubjectsModal();
  });

  elements.subjectsModalBackdrop?.addEventListener('click', () => {
    closeSubjectsModal();
  });

  elements.subjectsModalDone?.addEventListener('click', () => {
    closeSubjectsModal();
  });

  elements.subjectsModalSave?.addEventListener('click', () => {
    persistSubjectNames()
      .then(success => {
        if (success) {
          closeSubjectsModal();
        }
      })
      .catch(error => {
        console.error('[Feature:subjectConfigurator] Unexpected subject name save error', error);
      });
  });

  document.addEventListener('project:selected', handleProjectSelected);
  document.addEventListener('projects:updated', handleProjectsUpdated);
  document.addEventListener('project:deleted', handleProjectDeleted);
}

export function init() {
  if (initialized) return;
  cacheElements();
  if (!elements.configureBtn || !elements.modal) {
    console.warn('[Feature:subjectConfigurator] Required elements not found.');
    return;
  }
  setSavingState(false);
  setSubjectNamesSaving(false);
  updateModeDisplay();
  updateButtonState(null);
  updateSubjectsModalMode();
  attachEventListeners();
  initialized = true;
  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export default { init };
