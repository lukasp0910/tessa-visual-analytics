import { requestJson } from '../api/client.js';
import { byId, formatBytes } from '../ui/dom.js';

const FEATURE_NAME = 'uploadArchive';
const UPLOAD_ENDPOINT = '/api/v1/projects/import';

const state = {
  initialized: false,
};

const elements = {};

function cacheElements() {
  elements.form = byId('uploadForm');
  elements.fileInput = byId('fileInput');
  elements.uploadBtn = byId('uploadBtn');
  elements.status = byId('uploadStatus');
  elements.dropzone = byId('uploadDropzone');
}

function setUploadStatus(message, { isError = false } = {}) {
  if (!elements.status) return;
  elements.status.textContent = message;
  elements.status.classList.toggle('text-red-600', isError);
  elements.status.classList.toggle('text-gray-600', !isError);
}

function setDropzoneActive(active) {
  const dropzone = elements.dropzone;
  if (!dropzone) return;
  dropzone.classList.toggle('ring-2', active);
  dropzone.classList.toggle('ring-blue-300', active);
  dropzone.classList.toggle('bg-blue-50', active);
  dropzone.classList.toggle('bg-gray-50', !active);
}

function isValidArchive(file) {
  if (!file || typeof file.name !== 'string') {
    return false;
  }
  return file.name.toLowerCase().endsWith('.npz');
}

function handleSelectedFile({ preserveStatus = false } = {}) {
  const file = elements.fileInput?.files?.[0];
  if (!elements.uploadBtn) return;

  if (!file) {
    elements.uploadBtn.disabled = true;
    if (!preserveStatus) {
      setUploadStatus('No NPZ file selected.');
    }
    return;
  }

  if (!isValidArchive(file)) {
    elements.uploadBtn.disabled = true;
    if (!preserveStatus) {
      setUploadStatus('Selected file is not an NPZ archive.', { isError: true });
    }
    return;
  }

  elements.uploadBtn.disabled = false;
  if (!preserveStatus) {
    const sizeLabel = Number.isFinite(file.size) ? formatBytes(file.size) : 'unknown size';
    setUploadStatus(`Ready to upload "${file.name}" (${sizeLabel}).`);
  }
}

function applyFileToInput(file) {
  if (!file || !elements.fileInput) return;
  if (typeof DataTransfer !== 'undefined') {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    elements.fileInput.files = dataTransfer.files;
    return;
  }
  if (file instanceof FileList) {
    try {
      elements.fileInput.files = file;
    } catch {
      /* no-op */
    }
    return;
  }
  try {
    const fileList = {
      0: file,
      length: 1,
      item: index => (index === 0 ? file : null),
    };
    elements.fileInput.files = fileList;
  } catch {
    /* ignore assignment errors */
  }
}

async function submitArchive(event) {
  event.preventDefault();
  if (!elements.form || !elements.fileInput) return;

  const file = elements.fileInput.files?.[0];
  if (!file) {
    setUploadStatus('Please select an NPZ file.', { isError: true });
    return;
  }

  if (!isValidArchive(file)) {
    setUploadStatus('Selected file is not an NPZ archive.', { isError: true });
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  if (elements.uploadBtn) {
    elements.uploadBtn.disabled = true;
  }
  setUploadStatus(`Uploading "${file.name}"…`);

  try {
    const response = await requestJson(UPLOAD_ENDPOINT, {
      method: 'POST',
      body: formData,
      skipStringify: true,
    });

    const filename = typeof response?.filename === 'string'
      ? response.filename
      : typeof response?.project === 'string'
        ? response.project
        : file.name;
    const arrayCount = Number.isFinite(response?.array_count) ? response.array_count : null;
    const arrayLabel = arrayCount != null
      ? ` (${arrayCount} ${arrayCount === 1 ? 'array' : 'arrays'} loaded into RAM)`
      : '';

    setUploadStatus(`Upload successful: ${filename}${arrayLabel}`);
    elements.form.reset();
    handleSelectedFile({ preserveStatus: true });

    document.dispatchEvent(new CustomEvent('projects:refresh-requested', {
      detail: { preferredProject: filename, reason: 'archive-uploaded' },
    }));
  } catch (error) {
    console.error('[Feature:uploadArchive] Upload failed', error);
    if (error?.message === 'HTTP 409') {
      setUploadStatus('Upload failed: A project with that name already exists.', { isError: true });
    } else {
      setUploadStatus(`Upload failed: ${error?.message ?? 'Unexpected error.'}`, { isError: true });
    }
  } finally {
    handleSelectedFile({ preserveStatus: true });
  }
}

function handleDrop(event) {
  event.preventDefault();
  setDropzoneActive(false);
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return;
  const file = files[0];
  applyFileToInput(file);
  handleSelectedFile();
}

function registerEventListeners() {
  const { form, fileInput, dropzone, uploadBtn } = elements;
  form?.addEventListener('submit', submitArchive);
  fileInput?.addEventListener('change', () => handleSelectedFile());

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
    setDropzoneActive(true);
  });

  dropzone?.addEventListener('dragleave', () => {
    setDropzoneActive(false);
  });

  dropzone?.addEventListener('drop', handleDrop);

  if (uploadBtn) {
    uploadBtn.disabled = true;
  }
}

export function init() {
  if (state.initialized) return;
  cacheElements();
  if (!elements.form || !elements.fileInput || !elements.uploadBtn) {
    console.warn('[Feature:uploadArchive] Required elements not found.');
    return;
  }
  state.initialized = true;
  registerEventListeners();
  handleSelectedFile({ preserveStatus: true });
  console.log(`[Feature] ${FEATURE_NAME} initialized.`);
}

export default { init };
