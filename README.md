# TESSA

**Temporal Embedding and State-Space Analytics**

TESSA is a browser-based visual analytics tool for exploring latent representations alongside temporally aligned data. A FastAPI backend serves the frontend and stores projects on the local machine.

## Overview

The interface lets you inspect arrays in coordinated charts, work with one or more subjects, and save project and chart settings. No research datasets are bundled with this repository; you supply your own NumPy files.

## Features

- Coordinated scatter and time-series charts with interactive selection.
- PCA, t-SNE, and UMAP views.
- Single-subject and multi-subject projects.
- Upload, export, and persistent local project settings.

## Requirements

- Python 3.12 was verified on macOS. The original repository recommends Python 3.13, which has not yet been tested here. Dependencies are pinned in [`tool/backend/requirements.txt`](tool/backend/requirements.txt).
- `pip` and a browser with internet access for the frontend's CDN-hosted D3 and Tailwind assets.
- Node.js is not required; the frontend is served as static files.

## Installation

From the repository root, create a virtual environment and install the backend dependencies:

```bash
cd tool
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
```

On Windows, activate the environment with `.venv\Scripts\Activate.ps1` in PowerShell (or `.venv\Scripts\activate.bat` in Command Prompt) before installing the dependencies.

## Running TESSA

From `tool/`, run:

```bash
cd backend
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000/>. The same server provides both the UI and the API; there is no separate frontend build step. Uploaded projects and their settings are stored locally in `tool/backend/files/`, which is excluded from Git.

## Input data format

Use the interface to create a project from `.npy` files (one NumPy array per file) or `.npz` archives (multiple named arrays). The direct project-import endpoint accepts `.npz`. Arrays should contain numeric values. A typical feature array has shape `(n_timepoints, n_features)`; rows represent observations in chronological order.

Time alignment uses **row positions**, not timestamp values. Arrays intended for synchronized analysis should have the same sampling rate. Different row counts are accepted, but synchronized exploration ends when the shortest array ends.

For multi-subject data, place a numeric subject ID in the **first column of each subject-indexed array** and preserve chronological order within each subject. The app's Subject Configurator lets you select which arrays carry subject IDs. Trial IDs are not a required first-column convention in the current implementation.

No input data is included in the repository. You can create your own `.npz` archive with NumPy's `savez` or `savez_compressed` functions.

## Citation

See [`CITATION.cff`](CITATION.cff) for the software citation. A paper citation can be added when the publication details are final.

## License

The project includes an [MIT license](LICENSE). Third-party packages and CDN assets retain their respective licenses.
