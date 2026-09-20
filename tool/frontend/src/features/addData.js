import { requestJson, resolveUrl } from '../api/client.js';
import { byId, formatBytes, setStatusMessage } from '../ui/dom.js';
import { closeModal, openModal } from '../ui/modal.js';

const FEATURE_NAME = 'addData';

const SUPPORTED_DATA_EXTENSIONS = ['.npz', '.npy'];
const DATA_FILE_LIMIT = 5;

let initialized = false;
let addDataFiles = [];
let dataUploadSequence = 0;
let keepAddDataModalOpen = false;

const elements = {};

function cacheElements() {
  elements.form = byId('addDataForm');
  elements.dropzone = byId('addDataDropzone');
  elements.fileInput = byId('addDataFileInput');
  elements.status = byId('addDataStatus');
  elements.fileList = byId('addDataFileList');
  elements.submitBtn = byId('addDataSubmitBtn');
  elements.cancelBtn = byId('addDataCancelBtn');
  elements.modal = byId('addDataModal');
  elements.modalClose = byId('addDataModalClose');
  elements.modalBackdrop = document.querySelector('[data-modal="add-data-backdrop"]');
  elements.addDataBtn = byId('addDataBtn');
  elements.projectLabel = byId('addDataProjectLabel');
  elements.projectSelect = byId('projectSelect');
}

function currentProjectName() {
  const value = elements.projectSelect?.value ?? '';
  return typeof value === 'string' ? value.trim() : '';
}

function describeDataFileType(file) {
  if (!file || typeof file.name !== 'string') return 'file';
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.npz')) return 'NPZ file';
  if (lower.endsWith('.npy')) return 'NPY file';
  return 'file';
}

function formatTone(tone) {
  if (tone === 'error') {
    return { tone: 'error', isError: true };
  }
  return { tone, isError: tone === 'error' };
}

function isSupportedDataFile(file) {
  if (!file || typeof file.name !== 'string') return false;
  const lower = file.name.toLowerCase();
  return SUPPORTED_DATA_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function setDropzoneActive(active) {
  const { dropzone } = elements;
  if (!dropzone) return;
  dropzone.classList.toggle('ring-2', active);
  dropzone.classList.toggle('ring-blue-300', active);
  dropzone.classList.toggle('bg-blue-50', active);
  dropzone.classList.toggle('bg-gray-50', !active);
}

function resetAddDataForm({ preserveStatus = false } = {}) {
  const { form, status } = elements;
  if (!form) return;
  form.reset();
  addDataFiles = [];
  if (form.dataset) {
    delete form.dataset.uploading;
  }
  if (!preserveStatus) {
    setStatusMessage(status, 'Select one or more files to append to this project.', formatTone('muted'));
  }
  renderFileList();
  updateControls();
}

function ensureStatus(message, tone = 'muted') {
  setStatusMessage(elements.status, message, formatTone(tone));
}

function renderFileList() {
  const { fileList } = elements;
  if (!fileList) return;

  fileList.innerHTML = '';

  if (!addDataFiles.length) {
    const emptyState = document.createElement('li');
    emptyState.className = 'rounded-lg border border-dashed border-gray-300 bg-white px-4 py-3 text-center text-sm text-gray-400';
    emptyState.textContent = 'No files selected.';
    fileList.append(emptyState);
    return;
  }

  addDataFiles.forEach(entry => {
    const item = document.createElement('li');
    item.className = 'flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 shadow-sm';

    const info = document.createElement('div');
    info.className = 'min-w-0 flex-1';
    const name = document.createElement('p');
    name.className = 'truncate text-sm font-medium text-gray-800';
    name.textContent = entry.file?.name ?? 'Unnamed file';

    const meta = document.createElement('p');
    meta.className = 'text-xs text-gray-500';
    meta.textContent = formatBytes(entry.file?.size ?? 0) || 'Unknown size';
    info.append(name, meta);

    const status = document.createElement('span');
    status.className = 'text-xs font-medium';
    if (entry.status === 'uploading') {
      status.classList.add('text-blue-600');
      status.textContent = 'Uploading…';
    } else if (entry.status === 'success') {
      status.classList.add('text-green-600');
      status.textContent = entry.message || 'Uploaded';
    } else if (entry.status === 'error') {
      status.classList.add('text-red-600');
      status.textContent = entry.message || 'Failed';
    } else {
      status.classList.add('text-gray-500');
      status.textContent = 'Pending';
    }

    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-3';
    actions.append(status);

    const uploading = elements.form?.dataset?.uploading === 'true';
    if (entry.status !== 'uploading' && !uploading) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'rounded-full p-1 text-gray-400 transition hover:bg-red-50 hover:text-red-600';
      removeBtn.innerHTML = '<span class="sr-only">Remove file</span>×';
      removeBtn.addEventListener('click', () => {
        addDataFiles = addDataFiles.filter(item => item.id !== entry.id);
        const tone = addDataFiles.length ? 'info' : 'muted';
        const message = addDataFiles.length
          ? 'File removed. Adjust your selection or upload now.'
          : 'Select one or more files to append to this project.';
        ensureStatus(message, tone);
        renderFileList();
        updateControls();
      });
      actions.append(removeBtn);
    }

    item.append(info, actions);
    fileList.append(item);
  });
}

function updateControls() {
  const uploading = elements.form?.dataset?.uploading === 'true';
  if (elements.submitBtn) {
    elements.submitBtn.disabled = uploading || !addDataFiles.length;
  }
  if (elements.cancelBtn) {
    elements.cancelBtn.disabled = uploading;
  }
}

function prepareUploadEntries(fileList, currentCount) {
  const entries = [];
  const errors = [];
  if (!fileList) {
    return { entries, errors };
  }
  const files = Array.from(fileList);
  files.forEach(file => {
    if (!isSupportedDataFile(file)) {
      errors.push(`Unsupported file type: ${file?.name ?? 'Unknown file'}.`);
      return;
    }
    if (currentCount + entries.length >= DATA_FILE_LIMIT) {
      errors.push(`File limit reached. You can upload up to ${DATA_FILE_LIMIT} files at once.`);
      return;
    }
    entries.push({
      id: ++dataUploadSequence,
      file,
      status: 'pending',
      message: '',
    });
  });
  return { entries, errors };
}

function addFilesToQueue(fileList) {
  const { entries, errors } = prepareUploadEntries(fileList, addDataFiles.length);

  if (entries.length) {
    addDataFiles = addDataFiles.concat(entries);
    renderFileList();
    updateControls();
  }

  if (errors.length) {
    const prefix = entries.length ? `${entries.length === 1 ? 'File' : `${entries.length} files`} added. ` : '';
    ensureStatus(`${prefix}${errors.join(' ')}`, 'error');
  } else if (entries.length) {
    const count = entries.length;
    const message = count === 1
      ? `${describeDataFileType(entries[0].file)} ready to upload.`
      : `${count} files ready to upload.`;
    ensureStatus(message, 'info');
  }
}

function updateUploadEntry(entries, id, updates) {
  const entry = entries.find(item => item.id === id);
  if (!entry) return null;
  Object.assign(entry, updates);
  return entry;
}

function deriveArrayNameFromFile(file) {
  if (!file) return '';
  const rawName = typeof file.name === 'string' ? file.name : '';
  const normalized = rawName.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const last = segments.length ? segments[segments.length - 1] : normalized;
  if (!last) return '';
  return last.toLowerCase().endsWith('.npy') ? last.slice(0, -4) : last;
}

function encodeSegment(value) {
  return encodeURIComponent(value ?? '');
}

async function uploadDataEntry(projectName, entry) {
  if (!entry?.file) {
    throw new Error('No file provided for upload.');
  }

  const normalizedProject = String(projectName || '').trim();
  if (!normalizedProject) {
    throw new Error('Project name is required for upload.');
  }

  const lowerName = entry.file.name?.toLowerCase?.() ?? '';
  const formData = new FormData();
  formData.append('file', entry.file, entry.file.name ?? 'data');

  let endpoint = 'arrays/import';
  let successMessage = 'Uploaded';

  if (lowerName.endsWith('.npz')) {
    endpoint = 'arrays/import';
  } else if (lowerName.endsWith('.npy')) {
    endpoint = 'arrays';
    const derivedName = deriveArrayNameFromFile(entry.file);
    if (!derivedName) {
      throw new Error('Unable to derive array name from file.');
    }
    formData.append('array_name', derivedName);
  } else {
    throw new Error('Unsupported file type.');
  }

  const url = resolveUrl(`/api/v1/projects/${encodeSegment(normalizedProject)}/${endpoint}`);
  const response = await requestJson(url, {
    method: 'POST',
    body: formData,
    skipStringify: true,
  });

  if (Array.isArray(response?.added_arrays) && response.added_arrays.length) {
    const names = response.added_arrays
      .map(item => {
        if (!item) return null;
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && typeof item.name === 'string') return item.name;
        return null;
      })
      .filter(Boolean);
    const count = response.added_arrays.length;
    if (names.length === 1) {
      successMessage = `Added array ${names[0]}`;
    } else {
      successMessage = `Added ${count} arrays`;
    }
  } else if (typeof response?.added_array === 'string') {
    successMessage = `Added array ${response.added_array}`;
  }

  return { response, message: successMessage };
}

function formatUploadError(err) {
  if (!err || typeof err !== 'object') {
    return 'Upload failed.';
  }
  const message = err.message;
  if (message === 'HTTP 409') {
    return 'Upload failed: A file with that name already exists.';
  }
  if (message === 'HTTP 404') {
    return 'Upload failed: Project not found.';
  }
  if (message === 'HTTP 400') {
    return 'Upload failed: Invalid file contents.';
  }
  return `Upload failed: ${message || 'Unexpected error.'}`;
}

function openAddDataModal({ focusDropzone = true, sticky = true } = {}) {
  const { modal, dropzone } = elements;
  if (!modal) return;
  if (sticky) {
    keepAddDataModalOpen = true;
  }
  openModal(modal, { focusTarget: focusDropzone ? dropzone : undefined });
}

function closeAddDataModal({ resetForm = false, releaseSticky = true } = {}) {
  const { modal } = elements;
  if (!modal) return;
  if (resetForm) {
    resetAddDataForm();
  }
  if (releaseSticky) {
    keepAddDataModalOpen = false;
  }
  closeModal(modal);
}

function syncProjectLabel() {
  const label = elements.projectLabel;
  if (!label) return;
  const select = elements.projectSelect;
  if (!select) {
    label.textContent = '';
    return;
  }
  const selectedOption = select.options?.[select.selectedIndex] ?? null;
  label.textContent = selectedOption?.textContent || select.value || '';
}

function registerEventListeners() {
  const {
    addDataBtn,
    modal,
    modalClose,
    modalBackdrop,
    form,
    dropzone,
    fileInput,
    cancelBtn,
    projectSelect,
  } = elements;

  addDataBtn?.addEventListener('click', () => {
    if (addDataBtn.disabled) return;
    const projectName = currentProjectName();
    if (!projectName) {
      ensureStatus('Select a project before adding data.', 'error');
      return;
    }
    syncProjectLabel();
    openAddDataModal();
  });

  modalClose?.addEventListener('click', () => {
    closeAddDataModal({ releaseSticky: true });
  });

  cancelBtn?.addEventListener('click', event => {
    event.preventDefault();
    closeAddDataModal({ resetForm: true, releaseSticky: true });
  });

  modalBackdrop?.addEventListener('click', () => {
    closeAddDataModal({ releaseSticky: true });
  });

  dropzone?.addEventListener('click', () => {
    fileInput?.click();
  });

  dropzone?.addEventListener('keydown', event => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      fileInput?.click();
    }
  });

  dropzone?.addEventListener('dragover', event => {
    event.preventDefault();
    setDropzoneActive(true);
  });

  dropzone?.addEventListener('dragleave', () => {
    setDropzoneActive(false);
  });

  dropzone?.addEventListener('drop', event => {
    event.preventDefault();
    setDropzoneActive(false);
    if (!currentProjectName()) {
      ensureStatus('Select a project before adding data.', 'error');
      return;
    }
    if (event.dataTransfer?.files?.length) {
      addFilesToQueue(event.dataTransfer.files);
    }
  });

  fileInput?.addEventListener('change', () => {
    if (fileInput.files?.length) {
      addFilesToQueue(fileInput.files);
      fileInput.value = '';
    }
  });

  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const projectName = currentProjectName();
    if (!projectName) {
      ensureStatus('Select a project before adding data.', 'error');
      return;
    }
    if (!addDataFiles.length) {
      ensureStatus('Choose at least one file to upload.', 'error');
      return;
    }

    if (form.dataset) {
      form.dataset.uploading = 'true';
    }
    updateControls();

    let hadErrors = false;

    try {
      let uploadResults = [];
      for (const entry of addDataFiles) {
        updateUploadEntry(addDataFiles, entry.id, { status: 'uploading', message: '' });
        renderFileList();
        try {
          const { message } = await uploadDataEntry(projectName, entry);
          updateUploadEntry(addDataFiles, entry.id, { status: 'success', message });
        } catch (error) {
          hadErrors = true;
          updateUploadEntry(addDataFiles, entry.id, { status: 'error', message: formatUploadError(error) });
        }
        renderFileList();
      }

      uploadResults = addDataFiles.map(item => ({ id: item.id, status: item.status, message: item.message }));

      if (hadErrors) {
        ensureStatus('Some files failed to upload. Review the messages and try again.', 'error');
      } else {
        ensureStatus('All files uploaded successfully.', 'success');
        resetAddDataForm({ preserveStatus: true });
      }

      document.dispatchEvent(new CustomEvent('project:data-uploaded', {
        detail: { projectName, hadErrors, entries: uploadResults },
      }));
    } catch (error) {
      console.error('[Feature:addData] Upload failed', error);
      ensureStatus(formatUploadError(error), 'error');
    } finally {
      if (form.dataset) {
        delete form.dataset.uploading;
      }
      updateControls();
    }
  });

  projectSelect?.addEventListener('change', () => {
    syncProjectLabel();
    if (!keepAddDataModalOpen) {
      resetAddDataForm();
    }
  });

  document.addEventListener('project:selected', event => {
    const { detail } = event || {};
    if (!detail) return;
    syncProjectLabel();
    if (detail.keepAddDataOpen) {
      openAddDataModal({ focusDropzone: false, sticky: true });
    }
  });

  document.addEventListener('modal:close-all', () => {
    closeAddDataModal({ releaseSticky: true });
  });
}

export function init() {
  if (initialized) return;
  initialized = true;

  cacheElements();
  resetAddDataForm();
  syncProjectLabel();
  registerEventListeners();

  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export const __test__ = {
  prepareUploadEntries,
  isSupportedDataFile,
  deriveArrayNameFromFile,
  formatUploadError,
};
