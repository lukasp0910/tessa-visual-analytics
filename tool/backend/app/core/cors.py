"""CORS configuration for frontend communication."""

from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI

def setup_cors(app: FastAPI) -> None:
    """Configure CORS middleware to allow requests from development servers."""
    origins = [
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://127.0.0.1:5173",  # Vite dev server
        "http://localhost:5173",
        "http://127.0.0.1:8000",  # Same origin when serving frontend from backend
        "http://localhost:8000",
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
