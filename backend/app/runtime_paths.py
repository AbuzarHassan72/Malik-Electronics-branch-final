from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

APP_NAME = "Malik Electronics"
DB_FILENAME = "malik_electronic_pro_v4.db"


def _frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def bundle_root() -> Path:
    if _frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return Path(__file__).resolve().parents[2]


def default_user_data_root() -> Path:
    override = os.getenv("MALIK_APP_DATA_ROOT")
    if override:
        return Path(override).expanduser().resolve()
    if os.name == "nt":
        base = Path(os.getenv("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
        return base / APP_NAME
    return Path.home() / f".{APP_NAME.lower().replace(' ', '_')}"


def persistent_data_dir() -> Path:
    if _frozen():
        target = default_user_data_root() / "data"
    else:
        target = Path(os.getenv("MALIK_APP_DATA_DIR", bundle_root() / "backend" / "data"))
    target.mkdir(parents=True, exist_ok=True)
    return target


def db_path() -> Path:
    return persistent_data_dir() / DB_FILENAME


def bundled_default_db_path() -> Path:
    return bundle_root() / "backend" / "data" / DB_FILENAME


def ensure_persistent_db() -> Path:
    target = db_path()
    if target.exists():
        return target
    source = bundled_default_db_path()
    if source.exists():
        shutil.copy2(source, target)
    return target


def media_dir() -> Path:
    path = persistent_data_dir() / "uploads"
    path.mkdir(parents=True, exist_ok=True)
    return path


def frontend_dir() -> Path:
    return bundle_root() / "frontend"


def assets_dir() -> Path:
    return frontend_dir() / "assets"


def catalog_seed_path() -> Path:
    return bundle_root() / "backend" / "app" / "catalog_seed.json"
