import { byId, setStatusMessage } from '../ui/dom.js';
import { openModal, closeModal } from '../ui/modal.js';
import { importProjectZip } from '../api/projects.js';

const FEATURE_NAME = 'uploadProject';

const state = {
  fileEntry: null,
  uploading: false,
  initialized: false,
};

const elements = {};

function cacheElements() {
  elements.modal = byId('uploadProjectModal');
  elements.backdrop = document.querySelector('[data-modal="upload-project-backdrop"]');
  elements.closeBtn = byId('uploadProjectModalClose');
  elements.form = byId('uploadProjectForm');
  elements.dropzone = byId('uploadProjectDropzone');
  elements.fileInput = byId('uploadProjectFileInput');
  elements.fileList = byId('uploadProjectFileList');
  elements.status = byId('uploadProjectStatus');
  elements.cancelBtn = byId('uploadProjectCancelBtn');
  elements.submitBtn = byId('uploadProjectSubmitBtn');
}

function formatTone(tone) {
  if (tone === 'error') return { tone: 'error', isError: true };
  if (tone === 'success') return { tone: 'success' };
  if (tone === 'info') return { tone: 'info' };
  return { tone: 'muted' };
}

function resetForm() {
  state.fileEntry = null;
  state.uploading = false;
  if (elements.fileInput) elements.fileInput.value = '';
  renderFileList();
  updateControls();
  setStatusMessage(elements.status, 'Select a ZIP file to restore.', formatTone('muted'));
}

function renderFileList() {
  const list = elements.fileList;
  if (!list) return;
  list.innerHTML = '';
  if (!state.fileEntry) {
    const empty = document.createElement('li');
    empty.className = 'rounded-lg border border-dashed border-gray-300 bg-white px-4 py-3 text-center text-sm text-gray-400';
    empty.textContent = 'No ZIP selected.';
    list.append(empty);
    return;
  }
  const item = document.createElement('li');
  item.className = 'flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 shadow-sm';
  const info = document.createElement('div');
  info.className = 'min-w-0 flex-1';
  const name = document.createElement('p');
  name.className = 'truncate text-sm font-medium text-gray-800';
  name.textContent = state.fileEntry.file?.name ?? 'project.zip';
  const meta = document.createElement('p');
  meta.className = 'text-xs text-gray-500';
  meta.textContent = `${(state.fileEntry.file.size / 1024).toFixed(1)} KB`;
  info.append(name, meta);
  const actions = document.createElement('div');
  actions.className = 'flex items-center gap-3';
  if (!state.uploading) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'rounded-full p-1 text-gray-400 transition hover:bg-red-50 hover:text-red-600';
    removeBtn.innerHTML = '<span class="sr-only">Remove file</span>×';
    removeBtn.addEventListener('click', () => {
      state.fileEntry = null;
      renderFileList();
      updateControls();
      setStatusMessage(elements.status, 'File removed. Select a ZIP file to restore.', formatTone('info'));
    });
    actions.append(removeBtn);
  }
  item.append(info, actions);
  list.append(item);
}

function updateControls() {
  if (elements.submitBtn) {
    elements.submitBtn.disabled = !state.fileEntry || state.uploading;
  }
  if (elements.cancelBtn) {
    elements.cancelBtn.disabled = state.uploading;
  }
}

function setDropzoneActive(active) {
  const dz = elements.dropzone;
  if (!dz) return;
  dz.classList.toggle('ring-2', active);
  dz.classList.toggle('ring-indigo-300', active);
  dz.classList.toggle('bg-indigo-50', active);
  dz.classList.toggle('bg-gray-50', !active);
}

function handleFileSelection(files) {
  if (!files || !files.length) return;
  const file = files[0];
  const lower = file.name.toLowerCase();
  if (!lower.endsWith('.zip')) {
    setStatusMessage(elements.status, 'Unsupported file type. Only .zip archives are allowed.', formatTone('error'));
    return;
  }
  state.fileEntry = { file };
  renderFileList();
  updateControls();
  setStatusMessage(elements.status, 'ZIP file ready to restore.', formatTone('info'));
}

async function handleSubmit(event) {
  event.preventDefault();
  if (!state.fileEntry?.file || state.uploading) return;
  state.uploading = true;
  updateControls();
  elements.submitBtn.textContent = 'Restoring…';
  setStatusMessage(elements.status, 'Uploading archive…', formatTone('info'));
  try {
    const formData = new FormData();
    formData.append('file', state.fileEntry.file, state.fileEntry.file.name);
    const response = await importProjectZip(formData);
    const projectName = response?.project_name || response?.filename || response?.name;
    setStatusMessage(elements.status, `Project restored: ${projectName || 'Unknown name'}`, formatTone('success'));
    document.dispatchEvent(new CustomEvent('projects:refresh-requested', { detail: { preferredProject: projectName } }));
    document.dispatchEvent(new CustomEvent('project:created', { detail: { projectName } }));
    window.setTimeout(() => {
      closeModal(elements.modal);
      resetForm();
    }, 800);
  } catch (error) {
    console.error('[Feature:uploadProject] Failed to restore project', error);
    let message = `Failed to restore project: ${error?.message || 'Unexpected error.'}`;
    if (error?.message === 'HTTP 409') {
      message = 'A project with that name already exists.';
    } else if (error?.message === 'HTTP 400') {
      message = 'Invalid archive contents.';
    }
    setStatusMessage(elements.status, message, formatTone('error'));
  } finally {
    state.uploading = false;
    if (elements.submitBtn) elements.submitBtn.textContent = 'Restore Project';
    updateControls();
  }
}

function attachEvents() {
  elements.dropzone?.addEventListener('click', () => elements.fileInput?.click());
  elements.dropzone?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      elements.fileInput?.click();
    }
  });
  elements.dropzone?.addEventListener('dragover', e => { e.preventDefault(); setDropzoneActive(true); });
  elements.dropzone?.addEventListener('dragleave', () => setDropzoneActive(false));
  elements.dropzone?.addEventListener('drop', e => {
    e.preventDefault();
    setDropzoneActive(false);
    handleFileSelection(e.dataTransfer?.files);
  });
  elements.fileInput?.addEventListener('change', () => {
    handleFileSelection(elements.fileInput.files);
    elements.fileInput.value = '';
  });
  elements.cancelBtn?.addEventListener('click', e => {
    e.preventDefault();
    resetForm();
    closeModal(elements.modal);
  });
  elements.closeBtn?.addEventListener('click', () => { resetForm(); closeModal(elements.modal); });
  elements.backdrop?.addEventListener('click', () => { resetForm(); closeModal(elements.modal); });
  elements.form?.addEventListener('submit', handleSubmit);
}

export function init() {
  if (state.initialized) return;
  cacheElements();
  if (!elements.modal || !elements.form) {
    console.warn('[Feature:uploadProject] Required elements not found.');
    return;
  }
  attachEvents();
  resetForm();
  state.initialized = true;
  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export default { init };