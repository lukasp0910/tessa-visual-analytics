"""Upload and download related API routes."""

from __future__ import annotations

import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path as PathlibPath

from fastapi import APIRouter, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from zipfile import ZipFile, BadZipFile
import json

from app.api.v1.utils import load_npz_arrays
from app.services import metadata, registry, time_axis
from app.storage import project_storage


router = APIRouter(prefix="/projects")


@router.post("/import", status_code=status.HTTP_201_CREATED)
async def upload_binary_file(file: UploadFile = File(...)):
    """Saves NPZ archive and loads arrays."""

    filename = PathlibPath(file.filename or "upload.npz").name
    if PathlibPath(filename).suffix.lower() != ".npz":
        raise HTTPException(status_code=400, detail="Only NPZ files are allowed.")

    if project_storage.file_exists(filename):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A project with this name already exists.",
        )

    binary = await file.read()

    try:
        arrays = load_npz_arrays(binary)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Failed to read NPZ file.") from exc

    project_storage.save_file(filename, binary)
    registry.store_project(filename, arrays)
    manifest = project_storage.ensure_project_manifest(filename, arrays)

    arrays_meta = metadata.describe_arrays(arrays, manifest)
    description = metadata.project_description(arrays)
    created_at = datetime.now(timezone.utc).isoformat()
    project_storage.save_project_info(
        filename,
        {
            "name": project_storage.project_display_name(filename),
            "file_name": filename,
            "description": description or "",
            "created_at": created_at,
            "subject_mode": "single",
        },
    )
    manifest = project_storage.ensure_project_manifest(filename, arrays)
    selected_time_axis, detection_issues = time_axis.resolve_time_axis(
        filename, arrays, manifest=manifest
    )
    project_info = manifest.get("project") if isinstance(manifest, dict) else {}
    project_id = project_info.get("id") if isinstance(project_info, dict) else None
    return {
        "filename": filename,
        "size_bytes": len(binary),
        "array_count": len(arrays_meta),
        "arrays": arrays_meta,
        "description": description,
        "created_at": created_at,
        "project_id": project_id,
        "time_axis": selected_time_axis,
        "time_axis_conflicts": detection_issues,
        "subject_mode": "single",
    }


@router.get("")
async def list_uploaded_files():
    """Lists all projects with metadata."""

    files = project_storage.list_files()
    registry.ensure_projects_available(item["name"] for item in files)
    for item in files:
        summary = metadata.project_summary(item["name"])
        if summary is not None:
            item.update(summary)
    return files


@router.get("/{project_id}/archive")
async def download_uploaded_file(project_id: str):
    """Downloads NPZ archive."""

    project_name = PathlibPath(project_id).name
    file_path = project_storage.read_file_path(project_name)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    return FileResponse(
        file_path,
        media_type="application/octet-stream",
        filename=project_name,
    )


@router.get("/{project_id}/export")
async def export_project_as_zip(project_id: str):
    """Export the entire project folder as a ZIP file for download."""

    project_name = PathlibPath(project_id).name
    project_dir = project_storage.project_directory(project_name)
    
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail=f"Project directory not found: {project_dir}")
    
    # Make temp ZIP file
    temp_dir = PathlibPath(tempfile.mkdtemp())
    zip_filename = f"{project_dir.stem}.zip"
    zip_base_path = temp_dir / project_dir.stem
    
    try:
        # Archive files at root level
        archive_path = shutil.make_archive(
            str(zip_base_path),
            'zip',
            project_dir  # Use project_dir as root, so contents are at top level
        )
        
        zip_path = PathlibPath(archive_path)
        
        if not zip_path.exists():
            raise HTTPException(
                status_code=500,
                detail="Failed to create ZIP archive"
            )
        
        # Return file & cleanup temp dir
        def cleanup():
            try:
                if zip_path.exists():
                    zip_path.unlink()
                if temp_dir.exists():
                    shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception:
                pass
        
        return FileResponse(
            path=str(zip_path),
            media_type="application/zip",
            filename=zip_filename,
            background=cleanup
        )
    except HTTPException:
        raise
    except Exception as exc:
        # Cleanup temp files on error
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            pass
        raise HTTPException(
            status_code=500,
            detail=f"Failed to create ZIP archive: {str(exc)}"
        ) from exc


@router.post("/import-zip", status_code=status.HTTP_201_CREATED)
async def import_project_zip(file: UploadFile = File(...)):
    """Restore a previously exported project ZIP archive.

    Expected contents:
      - <name>.npz (primary data file)
      - project.json (metadata)
      - sheet.json (optional sheet layout)
    """

    filename = PathlibPath(file.filename or 'archive.zip').name
    if not filename.lower().endswith('.zip'):
        raise HTTPException(status_code=400, detail='Only ZIP archives are allowed.')

    # Read archive bytes
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail='Empty ZIP archive.')

    # Extract to temp dir
    temp_dir = PathlibPath(tempfile.mkdtemp(prefix='project-import-'))
    try:
        zip_path = temp_dir / filename
        zip_path.write_bytes(data)
        try:
            with ZipFile(zip_path, 'r') as zf:
                zf.extractall(temp_dir)
        except BadZipFile as exc:
            raise HTTPException(status_code=400, detail='Invalid ZIP archive.') from exc

        # Find NPZ and metadata
        npz_files = list(temp_dir.glob('*.npz'))
        if not npz_files:
            raise HTTPException(status_code=400, detail='Archive missing NPZ data file.')
        if len(npz_files) > 1:
            raise HTTPException(status_code=400, detail='Archive must contain exactly one NPZ file.')
        npz_path = npz_files[0]

        project_json_path = temp_dir / 'project.json'
        sheet_json_path = temp_dir / 'sheet.json'

        # Get target filename
        target_filename = npz_path.name
        if project_storage.file_exists(target_filename):
            raise HTTPException(status_code=409, detail='A project with this name already exists.')

        # Load NPZ arrays
        arrays_binary = npz_path.read_bytes()
        try:
            arrays = load_npz_arrays(arrays_binary)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail='Failed to read NPZ file in archive.') from exc

        # Save NPZ to storage
        saved_path = project_storage.save_file(target_filename, arrays_binary)
        registry.store_project(target_filename, arrays)
        manifest_data: dict = {}
        if project_json_path.exists():
            try:
                manifest_data = json.loads(project_json_path.read_text(encoding='utf-8'))
                if not isinstance(manifest_data, dict):
                    manifest_data = {}
            except Exception:
                manifest_data = {}

        if manifest_data:
            project_storage.save_project_manifest(target_filename, manifest_data)

        manifest = project_storage.ensure_project_manifest(target_filename, arrays)

        # Load project metadata if available
        project_meta = manifest_data if isinstance(manifest_data, dict) else {}
        project_info = project_meta.get('project') if isinstance(project_meta, dict) else {}

        description = project_info.get('description') or metadata.project_description(arrays) or ''
        created_at = project_info.get('created_at') or datetime.now(timezone.utc).isoformat()
        subject_mode = project_info.get('subject_mode') or 'single'

        # Save project metadata
        project_storage.save_project_info(
            target_filename,
            {
                'name': project_storage.project_display_name(target_filename),
                'file_name': target_filename,
                'description': description,
                'created_at': created_at,
                'subject_mode': subject_mode,
            },
        )

        # Restore sheet config if present
        if sheet_json_path.exists():
            try:
                sheet_data = json.loads(sheet_json_path.read_text(encoding='utf-8'))
                if isinstance(sheet_data, dict):
                    project_storage.save_sheet_config(target_filename, sheet_data)
            except Exception:
                pass

        project_storage.ensure_sheet_config(target_filename)

        arrays_meta = metadata.describe_arrays(arrays, manifest)
        selected_time_axis, detection_issues = time_axis.resolve_time_axis(target_filename, arrays, manifest=manifest)
        project_info = manifest.get('project') if isinstance(manifest, dict) else {}
        project_id = project_info.get('id') if isinstance(project_info, dict) else None

        return {
            'filename': target_filename,
            'project_name': target_filename,
            'array_count': len(arrays_meta),
            'arrays': arrays_meta,
            'description': description,
            'created_at': created_at,
            'project_id': project_id,
            'time_axis': selected_time_axis,
            'time_axis_conflicts': detection_issues,
            'subject_mode': subject_mode,
        }
    finally:
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            pass

