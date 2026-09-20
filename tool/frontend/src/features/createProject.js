import { createProject as apiCreateProject } from '../api/projects.js';
import { requestJson, resolveUrl } from '../api/client.js';
import {
  byId,
  formatBytes,
  setStatusMessage,
} from '../ui/dom.js';
import { closeModal, openModal } from '../ui/modal.js';

const FEATURE_NAME = 'createProject';

const SUPPORTED_DATA_EXTENSIONS = ['.npz', '.npy'];
const DATA_FILE_LIMIT = 5;

let initialized = false;
let createProjectStep = 'info';
let createProjectFiles = [];
let dataUploadSequence = 0;
let creationState = {
  projectName: '',
  created: false,
  creationResponse: null,
  uploadAttempted: false,
  uploadSucceeded: false,
  lastErrorCount: 0,
  creationEventEmitted: false,
};

const elements = {};

function cacheElements() {
  elements.modal = byId('createProjectModal');
  elements.modalClose = byId('createProjectModalClose');
  elements.modalBackdrop = document.querySelector('[data-modal="create-project-backdrop"]');
  elements.openBtn = byId('createProjectOpenBtn');
  elements.form = byId('createProjectForm');
  elements.nameInput = byId('createProjectNameInput');
  elements.descriptionInput = byId('createProjectDescriptionInput');
  elements.status = byId('createProjectStatus');
  elements.submitBtn = byId('createProjectSubmitBtn');
  elements.uploadBtn = byId('createProjectUploadBtn');
  elements.finishBtn = byId('createProjectFinishBtn') || elements.submitBtn;
  elements.cancelBtn = byId('createProjectCancelBtn');
  elements.nextBtn = byId('createProjectNextBtn');
  elements.backBtn = byId('createProjectBackBtn');
  elements.subtitle = byId('createProjectSubtitle');
  elements.stepLabel = byId('createProjectStepLabel');
  elements.infoStep = byId('createProjectInfoStep');
  elements.dataStep = byId('createProjectDataStep');
  elements.dropzone = byId('createProjectDropzone');
  elements.fileInput = byId('createProjectFileInput');
  elements.dataStatus = byId('createProjectDataStatus');
  elements.fileList = byId('createProjectFileList');
  elements.uploadStatus = byId('uploadStatus');
}

function formatTone(tone) {
  if (tone === 'error') {
    return { tone: 'error', isError: true };
  }
  if (tone === 'success') {
    return { tone: 'success' };
  }
  if (tone === 'info') {
    return { tone: 'info' };
  }
  return { tone: 'muted' };
}

function setCreateProjectStatus(message, tone = 'muted') {
  if (!elements.status) return;
  setStatusMessage(elements.status, message, formatTone(tone));
}

function setUploadStatus(message, { isError = false } = {}) {
  if (!elements.uploadStatus) return;
  elements.uploadStatus.textContent = message;
  elements.uploadStatus.classList.toggle('text-red-600', isError);
  elements.uploadStatus.classList.toggle('text-gray-600', !isError);
}

function markEntriesForRetry(entries) {
  entries.forEach(entry => {
    if (entry.status === 'error' || entry.status === 'pending') {
      entry.status = 'pending';
      entry.message = '';
    }
  });
}

function setDropzoneActive(dropzone, active) {
  if (!dropzone) return;
  dropzone.classList.toggle('ring-2', active);
  dropzone.classList.toggle('ring-blue-300', active);
  dropzone.classList.toggle('bg-blue-50', active);
  dropzone.classList.toggle('bg-gray-50', !active);
}

function describeDataFileType(file) {
  if (!file || typeof file.name !== 'string') return 'file';
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.npz')) return 'NPZ file';
  if (lower.endsWith('.npy')) return 'NPY file';
  return 'file';
}

function isSupportedDataFile(file) {
  if (!file || typeof file.name !== 'string') return false;
  const lower = file.name.toLowerCase();
  return SUPPORTED_DATA_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function resetCreateProjectForm({ preserveStatus = false } = {}) {
  const { form, nameInput, descriptionInput, submitBtn, nextBtn, dataStatus } = elements;
  if (!form) return;

  form.reset();
  createProjectStep = 'info';
  createProjectFiles = [];
  creationState = {
    projectName: '',
    created: false,
    creationResponse: null,
    uploadAttempted: false,
    uploadSucceeded: false,
    lastErrorCount: 0,
    creationEventEmitted: false,
  };
  if (form.dataset) {
    delete form.dataset.uploading;
  }
  if (nameInput) nameInput.disabled = false;
  if (descriptionInput) descriptionInput.disabled = false;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Finish';
  }
  if (elements.uploadBtn) {
    elements.uploadBtn.disabled = true;
    elements.uploadBtn.textContent = 'Upload data';
  }
  if (nextBtn) {
    nextBtn.disabled = true;
  }
  if (!preserveStatus) {
    setCreateProjectStatus('Enter a name and description to get started.');
  }
  if (dataStatus && !preserveStatus) {
    setStatusMessage(
      dataStatus,
      'Use Upload data to create the project and send files. You can also add data later.',
      formatTone('muted'),
    );
  }
  if (!preserveStatus) {
    setUploadStatus('Waiting to upload project data.');
  }
  renderCreateProjectFileList();
  updateCreateProjectStepUI();
  updateCreateProjectControls();
}

function updateCreateProjectStepUI() {
  const {
    infoStep,
    dataStep,
    backBtn,
    nextBtn,
    submitBtn,
    uploadBtn,
    stepLabel,
    subtitle,
    form,
  } = elements;

  const isInfoStep = createProjectStep === 'info';
  infoStep?.classList.toggle('hidden', !isInfoStep);
  dataStep?.classList.toggle('hidden', isInfoStep);
  if (backBtn) {
    backBtn.classList.toggle('hidden', isInfoStep);
    backBtn.disabled = !isInfoStep && form?.dataset?.uploading === 'true';
  }
  if (nextBtn) {
    nextBtn.classList.toggle('hidden', !isInfoStep);
  }
  if (submitBtn) {
    submitBtn.classList.toggle('hidden', isInfoStep);
  }
  if (uploadBtn) {
    uploadBtn.classList.toggle('hidden', isInfoStep);
  }
  if (stepLabel) {
    stepLabel.textContent = isInfoStep ? 'Step 1 of 2' : 'Step 2 of 2';
  }
  if (subtitle) {
    subtitle.textContent = isInfoStep
      ? 'Provide project details'
      : 'Upload data files (optional)';
  }
}

function updateCreateProjectControls() {
  const {
    nameInput,
    descriptionInput,
    nextBtn,
    submitBtn,
    uploadBtn,
    finishBtn,
    cancelBtn,
    form,
  } = elements;
  const name = nameInput?.value?.trim() ?? '';
  const description = descriptionInput?.value?.trim() ?? '';
  const uploading = form?.dataset?.uploading === 'true';
  const canUpload = !uploading && !!(name && description);
  const finishReady = canFinishProject();

  if (nextBtn) {
    nextBtn.disabled = uploading || !(name && description);
  }
  if (submitBtn) {
    submitBtn.disabled = uploading || !finishReady;
  }
  if (uploadBtn) {
    uploadBtn.disabled = !canUpload;
  }
  if (finishBtn) {
    finishBtn.disabled = submitBtn?.disabled ?? !finishReady;
  }
  if (cancelBtn) {
    cancelBtn.disabled = uploading;
  }
}

function canFinishProject() {
  const uploading = elements.form?.dataset?.uploading === 'true';
  if (uploading) return false;

  if (!creationState.created) return false;

  if (!createProjectFiles.length) return true;

  const hasPending = createProjectFiles.some(entry => ['pending', 'uploading'].includes(entry.status));
  if (hasPending) return false;

  const hasSuccess = createProjectFiles.some(entry => entry.status === 'success');
  if (!hasSuccess) return false;

  return true;
}

function renderCreateProjectFileList() {
  const { fileList } = elements;
  if (!fileList) return;

  fileList.innerHTML = '';

  if (!createProjectFiles.length) {
    const emptyState = document.createElement('li');
    emptyState.className = 'rounded-lg border border-dashed border-gray-300 bg-white px-4 py-3 text-center text-sm text-gray-400';
    emptyState.textContent = 'No files selected.';
    fileList.append(emptyState);
    return;
  }

  createProjectFiles.forEach(entry => {
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
        createProjectFiles = createProjectFiles.filter(item => item.id !== entry.id);
        const tone = createProjectFiles.length ? 'info' : 'muted';
        const message = createProjectFiles.length
          ? 'File removed. Adjust your selection or upload now.'
          : 'No files selected.';
        setStatusMessage(elements.dataStatus, message, formatTone(tone));
        renderCreateProjectFileList();
        updateCreateProjectControls();
      });
      actions.append(removeBtn);
    }

    item.append(info, actions);
    fileList.append(item);
  });
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
  const { entries, errors } = prepareUploadEntries(fileList, createProjectFiles.length);

  if (entries.length) {
    createProjectFiles = createProjectFiles.concat(entries);
    renderCreateProjectFileList();
    updateCreateProjectControls();
  }

  if (errors.length) {
    const prefix = entries.length ? `${entries.length === 1 ? 'File' : `${entries.length} files`} added. ` : '';
    setStatusMessage(elements.dataStatus, `${prefix}${errors.join(' ')}`, formatTone('error'));
  } else if (entries.length) {
    const count = entries.length;
    const message = count === 1
      ? `${describeDataFileType(entries[0].file)} ready to upload.`
      : `${count} files ready to upload.`;
    setStatusMessage(elements.dataStatus, message, formatTone('info'));
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

function wait(ms) {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms);
  });
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

function isRetryableUploadError(err) {
  if (!err || typeof err !== 'object') return true;
  if (err.status && Number.isInteger(err.status)) {
    if ([400, 404, 409].includes(err.status)) return false;
    return err.status >= 500 || err.status === 0;
  }
  return true;
}

async function uploadDataEntryWithRetry(projectName, entry, { attempts = 3, baseDelayMs = 750 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (attempt > 1) {
        const attemptMessage = `Retrying (${attempt}/${attempts})…`;
        updateUploadEntry(createProjectFiles, entry.id, { status: 'uploading', message: attemptMessage });
        renderCreateProjectFileList();
      }
      return await uploadDataEntry(projectName, entry);
    } catch (error) {
      lastError = error;
      if (!isRetryableUploadError(error) || attempt === attempts) {
        throw error;
      }
      await wait(baseDelayMs * attempt);
    }
  }
  throw lastError ?? new Error('Upload failed.');
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

function normalizeProjectNameInput(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const segments = trimmed.split(/[\\/]+/).filter(Boolean);
  let candidate = segments.length ? segments[segments.length - 1] : trimmed;
  candidate = candidate.replace(/[:]+/g, '').trim();
  if (!candidate) return '';
  if (!candidate.toLowerCase().endsWith('.npz')) {
    candidate = `${candidate}.npz`;
  }
  const base = candidate.slice(0, -4).trim();
  if (!base) return '';
  return candidate;
}

function handleStepTransition() {
  const name = elements.nameInput?.value?.trim() ?? '';
  const description = elements.descriptionInput?.value?.trim() ?? '';
  if (!name) {
    setCreateProjectStatus('Enter a project name ending with .npz.', 'error');
    elements.nameInput?.focus();
    elements.nameInput?.select();
    return false;
  }
  if (!description) {
    setCreateProjectStatus('Enter a project description to continue.', 'error');
    elements.descriptionInput?.focus();
    return false;
  }

  const normalizedName = normalizeProjectNameInput(name);
  if (!normalizedName) {
    setCreateProjectStatus('Enter a valid project name ending with .npz.', 'error');
    elements.nameInput?.focus();
    elements.nameInput?.select();
    return false;
  }
  if (elements.nameInput) {
    elements.nameInput.value = normalizedName;
  }

  createProjectStep = 'data';
  setStatusMessage(
    elements.dataStatus,
    createProjectFiles.length
      ? `${createProjectFiles.length} file${createProjectFiles.length === 1 ? '' : 's'} ready to upload.`
      : 'You can upload files now or skip this step and add data later.',
    formatTone(createProjectFiles.length ? 'info' : 'muted'),
  );
  updateCreateProjectStepUI();
  window.setTimeout(() => {
    elements.dropzone?.focus();
  }, 0);
  return true;
}

async function handleUploadData(event) {
  event?.preventDefault?.();

  if (createProjectStep !== 'data') {
    if (handleStepTransition()) {
      updateCreateProjectControls();
    }
    return;
  }

  const rawName = elements.nameInput?.value ?? '';
  const normalizedName = normalizeProjectNameInput(rawName);
  const description = elements.descriptionInput?.value?.trim() ?? '';

  if (!normalizedName) {
    setCreateProjectStatus('Enter a valid project name ending with .npz.', 'error');
    createProjectStep = 'info';
    updateCreateProjectStepUI();
    elements.nameInput?.focus();
    elements.nameInput?.select();
    return;
  }

  if (!description) {
    setCreateProjectStatus('Enter a project description to continue.', 'error');
    createProjectStep = 'info';
    updateCreateProjectStepUI();
    elements.descriptionInput?.focus();
    return;
  }

  if (elements.nameInput) {
    elements.nameInput.value = normalizedName;
  }

  if (elements.form?.dataset) {
    elements.form.dataset.uploading = 'true';
  }
  if (elements.uploadBtn) {
    elements.uploadBtn.textContent = 'Uploading…';
  }
  updateCreateProjectControls();

  const uploadErrors = [];
  let projectName = normalizedName;

  try {
    if (!creationState.created) {
      setStatusMessage(elements.dataStatus, 'Creating project…', formatTone('info'));
      const response = await apiCreateProject({ name: normalizedName, description });
      creationState.created = true;
      creationState.creationResponse = response;
      projectName = typeof response?.project === 'string' ? response.project : normalizedName;
      creationState.projectName = projectName;
      if (elements.nameInput) {
        elements.nameInput.value = projectName;
        elements.nameInput.disabled = true;
      }
      if (elements.descriptionInput) {
        elements.descriptionInput.disabled = true;
      }
    } else {
      projectName = creationState.projectName || normalizedName;
    }

    markEntriesForRetry(createProjectFiles);
    const uploadQueue = createProjectFiles.filter(entry => entry.status !== 'success');

    if (!uploadQueue.length) {
      creationState.uploadAttempted = false;
      creationState.uploadSucceeded = true;
      creationState.lastErrorCount = 0;
      setUploadStatus(
        `Project ready: ${projectName}${createProjectFiles.length ? ' (files already uploaded)' : ''}.`,
      );
      setStatusMessage(
        elements.dataStatus,
        'Project created. Click Finish or add more files to upload.',
        formatTone('success'),
      );
    } else {
      setStatusMessage(elements.dataStatus, 'Uploading project files…', formatTone('info'));

      let successCount = 0;
      for (const entry of uploadQueue) {
        updateUploadEntry(createProjectFiles, entry.id, { status: 'uploading', message: '' });
        renderCreateProjectFileList();
        try {
          const { message } = await uploadDataEntryWithRetry(projectName, entry);
          successCount += 1;
          updateUploadEntry(createProjectFiles, entry.id, { status: 'success', message });
        } catch (error) {
          const errorMessage = formatUploadError(error);
          uploadErrors.push(errorMessage);
          updateUploadEntry(createProjectFiles, entry.id, { status: 'error', message: errorMessage });
        }
        renderCreateProjectFileList();
      }

      creationState.uploadAttempted = true;
      creationState.uploadSucceeded = uploadErrors.length === 0;
      creationState.lastErrorCount = uploadErrors.length;

      if (!uploadErrors.length) {
        setUploadStatus(`Project created: ${projectName}`);
        setStatusMessage(
          elements.dataStatus,
          'All files uploaded successfully. Click Finish to continue.',
          formatTone('success'),
        );
      } else if (successCount > 0) {
        setUploadStatus(
          `Uploaded with ${uploadErrors.length} error${uploadErrors.length === 1 ? '' : 's'}. Review failed files and retry.`,
          { isError: true },
        );
        setStatusMessage(
          elements.dataStatus,
          'Some files failed to upload. Fix the errors and click Upload again.',
          formatTone('error'),
        );
      } else {
        setUploadStatus('All uploads failed. Fix errors and retry.', { isError: true });
        setStatusMessage(
          elements.dataStatus,
          'Project created but uploads failed. Resolve the issues and try uploading again.',
          formatTone('error'),
        );
      }

      if (successCount > 0) {
        document.dispatchEvent(new CustomEvent('project:data-uploaded', {
          detail: { projectName },
        }));
      }
    }

    document.dispatchEvent(new CustomEvent('projects:refresh-requested', {
      detail: { preferredProject: projectName },
    }));

    if (!creationState.creationEventEmitted) {
      document.dispatchEvent(new CustomEvent('project:created', {
        detail: { projectName, response: creationState.creationResponse },
      }));
      creationState.creationEventEmitted = true;
    }
  } catch (error) {
    console.error('[Feature:createProject] Failed to create project', error);
    let message = `Failed to create project: ${error?.message ?? 'Unexpected error.'}`;
    if (error?.message === 'HTTP 409') {
      message = 'Failed to create project: A project with that name already exists.';
    } else if (error?.message === 'HTTP 400') {
      message = 'Failed to create project: Invalid name or description.';
    }
    setCreateProjectStatus(message, 'error');
    createProjectStep = 'info';
    updateCreateProjectStepUI();
    creationState.uploadSucceeded = false;
    creationState.lastErrorCount = 1;
  } finally {
    if (elements.form?.dataset) {
      delete elements.form.dataset.uploading;
    }
    if (elements.uploadBtn) {
      elements.uploadBtn.textContent = 'Upload data';
    }
    renderCreateProjectFileList();
    updateCreateProjectControls();
  }
}

function handleSubmit(event) {
  event.preventDefault();

  if (createProjectStep !== 'data') {
    if (handleStepTransition()) {
      updateCreateProjectControls();
    }
    return;
  }

  if (!creationState.created) {
    setCreateProjectStatus('Upload your data to create the project before finishing.', 'error');
    setStatusMessage(elements.dataStatus, 'Click Upload data to create the project.', formatTone('error'));
    return;
  }

  if (!canFinishProject()) {
    if (creationState.lastErrorCount) {
      setStatusMessage(
        elements.dataStatus,
        `Resolve ${creationState.lastErrorCount} upload error${creationState.lastErrorCount === 1 ? '' : 's'} before finishing.`,
        formatTone('error'),
      );
    } else {
      setStatusMessage(
        elements.dataStatus,
        'Upload in progress. Please wait for uploads to finish.',
        formatTone('info'),
      );
    }
    return;
  }

  setUploadStatus('Project ready to use.');
  resetCreateProjectForm();
  closeModal(elements.modal);
}

function handleNameInput() {
  setCreateProjectStatus('Enter a name and description to get started.', 'muted');
  updateCreateProjectControls();
}

function handleDescriptionInput() {
  setCreateProjectStatus('Enter a name and description to get started.', 'muted');
  updateCreateProjectControls();
}

function attachEventListeners() {
  const {
    openBtn,
    modal,
    modalClose,
    modalBackdrop,
    form,
    nameInput,
    descriptionInput,
    nextBtn,
    uploadBtn,
    backBtn,
    cancelBtn,
    dropzone,
    fileInput,
  } = elements;

  // Fallback if mode modal absent
  const modeModalPresent = !!document.getElementById('createProjectModeModal');
  if (!modeModalPresent) {
    openBtn?.addEventListener('click', () => {
      resetCreateProjectForm();
      openModal(modal, { focusTarget: nameInput });
    });
  }

  // Listen for external open requests
  document.addEventListener('create-project:open-requested', () => {
    resetCreateProjectForm();
    openModal(modal, { focusTarget: nameInput });
  });

  modalClose?.addEventListener('click', () => {
    resetCreateProjectForm();
    closeModal(modal);
  });

  modalBackdrop?.addEventListener('click', () => {
    resetCreateProjectForm();
    closeModal(modal);
  });

  cancelBtn?.addEventListener('click', event => {
    event.preventDefault();
    resetCreateProjectForm();
    closeModal(modal);
  });

  nextBtn?.addEventListener('click', event => {
    event.preventDefault();
    if (handleStepTransition()) {
      updateCreateProjectControls();
    }
  });

  backBtn?.addEventListener('click', event => {
    event.preventDefault();
    if (elements.form?.dataset?.uploading === 'true') return;
    createProjectStep = 'info';
    updateCreateProjectStepUI();
    updateCreateProjectControls();
    window.setTimeout(() => {
      nameInput?.focus();
    }, 0);
  });

  nameInput?.addEventListener('input', handleNameInput);
  descriptionInput?.addEventListener('input', handleDescriptionInput);

  dropzone?.addEventListener('click', () => {
    fileInput?.click();
  });

  dropzone?.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput?.click();
    }
  });

  dropzone?.addEventListener('dragover', event => {
    event.preventDefault();
    setDropzoneActive(dropzone, true);
  });

  dropzone?.addEventListener('dragleave', () => {
    setDropzoneActive(dropzone, false);
  });

  dropzone?.addEventListener('drop', event => {
    event.preventDefault();
    setDropzoneActive(dropzone, false);
    const files = event.dataTransfer?.files;
    if (files && files.length) {
      addFilesToQueue(files);
    }
  });

  fileInput?.addEventListener('change', () => {
    if (fileInput?.files?.length) {
      addFilesToQueue(fileInput.files);
      fileInput.value = '';
    }
  });

  uploadBtn?.addEventListener('click', handleUploadData);
  form?.addEventListener('submit', handleSubmit);

  document.addEventListener('project:selected', event => {
    const projectName = event.detail?.projectName || event.detail?.project?.name;
    if (!projectName) return;
    if (elements.modal && !elements.modal.classList.contains('hidden')) {
      elements.nameInput.value = projectName;
      updateCreateProjectControls();
    }
  });
}

export function init() {
  if (initialized) return;
  cacheElements();
  if (!elements.form || !elements.modal) {
    console.warn('[Feature:createProject] Required elements not found.');
    return;
  }
  attachEventListeners();
  resetCreateProjectForm();
  initialized = true;
  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export default { init };
