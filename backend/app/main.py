from __future__ import annotations

import json
import jwt
import logging
import os
import re
import shutil
import sqlite3
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Annotated
from uuid import uuid4

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .auth import (
    ALGORITHM,
    SECRET_KEY,
    create_access_token,
    get_current_branch_id,
    get_current_user,
    hash_password,
    require_active_branch,
    require_ready_user,
    verify_password,
)
from .db import (
    DATA_DIR,
    execute,
    fetch_all,
    fetch_one,
    get_db_cursor,
    get_product_stock_snapshot,
    initialize_database,
    log_activity,
    normalize_key,
    now_iso,
    recalculate_sale_costs,
    record_account_transaction,
    seed_defaults,
    seed_catalog_models,
)
from .exporters import build_export_file
from .runtime_paths import assets_dir, frontend_dir
from .invoices import build_invoice_pdf
from .schemas import (
    CategoryCreate,
    CategoryUpdate,
    CatalogModelCreate,
    CredentialUpdateRequest,
    DiscountRuleCreate,
    DiscountRuleUpdate,
    InvoiceCreate,
    LocationCreate,
    LocationUpdate,
    LoginRequest,
    PasswordVerifyRequest,
    ProductCreate,
    ProductUpdate,
    ProductBatchCreate,
    PurchaseCreate,
    PurchaseUpdate,
    SaleCreate,
    SaleTransactionCreate,
    SaleUpdate,
)

FRONTEND_DIR = frontend_dir()
ASSETS_DIR = assets_dir()
BACKEND_ROOT_UPLOADS = Path(__file__).resolve().parent.parent / "uploads"
IS_VERCEL = os.getenv("VERCEL") == "1" or bool(os.getenv("VERCEL_ENV"))
MEDIA_DIR = (Path("/tmp/malik_uploads") if IS_VERCEL else (BACKEND_ROOT_UPLOADS if BACKEND_ROOT_UPLOADS.exists() else (DATA_DIR / "uploads")))
MEDIA_DIR.mkdir(parents=True, exist_ok=True)
DEFAULT_USERNAME = "Malik Alyas"
DEFAULT_PASSWORD = "malik123"
TOP_COMPANIES = ["Dawlance", "Haier"]
COMPANY_ALIASES = {}
COMMON_BRANDS = [*TOP_COMPANIES]
COMMON_COLORS = [
    "Black", "White", "Silver", "Gray", "Grey", "Red", "Blue", "Golden",
    "Green", "Brown", "Half White", "Cloud White", "Emerald Green", "Gem Black",
    "Coral Red", "Hairline Silver", "Milky White", "Milky White Textured",
    "Matt Silver", "Champagne", "Noir Red", "Avante Pearl Red", "Avante Pearl Burgundy",
]
CATEGORY_ICON_OPTIONS = ["🧊", "🫧", "❄️", "🌬️", "🔥", "📺", "📱", "💻", "🍳", "🔌", "🎛️", "📦", "💧", "🧼", "🥤", "🏢", "🥘", "🌫️"]
CATEGORY_MEDIA_DIR = MEDIA_DIR / "category-images"
CATEGORY_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
COMPANY_MEDIA_DIR = MEDIA_DIR / "company-images"
COMPANY_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
BRANCH_MEDIA_DIR = MEDIA_DIR / "branch-images"
BRANCH_MEDIA_DIR.mkdir(parents=True, exist_ok=True)

LOGO_HINTS = {"Dawlance": "dawlance", "Haier": "haier"}
ASSET_EXTENSIONS = (".png", ".jpg", ".jpeg", ".jfif", ".jif", ".webp", ".svg", ".gif")

APP_VERSION = "20260407-v30-exe"
RUNTIME_MODE = "desktop" if os.getenv("MALIK_DESKTOP_MODE") == "1" else "web"
PRICE_COOKIE_NAME = "malik_price_access"
PRICE_UNLOCK_MINUTES = 20
SENSITIVE_PRICE_KEYS = {
    "amount", "average_unit_cost", "base_unit_price", "current_stock_value", "default_price", "default_purchase_price",
    "default_sale_price", "discount_amount", "discount_value", "gross_profit", "last_purchase_price", "last_sale_price",
    "purchase_total", "purchase_value", "sales_total", "sales_value", "stock_value", "subtotal", "total_amount",
    "total_price", "total_profit", "unit_cost", "unit_price", "current_stock_value"
}


# --- Pydantic Schemas for Multi-Branch and Company Extensions ---
class BranchCreate(BaseModel):
    name: str
    address: str = ""
    description: str = ""
    image_path: str = ""


class BranchUpdate(BaseModel):
    name: str
    address: str = ""
    description: str = ""
    image_path: str = ""
    status: str = "Active"


class CompanyPayload(BaseModel):
    name: str
    image_path: str = ""


class NoCacheStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        if response.status_code < 400:
            response.headers["Cache-Control"] = "public, max-age=3600, stale-while-revalidate=86400"
        return response


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("malik_app")

app = FastAPI(title="Malik Electronic Professional Multi-Branch App", version="3.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
from .biometric_session_auth import register_phase2_security, is_valid_verification_secret
register_phase2_security(app)
app.mount("/static", NoCacheStaticFiles(directory=str(ASSETS_DIR)), name="static")


@app.get("/media/{subpath:path}", include_in_schema=False)
def serve_media_file(subpath: str):
    clean_sub = urllib.parse.unquote(subpath or "").lstrip("/\\")
    filename = Path(clean_sub).name

    # 1. Check all possible media & client asset directories for this exact file
    candidate_paths = [
        BACKEND_ROOT_UPLOADS / clean_sub,
        DATA_DIR / "uploads" / clean_sub,
        MEDIA_DIR / clean_sub,
        ASSETS_DIR / "images" / clean_sub,
        ASSETS_DIR / "images" / "companies" / filename,
        ASSETS_DIR / "images" / "categories" / filename,
        ASSETS_DIR / "MAlik Images" / filename,
        BACKEND_ROOT_UPLOADS / "company-images" / filename,
        BACKEND_ROOT_UPLOADS / "category-images" / filename,
        BACKEND_ROOT_UPLOADS / "branch-images" / filename,
        DATA_DIR / "uploads" / "company-images" / filename,
        DATA_DIR / "uploads" / "category-images" / filename,
        DATA_DIR / "uploads" / "branch-images" / filename,
    ]
    for cand in candidate_paths:
        if cand.exists() and cand.is_file():
            return FileResponse(
                cand,
                headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
            )

    # 2. If a branch image UUID changed in DB, return the available branch image file
    if "branch-images" in clean_sub or filename.startswith("branch-"):
        for b_dir in [BACKEND_ROOT_UPLOADS / "branch-images", DATA_DIR / "uploads" / "branch-images"]:
            if b_dir.exists():
                b_files = sorted([f for f in b_dir.iterdir() if f.is_file() and f.suffix.lower() in ASSET_EXTENSIONS])
                if b_files:
                    idx = sum(ord(c) for c in filename) % len(b_files)
                    return FileResponse(
                        b_files[idx],
                        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
                    )

    return Response(status_code=404)


def create_price_access_token(username: str) -> str:
    expires = datetime.now(timezone.utc) + timedelta(minutes=PRICE_UNLOCK_MINUTES)
    payload = {"sub": username, "scope": "price_access", "exp": expires}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def price_access_granted(request: Request) -> bool:
    token = request.cookies.get(PRICE_COOKIE_NAME)
    if not token:
        return False
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload.get("scope") == "price_access"
    except jwt.InvalidTokenError:
        return False


def _mask_sensitive_prices(payload):
    if isinstance(payload, list):
        return [_mask_sensitive_prices(item) for item in payload]
    if isinstance(payload, dict):
        masked = {}
        for key, value in payload.items():
            if key in SENSITIVE_PRICE_KEYS and value is not None:
                masked[key] = None
            else:
                masked[key] = _mask_sensitive_prices(value)
        masked["can_view_prices"] = False if "can_view_prices" not in masked else masked["can_view_prices"]
        return masked
    return payload


def secure_payload(request: Request, payload):
    if price_access_granted(request):
        return payload
    return _mask_sensitive_prices(payload)


def calculate_discount_amount(subtotal: float, apply_discount: bool, discount_type: str, discount_value: float) -> float:
    subtotal = round(float(subtotal or 0), 2)
    if not apply_discount or subtotal <= 0:
        return 0.0
    value = max(float(discount_value or 0), 0.0)
    if discount_type == "percent":
        return round(min(subtotal, subtotal * value / 100), 2)
    return round(min(subtotal, value), 2)


def relevance_score(query: str, *values: str) -> int:
    tokens = [token for token in normalize_key(query).split() if token]
    if not tokens:
        return 0
    haystacks = [normalize_key(value) for value in values if value]
    if not haystacks:
        return 0
    combined_haystack = " ".join(haystacks)
    clean_query = normalize_key(query).strip()
    score = 0
    if clean_query and clean_query in combined_haystack:
        score += 300

    for token in tokens:
        token_matched = False
        for hay in haystacks:
            if hay == token:
                score += 120
                token_matched = True
            elif hay.startswith(token):
                score += 70
                token_matched = True
            elif f" {token}" in f" {hay}":
                score += 40
                token_matched = True
            elif token in hay:
                score += 20
                token_matched = True
        if not token_matched:
            return 0
    return score


def page_response(filename: str) -> FileResponse:
    path = FRONTEND_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Page not found.")
    return FileResponse(path, headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache", "Expires": "0"})


def _sync_client_images_to_db() -> None:
    """Ensures companies and categories whose DB image_path is missing or absent on disk are mapped to client images."""
    try:
        # 1. Sync Companies
        for row in fetch_all("SELECT id, name, image_path FROM companies"):
            img_path = (row.get("image_path") or "").strip()
            needs_repair = not img_path
            if img_path.startswith("/media/"):
                rel = img_path.replace("/media/", "", 1)
                if not (BACKEND_ROOT_UPLOADS / rel).exists() and not (DATA_DIR / "uploads" / rel).exists():
                    needs_repair = True
            if needs_repair:
                matched = resolve_static_asset(ASSETS_DIR / "images" / "companies", row["name"])
                if matched:
                    execute(
                        "UPDATE companies SET image_path = ? WHERE id = ?",
                        (f"/api/assets/company-logo/{urllib.parse.quote(row['name'])}", row["id"]),
                    )

        # 2. Sync Categories
        for row in fetch_all("SELECT id, name, image_path FROM categories"):
            img_path = (row.get("image_path") or "").strip()
            needs_repair = not img_path
            if img_path.startswith("/media/"):
                rel = img_path.replace("/media/", "", 1)
                if not (BACKEND_ROOT_UPLOADS / rel).exists() and not (DATA_DIR / "uploads" / rel).exists():
                    needs_repair = True
            if needs_repair:
                matched = resolve_static_asset(ASSETS_DIR / "images" / "categories", row["name"])
                if matched:
                    execute(
                        "UPDATE categories SET image_path = ? WHERE id = ?",
                        (f"/api/assets/category-image/{urllib.parse.quote(row['name'])}", row["id"]),
                    )
    except Exception as exc:
        logger.warning("Client image sync notice: %s", exc)


@app.on_event("startup")
def startup_event():
    initialize_database()
    ensure_default_owner()
    _sync_client_images_to_db()
    try:
        execute("CREATE INDEX IF NOT EXISTS idx_fast_pe_pid ON purchase_entries(product_id);")
        execute("CREATE INDEX IF NOT EXISTS idx_fast_se_pid ON sale_entries(product_id);")
        execute("CREATE INDEX IF NOT EXISTS idx_fast_prod_branch ON products(branch_id, active);")
        execute("DELETE FROM account_transactions WHERE party_name LIKE 'Internal%' OR description LIKE '%TRANSFER%';")
    except Exception as e:
        logger.warning(f"Index/cleanup notice: {e}")
    logger.info("Application startup complete with DB at %s", DATA_DIR)


@app.middleware("http")
async def disable_browser_cache(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if request.method in {"GET", "HEAD"}:
        if path.startswith("/static/") or path.startswith("/media/") or path.startswith("/api/assets/"):
            response.headers["Cache-Control"] = "public, max-age=3600, stale-while-revalidate=86400"
        elif path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response


@app.get("/")
def root_redirect():
    return RedirectResponse(url="/login", status_code=302)


@app.get("/favicon.ico", include_in_schema=False)
def favicon_redirect():
    favicon_path = ASSETS_DIR / "favicon.svg"
    if favicon_path.exists():
        return FileResponse(favicon_path, media_type="image/svg+xml")
    return Response(status_code=204)


@app.get("/login")
def login_page():
    return page_response("login.html")


@app.get("/dashboard")
def dashboard_page():
    return page_response("dashboard.html")


@app.get("/inventory")
def inventory_page():
    return page_response("inventory.html")


@app.get("/category/{category_id}")
def category_page(category_id: int):
    page = FRONTEND_DIR / "category.html"
    if not page.exists():
        raise HTTPException(status_code=404, detail="Page not found.")
    return FileResponse(page, headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache", "Expires": "0"})


@app.get("/sales")
def sales_page():
    return page_response("sales.html")


@app.get("/purchases")
def purchases_page():
    return page_response("purchases.html")


@app.get("/accounts")
def accounts_page():
    return page_response("accounts.html")


@app.get("/stocks")
def stocks_page():
    return page_response("stocks.html")


CLIENT_COMPANY_FILE_MAP = {
    "anex": ["an", "anex"],
    "asia": ["asia"],
    "bonus": ["bo", "bonus", "bouns"],
    "bouns": ["bo", "bonus", "bouns"],
    "dawlance": ["dawlance", "dw"],
    "haier": ["haier"],
    "ecoplus": ["eco", "ecoplus", "eco-plus", "eco-plus-led"],
    "ecoplusled": ["eco", "ecoplus", "eco-plus-led", "eco plus led"],
    "gasstove": ["stove", "gas-stove", "gas stove", "super flame"],
    "kenwood": ["kenwood"],
    "national": ["na", "national"],
    "nasgas": ["nas", "nasgas"],
    "nexen": ["nex", "nexen"],
    "royal": ["roy", "royal"],
    "samford": ["sam", "samford"],
    "superflame": ["super flame", "super-flame", "superflame"],
    "united": ["united"],
    "westpoint": ["westpoint", "west-point"],
}

CLIENT_CATEGORY_FILE_MAP = {
    "airconditioner": ["fac", "ac", "air-conditioner", "air conditioner"],
    "ac": ["fac", "ac", "air-conditioner"],
    "fan": ["fan", "fac", "stf", "fans"],
    "ceilingfan": ["fac", "fan", "ceiling-fan"],
    "pedestalfan": ["stf", "fan", "pedestal-fan"],
    "bracketfan": ["fan", "stf", "bracket-fan"],
    "exhaustfan": ["fac", "fan", "exhaust-fan"],
    "geyser": ["gez", "geyser", "geysers", "water-heater"],
    "waterheater": ["gez", "water-heater", "geyser"],
    "iron": ["iron", "irons", "dry-iron"],
    "stabilizer": ["st", "stabilizer", "stabilizers"],
    "gasstove": ["stove", "gas-stove", "gas stove", "sp"],
    "stove": ["stove", "sp", "stp"],
    "singleburner": ["sp", "stove"],
    "hotplate": ["sp", "stove"],
    "cookingrange": ["stp", "gez", "cooking-range", "oven"],
    "microwave": ["stp", "microwave", "oven"],
    "oven": ["stp", "oven"],
    "toaster": ["tost", "toaster", "sandwich-maker"],
    "sandwichmaker": ["tost", "sandwich-maker"],
    "vacuumcleaner": ["vac", "vacuum-cleaner", "vacuum"],
    "vacuum": ["vac", "vacuum"],
    "washingmachine": ["vac", "washing-machine", "washing machine", "washer"],
    "spinner": ["sp", "spinner", "dryer"],
    "dryer": ["sp", "dryer"],
    "refrigerator": ["fac", "refrigerator", "fridge"],
    "deepfreezer": ["fac", "deep-freezer", "freezer"],
    "waterdispenser": ["gez", "water-dispenser", "dispenser"],
    "ledtv": ["eco", "led-tv", "led", "tv"],
    "roomcooler": ["fan", "air-cooler", "room-cooler", "cooler"],
}


def _find_matching_image_in_dirs(folders: list[Path], slug: str, alias_map: dict[str, list[str]]) -> Path | None:
    raw_clean = urllib.parse.unquote(slug or "").strip()
    if not raw_clean:
        return None
    norm_slug = re.sub(r"[^a-z0-9]", "", raw_clean.lower())
    norm_singular = norm_slug.rstrip("s") if len(norm_slug) > 3 else norm_slug
    dash_slug = normalize_key(raw_clean).replace(" ", "-")

    candidate_stems: list[str] = [raw_clean, raw_clean.lower(), dash_slug, norm_slug, norm_singular]
    for key, stems in alias_map.items():
        if norm_slug == key or norm_singular == key or key in norm_slug or norm_slug in key:
            candidate_stems.extend(stems)

    # Deduplicate while preserving order
    seen_stems = set()
    ordered_stems = []
    for s in candidate_stems:
        s_clean = s.strip()
        if s_clean and s_clean not in seen_stems:
            seen_stems.add(s_clean)
            ordered_stems.append(s_clean)

    for folder in folders:
        if not folder or not folder.exists():
            continue
        # 1. Direct stem + extension lookup
        for stem in ordered_stems:
            for ext in ASSET_EXTENSIONS:
                cand = folder / f"{stem}{ext}"
                if cand.exists() and cand.is_file():
                    return cand

        # 2. Case-insensitive scan of all files inside the folder
        try:
            all_files = [f for f in folder.iterdir() if f.is_file() and f.suffix.lower() in ASSET_EXTENSIONS]
        except Exception:
            all_files = []

        for stem in ordered_stems:
            stem_compact = re.sub(r"[^a-z0-9]", "", stem.lower())
            if not stem_compact:
                continue
            for f in all_files:
                file_compact = re.sub(r"[^a-z0-9]", "", f.stem.lower())
                if file_compact == stem_compact:
                    return f

        # 3. Prefix/substring fallback scan on folder files
        for stem in ordered_stems:
            stem_compact = re.sub(r"[^a-z0-9]", "", stem.lower())
            if len(stem_compact) < 2:
                continue
            for f in all_files:
                file_compact = re.sub(r"[^a-z0-9]", "", f.stem.lower())
                if len(file_compact) >= 2 and (file_compact.startswith(stem_compact) or stem_compact.startswith(file_compact)):
                    return f

    return None


def resolve_static_asset(folder: Path, slug: str) -> Path | None:
    is_company = "compan" in folder.name.lower()
    folders = (
        [
            ASSETS_DIR / "images" / "companies",
            ASSETS_DIR / "MAlik Images",
            COMPANY_MEDIA_DIR,
            ASSETS_DIR / "images" / "categories",
        ]
        if is_company
        else [
            ASSETS_DIR / "images" / "categories",
            ASSETS_DIR / "MAlik Images",
            CATEGORY_MEDIA_DIR,
            ASSETS_DIR / "images" / "companies",
        ]
    )
    alias_map = CLIENT_COMPANY_FILE_MAP if is_company else CLIENT_CATEGORY_FILE_MAP
    return _find_matching_image_in_dirs(folders, slug, alias_map)


@app.get("/api/assets/company-logo/{slug:path}", include_in_schema=False)
def company_logo_asset(slug: str):
    asset = resolve_static_asset(ASSETS_DIR / "images" / "companies", slug)
    if not asset:
        return Response(status_code=404)
    return FileResponse(asset, headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache", "Expires": "0"})


@app.get("/api/assets/category-image/{slug:path}", include_in_schema=False)
def category_image_asset(slug: str):
    asset = resolve_static_asset(ASSETS_DIR / "images" / "categories", slug)
    if not asset:
        return Response(status_code=404)
    return FileResponse(asset, headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache", "Expires": "0"})


@app.get("/health")
def health_check():
    return {"status": "ok"}


def normalize_username(value: str) -> str:
    return " ".join((value or "").strip().split())


def canonical_company_name(value: str | None) -> str:
    raw = " ".join((value or "").strip().split())
    if not raw:
        return ""
    alias = COMPANY_ALIASES.get(normalize_key(raw))
    if alias:
        return alias
    for company in TOP_COMPANIES:
        if normalize_key(company) == normalize_key(raw):
            return company
    return raw


def company_sort_key(name: str | None) -> tuple[int, str]:
    company = canonical_company_name(name)
    if company in TOP_COMPANIES:
        return (TOP_COMPANIES.index(company), company.lower())
    return (len(TOP_COMPANIES) + 1, (company or "").lower())


def logo_slug_for_company(name: str | None) -> str:
    company = canonical_company_name(name)
    return LOGO_HINTS.get(company, normalize_key(company).replace(" ", "-"))


def get_known_companies(branch_id: int = 1) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()

    def add(name: str | None) -> None:
        company = canonical_company_name(name)
        if not company:
            return
        key = normalize_key(company)
        if key in seen:
            return
        seen.add(key)
        names.append(company)

    for company in TOP_COMPANIES:
        add(company)

    for row in fetch_all("SELECT name FROM companies WHERE branch_id = ? ORDER BY name ASC", (branch_id,)):
        add(row.get("name"))
    for row in fetch_all("SELECT DISTINCT company FROM products WHERE branch_id = ? AND ifnull(company, '') != '' ORDER BY company ASC", (branch_id,)):
        add(row.get("company"))
    for row in fetch_all("SELECT DISTINCT company FROM catalog_models WHERE branch_id = ? AND ifnull(company, '') != '' ORDER BY company ASC", (branch_id,)):
        add(row.get("company"))

    defaults = [company for company in TOP_COMPANIES if normalize_key(company) in seen]
    custom = [company for company in names if company not in TOP_COMPANIES]
    custom.sort(key=lambda value: value.lower())
    return defaults + custom


def category_name_from_id(category_id: int, branch_id: int = 1) -> str:
    category = fetch_one("SELECT name FROM categories WHERE id = ? AND branch_id = ?", (category_id, branch_id))
    if not category:
        raise HTTPException(status_code=404, detail="Category not found.")
    return category["name"]


def format_product_label(row: dict) -> str:
    series = str(row.get("series") or "").strip()
    model = str(row.get("model") or "").strip()
    company = str(row.get("company") or "").strip()
    color = str(row.get("color") or "").strip()
    size = str(row.get("size") or "").strip()
    head = " / ".join([part for part in [series, model] if part])
    parts = [part for part in [company, color, size] if part]
    return f"{head} ({' / '.join(parts)})" if parts else head


def format_product_ascii_label(row: dict) -> str:
    series = str(row.get("series") or "").strip()
    model = str(row.get("model") or "").strip()
    company = str(row.get("company") or "").strip()
    color = str(row.get("color") or "").strip()
    size = str(row.get("size") or "").strip()
    head = " - ".join([part for part in [series, model] if part])
    parts = [part for part in [company, color, size] if part]
    return f"{head} - {' - '.join(parts)}" if parts else head


def parse_multi_values(raw_values: list[str] | None, *, fallback: str = "") -> list[str]:
    values = [item.strip() for item in (raw_values or []) if str(item).strip()]
    if values:
        return list(dict.fromkeys(values))
    return [fallback.strip() or ""]


def product_duplicate_clause(payload, branch_id: int = 1) -> tuple[str, tuple]:
    return (
        "branch_id = ? AND category_id = ? AND ifnull(location_id,0) = ifnull(?,0) AND lower(series) = lower(?) AND lower(model) = lower(?) AND lower(company) = lower(?) AND lower(color) = lower(?) AND lower(size) = lower(?) AND active = 1",
        (branch_id, payload.category_id, payload.location_id, payload.series.strip(), payload.model.strip(), canonical_company_name(payload.company), payload.color.strip(), payload.size.strip()),
    )


def refresh_invoice_record(invoice_id: int) -> None:
    totals = fetch_one(
        """
        SELECT
            COALESCE(SUM(ii.quantity * COALESCE(ii.base_unit_price, ii.unit_price)), 0) AS subtotal,
            COALESCE(SUM(ii.discount_amount), 0) AS discount_amount,
            COALESCE(SUM(ii.total_price), 0) AS total_amount,
            COUNT(*) AS item_count
        FROM invoice_items ii
        WHERE ii.invoice_id = ?
        """,
        (invoice_id,),
    ) or {"subtotal": 0, "discount_amount": 0, "total_amount": 0, "item_count": 0}
    if int(totals.get("item_count") or 0) <= 0:
        execute("DELETE FROM account_transactions WHERE invoice_id = ?", (invoice_id,))
        execute("DELETE FROM invoices WHERE id = ?", (invoice_id,))
        return
    execute(
        "UPDATE invoices SET subtotal = ?, discount_amount = ?, total_amount = ?, pdf_path = '', updated_at = ? WHERE id = ?",
        (
            float(totals.get("subtotal") or 0),
            float(totals.get("discount_amount") or 0),
            float(totals.get("total_amount") or 0),
            now_iso(),
            invoice_id,
        ),
    )


def create_opening_purchase_entry(product_id: int, quantity: int, unit_cost: float, username: str | None = None, note: str = "Opening stock", branch_id: int = 1) -> None:
    if int(quantity or 0) <= 0:
        return
    current_time = now_iso()
    purchase_id = execute(
        """
        INSERT INTO purchase_entries (
            branch_id, product_id, quantity, unit_cost, purchase_date, supplier_name, supplier_phone, reference_no, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, '', '', 'OPENING', ?, ?, ?)
        """,
        (branch_id, product_id, int(quantity), float(unit_cost or 0), datetime.utcnow().date().isoformat(), note, current_time, current_time),
    )
    product = _product_exists(product_id, branch_id)
    record_account_transaction(
        datetime.utcnow().date().isoformat(),
        "purchase",
        "out",
        int(quantity) * float(unit_cost or 0),
        "Recorded",
        "Opening stock",
        f"{note} for {product.get('model')}",
        branch_id=branch_id,
        category_id=product["category_id"],
        product_id=product_id,
        purchase_id=purchase_id,
    )
    if username:
        log_activity(username, "purchase", "created", f"{note} added for product #{product_id}.", purchase_id, branch_id=branch_id)


def permanently_delete_product(product_id: int) -> None:
    purchase_rows = fetch_all("SELECT id FROM purchase_entries WHERE product_id = ?", (product_id,))
    sale_rows = fetch_all("SELECT id, invoice_id FROM sale_entries WHERE product_id = ?", (product_id,))
    invoice_ids = sorted({int(row["invoice_id"]) for row in sale_rows if row.get("invoice_id")})
    purchase_ids = [int(row["id"]) for row in purchase_rows]
    sale_ids = [int(row["id"]) for row in sale_rows]

    if purchase_ids:
        placeholders = ",".join(["?"] * len(purchase_ids))
        execute(f"DELETE FROM account_transactions WHERE purchase_id IN ({placeholders})", tuple(purchase_ids))
    if sale_ids:
        placeholders = ",".join(["?"] * len(sale_ids))
        execute(f"DELETE FROM account_transactions WHERE sale_id IN ({placeholders})", tuple(sale_ids))

    execute("DELETE FROM account_transactions WHERE product_id = ?", (product_id,))
    execute("DELETE FROM invoice_items WHERE product_id = ?", (product_id,))
    execute("DELETE FROM sale_entries WHERE product_id = ?", (product_id,))
    execute("DELETE FROM purchase_entries WHERE product_id = ?", (product_id,))

    for invoice_id in invoice_ids:
        refresh_invoice_record(invoice_id)

    execute("DELETE FROM products WHERE id = ?", (product_id,))


def get_user_by_username(username: str) -> dict | None:
    clean = normalize_username(username)
    if not clean:
        return None
    return fetch_one("SELECT * FROM users WHERE username_key = ?", (normalize_key(clean),))


def ensure_default_owner() -> None:
    existing = get_user_by_username(DEFAULT_USERNAME)
    if existing:
        execute("UPDATE users SET must_change_password = 0 WHERE id = ?", (existing["id"],))
        return
    total_users = fetch_one("SELECT COUNT(*) AS count FROM users") or {"count": 0}
    if int(total_users["count"] or 0) == 0:
        execute(
            "INSERT INTO users (username, username_key, password_hash, must_change_password, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
            (DEFAULT_USERNAME, normalize_key(DEFAULT_USERNAME), hash_password(DEFAULT_PASSWORD), now_iso(), now_iso()),
        )


def _branch_exists(branch_id: int) -> dict:
    branch = fetch_one("SELECT * FROM branches WHERE id = ?", (branch_id,))
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found.")
    return branch


def _category_exists(category_id: int, branch_id: int = 1) -> dict:
    category = fetch_one("SELECT * FROM categories WHERE id = ? AND branch_id = ?", (category_id, branch_id))
    if not category:
        raise HTTPException(status_code=404, detail="Category not found.")
    return category


def _location_exists(location_id: int | None, branch_id: int = 1) -> dict | None:
    if not location_id:
        return None
    location = fetch_one("SELECT * FROM locations WHERE id = ? AND branch_id = ?", (location_id, branch_id))
    if not location:
        raise HTTPException(status_code=404, detail="Location not found.")
    return location


def _product_exists(product_id: int, branch_id: int = 1) -> dict:
    product = fetch_one(
        """
        SELECT p.*, c.name AS category_name, c.icon AS category_icon, l.name AS location_name
        FROM products p
        JOIN categories c ON c.id = p.category_id AND c.branch_id = p.branch_id
        LEFT JOIN locations l ON l.id = p.location_id AND l.branch_id = p.branch_id
        WHERE p.id = ? AND p.branch_id = ?
        """,
        (product_id, branch_id),
    )
    if not product:
        raise HTTPException(status_code=404, detail="Product not found.")
    return product


def get_products_data(
    *,
    branch_id: int = 1,
    category_id: int | None = None,
    company: str | None = None,
    series: str | None = None,
    color: str | None = None,
    location_id: int | None = None,
    search: str = "",
):
    conditions = ["p.active = 1", "p.branch_id = ?"]
    params: list = [branch_id]
    if category_id:
        conditions.append("p.category_id = ?")
        params.append(category_id)
    if location_id:
        conditions.append("p.location_id = ?")
        params.append(location_id)
    if company:
        conditions.append("lower(p.company) = lower(?)")
        params.append(company.strip())
    if series:
        conditions.append("lower(p.series) = lower(?)")
        params.append(series.strip())
    if color:
        conditions.append("lower(p.color) = lower(?)")
        params.append(color.strip())
    if search.strip():
        term = f"%{search.strip()}%"
        conditions.append("(p.series LIKE ? OR p.model LIKE ? OR p.company LIKE ? OR p.color LIKE ? OR p.size LIKE ? OR c.name LIKE ? OR l.name LIKE ?)")
        params.extend([term, term, term, term, term, term, term])
    where_clause = " AND ".join(conditions)
    rows = fetch_all(
        f"""
        SELECT
            p.id,
            p.branch_id,
            p.category_id,
            p.location_id,
            p.series,
            p.model,
            p.company,
            p.color,
            p.size,
            p.image_path,
            p.min_stock,
            p.default_purchase_price,
            p.default_sale_price,
            p.notes,
            p.created_at,
            p.updated_at,
            c.name AS category_name,
            c.icon AS category_icon,
            l.name AS location_name,
            COALESCE(pu.qty, 0) AS total_purchased_qty,
            COALESCE(pu.value, 0) AS total_purchased_value,
            COALESCE(sa.qty, 0) AS total_sold_qty,
            COALESCE(sa.revenue, 0) AS total_sales_value,
            COALESCE(sa.profit, 0) AS total_profit,
            COALESCE(pu.last_cost, p.default_purchase_price, 0) AS last_purchase_price,
            COALESCE(pu.last_date, '') AS last_purchase_date,
            '' AS last_supplier_name,
            COALESCE(sa.last_price, p.default_sale_price, 0) AS last_sale_price,
            COALESCE(sa.last_date, '') AS last_sale_date,
            '' AS last_customer_name
        FROM products p
        JOIN categories c ON c.id = p.category_id AND c.branch_id = p.branch_id
        LEFT JOIN locations l ON l.id = p.location_id AND l.branch_id = p.branch_id
        LEFT JOIN (
            SELECT product_id,
                   SUM(quantity) AS qty,
                   SUM(quantity * unit_cost) AS value,
                   MAX(unit_cost) AS last_cost,
                   MAX(purchase_date) AS last_date
            FROM purchase_entries WHERE branch_id = ? GROUP BY product_id
        ) pu ON pu.product_id = p.id
        LEFT JOIN (
            SELECT se.product_id,
                   SUM(se.quantity) AS qty,
                   ROUND(CAST(SUM(COALESCE(ii.total_price, se.quantity * se.unit_price)) AS NUMERIC), 2) AS revenue,
                   SUM(se.total_profit) AS profit,
                   MAX(se.unit_price) AS last_price,
                   MAX(se.sale_date) AS last_date
            FROM sale_entries se
            LEFT JOIN invoice_items ii ON ii.sale_entry_id = se.id AND ii.branch_id = se.branch_id
            WHERE se.branch_id = ? GROUP BY se.product_id
        ) sa ON sa.product_id = p.id
        WHERE {where_clause}
        ORDER BY c.name ASC, p.company ASC, p.series ASC, p.model ASC
        """,
        (branch_id, branch_id, *params),
    )
    for row in rows:
        row["product_label"] = format_product_label(row)
        row["current_stock"] = float(row["total_purchased_qty"] or 0) - float(row["total_sold_qty"] or 0)
        row["average_unit_cost"] = (
            float(row["total_purchased_value"] or 0) / float(row["total_purchased_qty"] or 1)
            if float(row["total_purchased_qty"] or 0) > 0
            else 0.0
        )
        row["current_stock_value"] = row["current_stock"] * row["average_unit_cost"]
        row["low_stock"] = row["current_stock"] <= float(row["min_stock"] or 0)
        row["search_score"] = relevance_score(
            search,
            row.get("category_name") or "",
            row.get("company") or "",
            row.get("series") or "",
            row.get("model") or "",
            row.get("color") or "",
            row.get("size") or "",
            row.get("location_name") or "",
        )
    if search.strip():
        rows.sort(key=lambda row: (-int(row.get("search_score") or 0), -(float(row.get("current_stock") or 0)), str(row.get("model") or "").lower()))
    return rows


def get_category_rows(branch_id: int = 1) -> list[dict]:
    inventory = get_products_data(branch_id=branch_id)
    categories = fetch_all("SELECT * FROM categories WHERE branch_id = ? ORDER BY name ASC", (branch_id,))
    catalog_rows = fetch_all(
        "SELECT category_name, company, series, model FROM catalog_models WHERE branch_id = ? ORDER BY category_name ASC, company ASC, series ASC, model ASC",
        (branch_id,),
    )
    rows: list[dict] = []
    for category in categories:
        items = [item for item in inventory if item["category_id"] == category["id"]]
        catalog_items = [item for item in catalog_rows if normalize_key(item["category_name"]) == normalize_key(category["name"])]
        inventory_model_keys = {(normalize_key(str(item.get("company") or "")), normalize_key(str(item.get("series") or "")), normalize_key(str(item.get("model") or ""))) for item in items}
        catalog_model_keys = {(normalize_key(str(item.get("company") or "")), normalize_key(str(item.get("series") or "")), normalize_key(str(item.get("model") or ""))) for item in catalog_items}
        combined_model_keys = inventory_model_keys | catalog_model_keys
        series_keys = {(normalize_key(str(item.get("company") or "")), normalize_key(str(item.get("series") or ""))) for item in catalog_items if str(item.get("series") or "").strip()}
        rows.append(
            {
                **category,
                "image_path": category.get("image_path") or "",
                "product_count": len(combined_model_keys),
                "series_count": len(series_keys),
                "variant_count": len(items),
                "current_units": round(sum(float(item["current_stock"] or 0) for item in items), 2),
                "current_value": round(sum(float(item["current_stock_value"] or 0) for item in items), 2),
            }
        )
    return rows


def generate_purchase_number(purchase_date: str, branch_id: int = 1) -> str:
    prefix = purchase_date.replace("-", "")
    existing = fetch_one("SELECT COUNT(*) AS count FROM purchase_entries WHERE purchase_date = ? AND branch_id = ?", (purchase_date, branch_id)) or {"count": 0}
    sequence = int(existing["count"] or 0) + 1
    return f"PUR-{prefix}-{sequence:03d}"


def resolve_branch_id(request: Request, fallback: int = 1) -> int:
    hdr = request.headers.get("x-branch-id")
    if hdr and str(hdr).strip().isdigit():
        return int(hdr.strip())
    q = request.query_params.get("branch_id")
    if q and str(q).strip().isdigit():
        return int(q.strip())
    c = request.cookies.get("malik_branch_id") or request.cookies.get("branch_id")
    if c and str(c).strip().isdigit():
        return int(c.strip())
    return fallback


def get_purchase_rows(
    *,
    branch_id: int = 1,
    product_id: int | None = None,
    category_id: int | None = None,
    company: str | None = None,
    supplier: str | None = None,
    search: str = "",
    stock_status: str = "all",
    start_date: str | None = None,
    end_date: str | None = None,
):
    conditions = [
        "pe.branch_id = ?",
        "ifnull(pe.reference_no, '') NOT LIKE 'TRANSFER%'",
        "ifnull(pe.reference_no, '') NOT LIKE 'TR-%'",
        "ifnull(pe.supplier_name, '') NOT LIKE 'Internal%'",
        "ifnull(pe.supplier_name, '') NOT LIKE 'Branch Transfer%'",
    ]
    params: list = [branch_id]
    if product_id:
        conditions.append("pe.product_id = ?")
        params.append(product_id)
    if category_id:
        conditions.append("p.category_id = ?")
        params.append(category_id)
    if company:
        conditions.append("lower(p.company) = lower(?)")
        params.append(company.strip())
    if supplier:
        conditions.append("pe.supplier_name LIKE ?")
        params.append(f"%{supplier.strip()}%")
    if start_date:
        conditions.append("pe.purchase_date >= ?")
        params.append(start_date)
    if end_date:
        conditions.append("pe.purchase_date <= ?")
        params.append(end_date)
    if search.strip():
        term = f"%{search.strip()}%"
        conditions.append("(p.model LIKE ? OR p.series LIKE ? OR p.company LIKE ? OR p.color LIKE ? OR pe.reference_no LIKE ? OR pe.supplier_name LIKE ? OR c.name LIKE ?)")
        params.extend([term, term, term, term, term, term, term])

    rows = fetch_all(
        f"""
        SELECT pe.*, p.series, p.model, p.company, p.color, p.size, c.id AS category_id, c.name AS category_name, l.name AS location_name,
               (COALESCE((SELECT SUM(pe_sub.quantity) FROM purchase_entries pe_sub WHERE pe_sub.product_id = p.id AND pe_sub.branch_id = pe.branch_id), 0) -
                COALESCE((SELECT SUM(se_sub.quantity) FROM sale_entries se_sub WHERE se_sub.product_id = p.id AND se_sub.branch_id = pe.branch_id), 0)) AS current_stock
        FROM purchase_entries pe
        JOIN products p ON p.id = pe.product_id AND p.branch_id = pe.branch_id
        JOIN categories c ON c.id = p.category_id AND c.branch_id = pe.branch_id
        LEFT JOIN locations l ON l.id = p.location_id AND l.branch_id = pe.branch_id
        WHERE {' AND '.join(conditions)}
        ORDER BY pe.purchase_date DESC, pe.id DESC
        """,
        tuple(params),
    )
    filtered = []
    status_filter = (stock_status or "all").lower().strip()
    for row in rows:
        row["product_label"] = format_product_label(row)
        row["total_amount"] = round(float(row["quantity"] or 0) * float(row["unit_cost"] or 0), 2)
        row["stock_status"] = "in_stock" if float(row.get("current_stock") or 0) > 0 else "out_of_stock"
        if status_filter == "in_stock" and row["stock_status"] != "in_stock":
            continue
        if status_filter == "out_of_stock" and row["stock_status"] != "out_of_stock":
            continue
        filtered.append(row)
    return filtered


def get_sales_rows(
    *,
    branch_id: int = 1,
    product_id: int | None = None,
    category_id: int | None = None,
    customer: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
):
    conditions = [
        "se.branch_id = ?",
        "ifnull(se.reference_no, '') NOT LIKE 'TRANSFER%'",
        "ifnull(se.reference_no, '') NOT LIKE 'TR-%'",
        "ifnull(se.customer_name, '') NOT LIKE 'Internal%'",
        "ifnull(se.customer_name, '') NOT LIKE 'Branch Transfer%'",
    ]
    params: list = [branch_id]
    if product_id:
        conditions.append("se.product_id = ?")
        params.append(product_id)
    if category_id:
        conditions.append("p.category_id = ?")
        params.append(category_id)
    if customer:
        conditions.append("se.customer_name LIKE ?")
        params.append(f"%{customer.strip()}%")
    if start_date:
        conditions.append("se.sale_date >= ?")
        params.append(start_date)
    if end_date:
        conditions.append("se.sale_date <= ?")
        params.append(end_date)
    rows = fetch_all(
        f"""
        SELECT se.*, inv.invoice_number, p.series, p.model, p.company, p.color, p.size, c.id AS category_id, c.name AS category_name, l.name AS location_name
        FROM sale_entries se
        JOIN products p ON p.id = se.product_id AND p.branch_id = se.branch_id
        JOIN categories c ON c.id = p.category_id AND c.branch_id = se.branch_id
        LEFT JOIN locations l ON l.id = p.location_id AND l.branch_id = se.branch_id
        LEFT JOIN invoices inv ON inv.id = se.invoice_id AND inv.branch_id = se.branch_id
        WHERE {' AND '.join(conditions)}
        ORDER BY se.sale_date DESC, se.id DESC
        """,
        tuple(params),
    )
    for row in rows:
        row["product_label"] = format_product_label(row)
        row["total_amount"] = round(float(row["quantity"] or 0) * float(row["unit_price"] or 0), 2)
    return rows


def get_account_rows(
    *,
    branch_id: int = 1,
    category_id: int | None = None,
    customer: str | None = None,
    supplier: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
):
    conditions = ["at.branch_id = ?"]
    params: list = [branch_id]
    if category_id:
        conditions.append("at.category_id = ?")
        params.append(category_id)
    if customer:
        conditions.append("(at.party_name LIKE ? AND at.direction = 'in')")
        params.append(f"%{customer.strip()}%")
    if supplier:
        conditions.append("(at.party_name LIKE ? AND at.direction = 'out')")
        params.append(f"%{supplier.strip()}%")
    if start_date:
        conditions.append("at.transaction_date >= ?")
        params.append(start_date)
    if end_date:
        conditions.append("at.transaction_date <= ?")
        params.append(end_date)
    rows = fetch_all(
        f"""
        SELECT at.*, c.name AS category_name, p.series, p.model, p.company, p.color, p.size, inv.invoice_number
        FROM account_transactions at
        LEFT JOIN categories c ON c.id = at.category_id AND c.branch_id = at.branch_id
        LEFT JOIN products p ON p.id = at.product_id AND p.branch_id = at.branch_id
        LEFT JOIN invoices inv ON inv.id = at.invoice_id AND inv.branch_id = at.branch_id
        WHERE {' AND '.join(conditions)}
        ORDER BY at.transaction_date DESC, at.id DESC
        """,
        tuple(params),
    )
    for row in rows:
        row["product_label"] = format_product_label(row) if row.get("model") else ""
    return rows


def build_sale_signature(customer_name: str, transaction_at: str, items: list[dict], branch_id: int = 1) -> str:
    normalized_customer = normalize_key(customer_name)
    normalized_items = sorted(
        [f"{int(item['product_id'])}:{float(item['quantity']):.2f}:{float(item['unit_price']):.2f}" for item in items]
    )
    minute_bucket = (transaction_at or "")[:16]
    return f"{branch_id}|{normalized_customer}|{minute_bucket}|{'|'.join(normalized_items)}"


def _catalog_rows_for_category(category_name: str, company: str | None = None, branch_id: int = 1) -> list[dict]:
    conditions = ["category_key = ?", "branch_id = ?"]
    params: list = [normalize_key(category_name), branch_id]
    if company:
        conditions.append("company_key = ?")
        params.append(normalize_key(canonical_company_name(company)))
    rows = fetch_all(
        f"SELECT * FROM catalog_models WHERE {' AND '.join(conditions)} ORDER BY company ASC, series ASC, model ASC",
        tuple(params),
    )
    return rows


def _build_master_model_rows(category_id: int, company: str | None = None, branch_id: int = 1) -> tuple[dict, list[dict], list[dict]]:
    category = _category_exists(category_id, branch_id)
    category_name = category["name"]
    selected_company = canonical_company_name(company) if company else ""
    variants = get_products_data(category_id=category_id, branch_id=branch_id)
    catalog_rows = _catalog_rows_for_category(category_name, selected_company or None, branch_id=branch_id)
    master_map: dict[tuple[str, str, str], dict] = {}

    def ensure_master(*, company_name: str, series: str, model: str, size: str = "", image_path: str = "", default_price: float = 0.0, source: str = "stock") -> dict:
        company_clean = canonical_company_name(company_name)
        key = (normalize_key(company_clean), normalize_key(series), normalize_key(model))
        if key not in master_map:
            master_map[key] = {
                "key": "|".join(key),
                "branch_id": branch_id,
                "company": company_clean,
                "logo_slug": logo_slug_for_company(company_clean),
                "category_id": category_id,
                "category_name": category_name,
                "series": series or "",
                "model": model or "",
                "size": "",
                "sizes_map": defaultdict(lambda: {"name": "", "variant_count": 0}),
                "image_path": image_path or "",
                "default_price": float(default_price or 0),
                "source": source,
                "total_stock": 0.0,
                "sold_units": 0.0,
                "purchase_value": 0.0,
                "sales_value": 0.0,
                "stock_value": 0.0,
                "gross_profit": 0.0,
                "colors_map": defaultdict(lambda: {"name": "", "units": 0.0, "variant_count": 0}),
                "locations_map": defaultdict(lambda: {"name": "", "units": 0.0, "variant_count": 0}),
                "variants": [],
            }
        entry = master_map[key]
        if image_path and not entry["image_path"]:
            entry["image_path"] = image_path
        if default_price and not entry["default_price"]:
            entry["default_price"] = float(default_price)
        return entry

    for row in catalog_rows:
        ensure_master(
            company_name=row["company"],
            series=str(row.get("series") or "").strip(),
            model=str(row.get("model") or "").strip(),
            default_price=float(row.get("default_price") or 0),
            source="catalog",
        )

    for item in variants:
        entry = ensure_master(
            company_name=item.get("company") or "Unassigned",
            series=str(item.get("series") or "").strip(),
            model=str(item.get("model") or "").strip(),
            size=str(item.get("size") or "").strip(),
            image_path=str(item.get("image_path") or "").strip(),
            default_price=float(item.get("default_sale_price") or item.get("default_purchase_price") or 0),
            source="stock",
        )
        remaining = float(item.get("current_stock") or 0)
        sold = float(item.get("total_sold_qty") or 0)
        purchase_value = float(item.get("total_purchased_value") or 0)
        sales_value = float(item.get("total_sales_value") or 0)
        stock_value = float(item.get("current_stock_value") or 0)
        gross_profit = float(item.get("total_profit") or 0)
        entry["total_stock"] += remaining
        entry["sold_units"] += sold
        entry["purchase_value"] += purchase_value
        entry["sales_value"] += sales_value
        entry["stock_value"] += stock_value
        entry["gross_profit"] += gross_profit
        color_name = str(item.get("color") or "").strip() or "Standard"
        location_name = str(item.get("location_name") or "").strip() or "Unassigned"
        size_name = str(item.get("size") or "").strip()
        if size_name:
            entry["sizes_map"][size_name]["name"] = size_name
            entry["sizes_map"][size_name]["variant_count"] += 1
        entry["colors_map"][color_name]["name"] = color_name
        entry["colors_map"][color_name]["units"] += remaining
        entry["colors_map"][color_name]["variant_count"] += 1
        entry["locations_map"][location_name]["name"] = location_name
        entry["locations_map"][location_name]["units"] += remaining
        entry["locations_map"][location_name]["variant_count"] += 1
        entry["variants"].append({
            "id": item["id"],
            "company": canonical_company_name(item.get("company") or ""),
            "series": item.get("series") or "",
            "model": item.get("model") or "",
            "color": color_name,
            "size": item.get("size") or "",
            "location_id": item.get("location_id"),
            "location_name": location_name,
            "remaining_units": remaining,
            "sold_units": sold,
            "purchase_value": purchase_value,
            "sales_value": sales_value,
            "stock_value": stock_value,
            "gross_profit": gross_profit,
            "default_purchase_price": float(item.get("default_purchase_price") or 0),
            "default_sale_price": float(item.get("default_sale_price") or 0),
            "last_purchase_price": float(item.get("last_purchase_price") or 0),
            "last_purchase_date": item.get("last_purchase_date") or "",
            "last_sale_price": float(item.get("last_sale_price") or 0),
            "last_sale_date": item.get("last_sale_date") or "",
            "last_supplier_name": item.get("last_supplier_name") or "",
            "last_customer_name": item.get("last_customer_name") or "",
            "image_path": item.get("image_path") or "",
            "min_stock": item.get("min_stock") or 0,
            "notes": item.get("notes") or "",
        })

    all_rows = []
    for entry in master_map.values():
        colors = sorted(entry.pop("colors_map").values(), key=lambda row: (-row["units"], row["name"].lower()))
        locations = sorted(entry.pop("locations_map").values(), key=lambda row: (-row["units"], row["name"].lower()))
        sizes = sorted(entry.pop("sizes_map").values(), key=lambda row: row["name"].lower())
        entry["colors"] = [{**row, "units": round(row["units"], 2)} for row in colors]
        entry["locations"] = [{**row, "units": round(row["units"], 2)} for row in locations]
        entry["sizes"] = sizes
        entry["variants"] = sorted(entry["variants"], key=lambda row: (row["color"].lower(), -row["remaining_units"], row["location_name"].lower()))

        color_loc_map: dict[str, dict] = defaultdict(lambda: {"total_units": 0.0, "locations": []})
        for v in entry["variants"]:
            c_name = v["color"] or "Standard"
            rem = float(v["remaining_units"] or 0)
            color_loc_map[c_name]["total_units"] += rem
            color_loc_map[c_name]["locations"].append({
                "product_id": v["id"],
                "location_id": v["location_id"],
                "location_name": v["location_name"] or "Unassigned",
                "units": rem,
                "sold_units": v.get("sold_units", 0),
            })
        entry["color_locations"] = [
            {"color": c, "total_units": round(data["total_units"], 2), "locations": data["locations"]}
            for c, data in sorted(color_loc_map.items(), key=lambda item: (-item[1]["total_units"], item[0].lower()))
        ]
        entry["total_stock"] = round(entry["total_stock"], 2)
        entry["sold_units"] = round(entry["sold_units"], 2)
        entry["purchase_value"] = round(entry["purchase_value"], 2)
        entry["sales_value"] = round(entry["sales_value"], 2)
        entry["stock_value"] = round(entry["stock_value"], 2)
        entry["gross_profit"] = round(entry["gross_profit"], 2)
        entry["stock_status"] = "in_stock" if entry["total_stock"] > 0 else "out_of_stock"
        entry["display_name"] = " / ".join([part for part in [entry["series"], entry["model"]] if part]) or entry["model"]
        all_rows.append(entry)

    all_rows.sort(key=lambda row: (company_sort_key(row["company"]), 0 if row["stock_status"] == "in_stock" else 1, -row["total_stock"], row["display_name"].lower()))
    return category, variants, all_rows


def build_category_detail(
    category_id: int,
    company: str | None = None,
    search: str = "",
    series: str | None = None,
    stock_status: str = "all",
    branch_id: int = 1,
) -> dict:
    category, variants, master_rows = _build_master_model_rows(category_id, company, branch_id=branch_id)
    company_filter = canonical_company_name(company) if company else ""
    search_text = search.strip().lower()
    series_filter = normalize_key(series) if series else ""
    stock_filter = (stock_status or "all").strip().lower()

    filtered_rows = []
    for row in master_rows:
        if company_filter and canonical_company_name(row["company"]) != company_filter:
            continue
        if series_filter and normalize_key(row.get("series") or "") != series_filter:
            continue
        if stock_filter == "in_stock" and row["total_stock"] <= 0:
            continue
        if stock_filter == "out_of_stock" and row["total_stock"] > 0:
            continue
        score = relevance_score(
            search_text,
            category["name"],
            row.get("company") or "",
            row.get("series") or "",
            row.get("model") or "",
            row.get("size") or "",
            " ".join(color["name"] for color in row.get("colors", [])),
            " ".join(location["name"] for location in row.get("locations", [])),
        )
        if search_text and score <= 0:
            continue
        row = {**row, "search_score": score}
        filtered_rows.append(row)
    if search_text:
        filtered_rows.sort(key=lambda row: (-int(row.get("search_score") or 0), -(float(row.get("total_stock") or 0)), str(row.get("display_name") or "").lower()))

    section_order = []
    if company_filter:
        section_order = [company_filter]
    else:
        section_order = sorted({row["company"] for row in filtered_rows if row.get("company")}, key=company_sort_key)

    company_sections = []
    for company_name in section_order:
        rows = [row for row in filtered_rows if canonical_company_name(row["company"]) == company_name]
        if not rows:
            continue
        in_stock_rows = [row for row in rows if row["total_stock"] > 0]
        out_of_stock_rows = [row for row in rows if row["total_stock"] <= 0]

        grouped_by_series: dict[str, list[dict]] = defaultdict(list)
        for row in in_stock_rows + out_of_stock_rows:
            grouped_by_series[row.get("series") or "Unspecified Series"].append(row)
        series_sections = []
        for series_name in sorted(grouped_by_series.keys(), key=lambda value: (value or "").lower()):
            series_rows = grouped_by_series[series_name]
            series_sections.append({
                "series": series_name,
                "model_count": len(series_rows),
                "in_stock_count": len([row for row in series_rows if row["total_stock"] > 0]),
                "out_of_stock_count": len([row for row in series_rows if row["total_stock"] <= 0]),
                "available_units": round(sum(float(row["total_stock"] or 0) for row in series_rows), 2),
                "stock_value": round(sum(float(row["stock_value"] or 0) for row in series_rows), 2),
                "models": series_rows,
            })
        db_companies = {row["name"]: row["image_path"] for row in fetch_all("SELECT name, image_path FROM companies WHERE branch_id = ?", (branch_id,))}
        company_sections.append({
            "company": company_name,
            "logo_slug": logo_slug_for_company(company_name),
            "image_path": db_companies.get(company_name, ""),
            "title": f"{company_name} {category['name']}",
            "in_stock_count": len(in_stock_rows),
            "out_of_stock_count": len(out_of_stock_rows),
            "available_units": round(sum(float(row["total_stock"] or 0) for row in rows), 2),
            "purchase_value": round(sum(float(row["purchase_value"] or 0) for row in rows), 2),
            "sales_value": round(sum(float(row["sales_value"] or 0) for row in rows), 2),
            "stock_value": round(sum(float(row["stock_value"] or 0) for row in rows), 2),
            "models": in_stock_rows + out_of_stock_rows,
            "series_sections": series_sections,
            "in_stock_models": in_stock_rows,
            "out_of_stock_models": out_of_stock_rows,
        })

    series_options = sorted({row["series"] for row in master_rows if row.get("series") and (not company_filter or canonical_company_name(row["company"]) == company_filter)}, key=lambda value: value.lower())
    company_options = sorted({canonical_company_name(row["company"]) for row in master_rows if row.get("company")}, key=company_sort_key)
    total_stock = round(sum(float(row["total_stock"] or 0) for row in filtered_rows), 2)
    in_stock_models = len([row for row in filtered_rows if row["total_stock"] > 0])
    out_of_stock_models = len([row for row in filtered_rows if row["total_stock"] <= 0])
    purchase_value = round(sum(float(row["purchase_value"] or 0) for row in filtered_rows), 2)
    sales_value = round(sum(float(row["sales_value"] or 0) for row in filtered_rows), 2)
    stock_value = round(sum(float(row["stock_value"] or 0) for row in filtered_rows), 2)
    gross_profit = round(sum(float(row["gross_profit"] or 0) for row in filtered_rows), 2)
    sold_units = round(sum(float(row["sold_units"] or 0) for row in filtered_rows), 2)

    location_distribution: dict[str, float] = defaultdict(float)
    color_distribution: dict[str, float] = defaultdict(float)
    for row in filtered_rows:
        for location in row.get("locations", []):
            location_distribution[location["name"]] += float(location["units"] or 0)
        for color in row.get("colors", []):
            color_distribution[color["name"]] += float(color["units"] or 0)

    payload = {
        "category": category,
        "selected_company": company_filter or "",
        "page_title": f"{company_filter} {category['name']}" if company_filter else category["name"],
        "summary": {
            "master_models": len(filtered_rows),
            "in_stock_models": in_stock_models,
            "out_of_stock_models": out_of_stock_models,
            "available_units": total_stock,
            "sold_units": sold_units,
            "purchase_value": purchase_value,
            "sales_value": sales_value,
            "stock_value": stock_value,
            "gross_profit": gross_profit,
        },
        "company_sections": company_sections,
        "company_options": company_options,
        "series_options": series_options,
        "locations": [{"label": key, "units": round(value, 2)} for key, value in sorted(location_distribution.items(), key=lambda item: (-item[1], item[0]))],
        "colors": [{"label": key, "units": round(value, 2)} for key, value in sorted(color_distribution.items(), key=lambda item: (-item[1], item[0]))],
        "variants": variants,
        "master_models": filtered_rows,
    }
    return payload


def build_dashboard_insights(
    company: str | None = None,
    category_id: int | None = None,
    search: str = "",
    series: str | None = None,
    stock_status: str = "all",
    branch_id: int = 1,
) -> dict:
    # Fetch all branch data in 4 fast batched queries instead of 140+ per-row queries
    categories = fetch_all("SELECT * FROM categories WHERE branch_id = ? ORDER BY name ASC", (branch_id,))
    inventory = get_products_data(branch_id=branch_id)
    all_catalog = fetch_all(
        "SELECT company, company_key, category_name, category_key, series, model, default_price FROM catalog_models WHERE branch_id = ?",
        (branch_id,),
    )
    db_companies_rows = fetch_all("SELECT id, name, image_path FROM companies WHERE branch_id = ?", (branch_id,))
    db_companies_map = {normalize_key(row["name"]): row for row in db_companies_rows}

    company_names = get_known_companies(branch_id=branch_id)
    selected_company = canonical_company_name(company) if company else (company_names[0] if company_names else TOP_COMPANIES[0])
    if selected_company not in company_names and selected_company:
        company_names.append(selected_company)

    # Pre-index catalog models by company_key in memory
    catalog_by_comp: dict[str, list[dict]] = defaultdict(list)
    for cm in all_catalog:
        c_key = cm.get("company_key") or normalize_key(canonical_company_name(cm.get("company")))
        catalog_by_comp[c_key].append(cm)

    companies = []
    for company_name in company_names:
        c_key = normalize_key(company_name)
        company_inventory = [row for row in inventory if canonical_company_name(row.get("company")) == company_name]
        comp_cat_rows = catalog_by_comp.get(c_key, [])

        available_units = round(sum(float(row.get("current_stock") or 0) for row in company_inventory), 2)
        stock_value = round(sum(float(row.get("current_stock_value") or 0) for row in company_inventory), 2)
        purchase_value = round(sum(float(row.get("total_purchased_value") or 0) for row in company_inventory), 2)
        sales_value = round(sum(float(row.get("total_sales_value") or 0) for row in company_inventory), 2)
        gross_profit = round(sum(float(row.get("total_profit") or 0) for row in company_inventory), 2)

        cat_keys_from_catalog = {r.get("category_key") for r in comp_cat_rows if r.get("category_key")}
        dynamic_categories = len({row["category_id"] for row in company_inventory})
        category_count_val = max(len(cat_keys_from_catalog), dynamic_categories)

        model_keys = {
            (normalize_key(r.get("series") or ""), normalize_key(r.get("model") or ""))
            for r in comp_cat_rows
        } | {
            (normalize_key(r.get("series") or ""), normalize_key(r.get("model") or ""))
            for r in company_inventory
        }

        comp_record = db_companies_map.get(c_key) or {}
        companies.append({
            "id": comp_record.get("id"),
            "name": company_name,
            "logo_slug": logo_slug_for_company(company_name),
            "image_path": comp_record.get("image_path") or "",
            "available_units": available_units,
            "purchase_value": purchase_value,
            "sales_value": sales_value,
            "stock_value": stock_value,
            "gross_profit": gross_profit,
            "catalog_models": max(len(comp_cat_rows), len(model_keys)),
            "category_count": category_count_val,
            "is_selected": company_name == selected_company,
        })

    selected_comp_key = normalize_key(selected_company)
    selected_comp_catalog = catalog_by_comp.get(selected_comp_key, [])
    selected_comp_inventory = [row for row in inventory if canonical_company_name(row.get("company")) == selected_company]

    category_cards = []
    for category in categories:
        cat_id = category["id"]
        cat_key = normalize_key(category["name"])
        cat_inv = [row for row in selected_comp_inventory if row["category_id"] == cat_id]
        cat_catalog = [row for row in selected_comp_catalog if (row.get("category_key") or normalize_key(row.get("category_name"))) == cat_key]

        if not cat_inv and not cat_catalog:
            continue

        # Group by master model (series_key, model_key) in memory
        master_stock: dict[tuple[str, str], float] = defaultdict(float)
        for cm in cat_catalog:
            m_key = (normalize_key(cm.get("series") or ""), normalize_key(cm.get("model") or ""))
            master_stock[m_key] += 0.0
        for item in cat_inv:
            m_key = (normalize_key(item.get("series") or ""), normalize_key(item.get("model") or ""))
            master_stock[m_key] += float(item.get("current_stock") or 0)

        in_stock_models = sum(1 for units in master_stock.values() if units > 0)
        out_of_stock_models = sum(1 for units in master_stock.values() if units <= 0)

        category_cards.append({
            "id": cat_id,
            "name": category["name"],
            "icon": category["icon"],
            "image_path": category.get("image_path") or "",
            "company": selected_company,
            "logo_slug": logo_slug_for_company(selected_company),
            "title": f"{selected_company} {category['name']}",
            "master_models": len(master_stock),
            "in_stock_models": in_stock_models,
            "out_of_stock_models": out_of_stock_models,
            "available_units": round(sum(float(r.get("current_stock") or 0) for r in cat_inv), 2),
            "sold_units": round(sum(float(r.get("total_sold_qty") or 0) for r in cat_inv), 2),
            "purchase_value": round(sum(float(r.get("total_purchased_value") or 0) for r in cat_inv), 2),
            "sales_value": round(sum(float(r.get("total_sales_value") or 0) for r in cat_inv), 2),
            "stock_value": round(sum(float(r.get("current_stock_value") or 0) for r in cat_inv), 2),
            "gross_profit": round(sum(float(r.get("total_profit") or 0) for r in cat_inv), 2),
        })

    payload = {
        "stats": {
            "total_categories": len(categories),
            "total_stock_value": round(sum(float(item.get("current_stock_value") or 0) for item in inventory), 2),
            "purchase_total": round(sum(float(item.get("total_purchased_value") or 0) for item in inventory), 2),
            "sales_total": round(sum(float(item.get("total_sales_value") or 0) for item in inventory), 2),
            "gross_profit": round(sum(float(item.get("total_profit") or 0) for item in inventory), 2),
        },
        "selected_company": selected_company,
        "companies": companies,
        "category_cards": category_cards,
        "active_category": None,
    }
    return payload


def build_stocks_overview(
    company: str | None = None,
    category_id: int | None = None,
    search: str = "",
    stock_status: str = "in_stock",
    branch_id: int = 1,
) -> dict:
    selected_company = canonical_company_name(company) if company else ""
    selected_category_id = int(category_id) if category_id else None
    status_filter = (stock_status or "in_stock").strip().lower()
    search_term = (search or "").strip().lower()

    categories_rows = fetch_all("SELECT id, name, icon, image_path FROM categories WHERE branch_id = ? ORDER BY name ASC", (branch_id,))
    cat_map = {c["id"]: c for c in categories_rows}
    db_companies = {row["name"]: row["image_path"] for row in fetch_all("SELECT name, image_path FROM companies WHERE branch_id = ?", (branch_id,))}
    known_companies = get_known_companies(branch_id=branch_id)

    sql = """
        SELECT p.id, p.category_id, p.company, p.series, p.model, p.color, p.size, p.location_id,
               COALESCE(l.name, 'Unassigned') AS location_name,
               c.name AS category_name, c.icon AS category_icon, c.image_path AS category_image_path,
               COALESCE(pu.qty, 0) - COALESCE(sa.qty, 0) AS remaining_units
        FROM products p
        JOIN categories c ON c.id = p.category_id AND c.branch_id = p.branch_id
        LEFT JOIN locations l ON l.id = p.location_id AND l.branch_id = p.branch_id
        LEFT JOIN (
            SELECT product_id, SUM(quantity) AS qty
            FROM purchase_entries 
            WHERE branch_id = ?
            GROUP BY product_id
        ) pu ON pu.product_id = p.id
        LEFT JOIN (
            SELECT product_id, SUM(quantity) AS qty
            FROM sale_entries 
            WHERE branch_id = ?
            GROUP BY product_id
        ) sa ON sa.product_id = p.id
        WHERE p.branch_id = ? AND p.active = 1
    """
    all_products = fetch_all(sql, (branch_id, branch_id, branch_id))

    models_dict: dict[tuple, dict] = {}
    for p in all_products:
        comp_name = canonical_company_name(p["company"] or "Unknown")
        cat_id = p["category_id"]
        series_name = (p["series"] or "").strip() or "General Models"
        model_name = (p["model"] or "").strip()
        rem_units = float(p["remaining_units"] or 0)
        rem_units_clean = int(rem_units) if rem_units.is_integer() else round(rem_units, 2)

        key = (comp_name, cat_id, series_name, model_name)
        if key not in models_dict:
            model_key = "|".join([normalize_key(comp_name), normalize_key(series_name), normalize_key(model_name)])
            models_dict[key] = {
                "key": model_key,
                "company": comp_name,
                "category_id": cat_id,
                "category_name": p["category_name"],
                "category_icon": p["category_icon"] or "📦",
                "category_image_path": p["category_image_path"] or "",
                "series": series_name,
                "model": model_name,
                "display_name": f"{series_name} - {model_name}" if series_name != "General Models" else model_name,
                "total_stock": 0,
                "colors_map": defaultdict(lambda: {"total": 0, "locations": []}),
                "variants": [],
            }

        m = models_dict[key]
        m["total_stock"] += rem_units_clean
        color_name = (p["color"] or "").strip() or "Standard"
        loc_name = p["location_name"]

        m["colors_map"][color_name]["total"] += rem_units_clean
        m["colors_map"][color_name]["locations"].append({
            "product_id": p["id"],
            "location_name": loc_name,
            "units": rem_units_clean,
        })
        m["variants"].append({
            "id": p["id"],
            "color": color_name,
            "location_name": loc_name,
            "remaining_units": rem_units_clean,
        })

    company_order = [selected_company] if selected_company else known_companies
    company_sections = []

    for comp_name in company_order:
        comp_models = [m for k, m in models_dict.items() if k[0] == comp_name]
        if not comp_models:
            continue

        cat_groups: dict[int, list] = defaultdict(list)
        for m in comp_models:
            if selected_category_id and m["category_id"] != selected_category_id:
                continue

            is_in_stock = m["total_stock"] > 0
            if status_filter == "in_stock" and not is_in_stock:
                continue
            if status_filter == "out_of_stock" and is_in_stock:
                continue

            if search_term:
                hay = f"{m['company']} {m['category_name']} {m['series']} {m['model']} " + " ".join(m["colors_map"].keys())
                if search_term not in hay.lower():
                    continue

            c_locations = []
            for c_name, c_info in sorted(m["colors_map"].items()):
                c_locations.append({
                    "color": c_name,
                    "total": c_info["total"],
                    "locations": c_info["locations"],
                })
            m["color_locations"] = c_locations
            m["stock_status"] = "in_stock" if is_in_stock else "out_of_stock"
            cat_groups[m["category_id"]].append(m)

        category_sections = []
        for cat_id, m_list in cat_groups.items():
            if not m_list:
                continue
            cat_info = cat_map.get(cat_id, {})
            category_sections.append({
                "category_id": cat_id,
                "category_name": cat_info.get("name", "Category"),
                "category_icon": cat_info.get("icon", "📦"),
                "category_image_path": cat_info.get("image_path", ""),
                "page_title": f"{comp_name} {cat_info.get('name', 'Category')}",
                "summary": {
                    "master_models": len(m_list),
                    "available_units": sum(m["total_stock"] for m in m_list),
                    "in_stock_models": len([m for m in m_list if m["total_stock"] > 0]),
                    "out_of_stock_models": len([m for m in m_list if m["total_stock"] <= 0]),
                },
                "rows": m_list,
            })

        if category_sections:
            company_sections.append({
                "company": comp_name,
                "logo_slug": logo_slug_for_company(comp_name),
                "image_path": db_companies.get(comp_name, ""),
                "category_sections": category_sections,
                "summary": {
                    "categories": len(category_sections),
                    "master_models": sum(len(g["rows"]) for g in category_sections),
                    "available_units": sum(g["summary"]["available_units"] for g in category_sections),
                },
            })

    company_list = [{"name": c, "image_path": db_companies.get(c, "")} for c in known_companies]

    return {
        "selected_company": selected_company,
        "selected_category_id": selected_category_id,
        "companies": known_companies,
        "company_list": company_list,
        "categories": categories_rows,
        "stock_status": stock_status,
        "search": search,
        "company_sections": company_sections,
    }


def generate_invoice_number(invoice_date: str, branch_id: int = 1) -> str:
    prefix = invoice_date.replace("-", "")
    existing_rows = fetch_all("SELECT invoice_number FROM invoices WHERE invoice_date = ? AND branch_id = ?", (invoice_date, branch_id))
    existing_numbers = {row["invoice_number"] for row in existing_rows}
    sequence = len(existing_numbers) + 1
    candidate = f"INV-{prefix}-{sequence:03d}"
    while candidate in existing_numbers:
        sequence += 1
        candidate = f"INV-{prefix}-{sequence:03d}"
    return candidate


def get_invoice_detail(invoice_id: int, branch_id: int = 1) -> dict:
    invoice = fetch_one("SELECT * FROM invoices WHERE id = ? AND branch_id = ?", (invoice_id, branch_id))
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found.")
    items = fetch_all(
        """
        SELECT ii.*, p.model, p.company, p.color, p.size, c.name AS category_name
        FROM invoice_items ii
        JOIN products p ON p.id = ii.product_id AND p.branch_id = ii.branch_id
        JOIN categories c ON c.id = p.category_id AND c.branch_id = ii.branch_id
        WHERE ii.invoice_id = ? AND ii.branch_id = ?
        ORDER BY ii.id ASC
        """,
        (invoice_id, branch_id),
    )
    for item in items:
        item["product_label"] = format_product_label(item)
    return {"invoice": invoice, "items": items}


def create_sale_transaction_record(payload: SaleTransactionCreate, current_user: dict | None = None, *, source: str = "sales_flow", branch_id: int = 1) -> dict:
    items = [item.model_dump() for item in payload.items]
    if not items:
        raise HTTPException(status_code=400, detail="At least one sale item is required.")

    signature = build_sale_signature(payload.customer_name, payload.transaction_at.isoformat(), items, branch_id=branch_id)
    duplicate = fetch_one("SELECT id, invoice_number FROM invoices WHERE sale_signature = ? AND branch_id = ?", (signature, branch_id))
    if duplicate and not payload.ignore_duplicate:
        raise HTTPException(status_code=409, detail=f"Possible duplicate sale detected. Matching invoice: {duplicate['invoice_number']}.")

    product_ids = [int(item["product_id"]) for item in items]
    product_map = {product_id: _product_exists(product_id, branch_id) for product_id in set(product_ids)}
    snapshot_map = {product_id: get_product_stock_snapshot(product_id) for product_id in set(product_ids)}
    requested_by_product: dict[int, float] = defaultdict(float)
    for item in items:
        requested_by_product[int(item["product_id"])] += float(item["quantity"])
    for product_id, requested_qty in requested_by_product.items():
        available = float(snapshot_map[product_id]["current_stock"] or 0)
        if requested_qty > available:
            raise HTTPException(status_code=400, detail=f"Only {int(available)} units available for {product_map[product_id]['model']}.")

    transaction_at = payload.transaction_at.replace(microsecond=0)
    invoice_date = transaction_at.date().isoformat()
    subtotal = round(sum(float(item["quantity"]) * float(item["unit_price"]) for item in items), 2)
    discount_amount = calculate_discount_amount(subtotal, payload.apply_discount, payload.discount_type, payload.discount_value)
    total_amount = round(max(subtotal - discount_amount, 0), 2)
    invoice_number = generate_invoice_number(invoice_date, branch_id=branch_id)
    current_time = now_iso()
    pdf_dir = DATA_DIR / "invoices"
    pdf_dir.mkdir(parents=True, exist_ok=True)

    distributed_items = []
    remaining_discount = discount_amount
    for index, item in enumerate(items):
        qty = int(item["quantity"])
        base_unit_price = round(float(item["unit_price"]), 2)
        base_total = round(qty * base_unit_price, 2)
        if index == len(items) - 1:
            item_discount = round(remaining_discount, 2)
        else:
            ratio = base_total / subtotal if subtotal else 0
            item_discount = round(discount_amount * ratio, 2)
            remaining_discount = round(remaining_discount - item_discount, 2)
        final_total = round(max(base_total - item_discount, 0), 2)
        final_unit_price = round(final_total / qty, 2) if qty else 0
        distributed_items.append({
            **item,
            "base_unit_price": base_unit_price,
            "discount_amount": item_discount,
            "unit_price": final_unit_price,
            "total_price": final_total,
        })

    with get_db_cursor(commit=True) as (_, cursor):
        cursor.execute(
            """
            INSERT INTO invoices (
                branch_id, invoice_number, customer_name, phone_number, address, status, subtotal, total_amount,
                invoice_date, transaction_at, sale_signature, pdf_path, notes, created_at, updated_at,
                discount_name, discount_type, discount_value, discount_amount
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                branch_id,
                invoice_number,
                payload.customer_name.strip(),
                payload.phone_number.strip(),
                payload.address.strip(),
                payload.status,
                subtotal,
                total_amount,
                invoice_date,
                transaction_at.isoformat(),
                signature,
                "",
                payload.notes.strip(),
                current_time,
                current_time,
                payload.discount_name.strip() if payload.apply_discount else "",
                payload.discount_type if payload.apply_discount else "fixed",
                float(payload.discount_value or 0) if payload.apply_discount else 0,
                discount_amount,
            ),
        )
        invoice_id = cursor.lastrowid
        for item in distributed_items:
            cursor.execute(
                """
                INSERT INTO sale_entries (
                    branch_id, product_id, invoice_id, quantity, unit_price, unit_cost_at_sale, total_profit,
                    sale_date, transaction_at, customer_name, customer_phone, reference_no, notes, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    branch_id,
                    item["product_id"],
                    invoice_id,
                    item["quantity"],
                    item["unit_price"],
                    invoice_date,
                    transaction_at.isoformat(),
                    payload.customer_name.strip(),
                    payload.phone_number.strip(),
                    invoice_number,
                    payload.notes.strip(),
                    current_time,
                    current_time,
                ),
            )
            sale_id = cursor.lastrowid
            cursor.execute(
                """
                INSERT INTO invoice_items (
                    branch_id, invoice_id, product_id, sale_entry_id, quantity, unit_price, total_price, created_at,
                    base_unit_price, discount_amount
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    branch_id,
                    invoice_id,
                    item["product_id"],
                    sale_id,
                    item["quantity"],
                    item["unit_price"],
                    item["total_price"],
                    current_time,
                    item["base_unit_price"],
                    item["discount_amount"],
                ),
            )
            cursor.execute(
                """
                INSERT INTO account_transactions (
                    branch_id, transaction_date, transaction_at, transaction_type, direction, amount, status, party_name, party_phone, description,
                    category_id, product_id, sale_id, invoice_id, created_at, updated_at
                ) VALUES (?, ?, ?, 'invoice_sale', 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    branch_id,
                    invoice_date,
                    transaction_at.isoformat(),
                    item["total_price"],
                    payload.status,
                    payload.customer_name.strip(),
                    payload.phone_number.strip(),
                    f"Invoice {invoice_number} generated",
                    product_map[item["product_id"]]["category_id"],
                    item["product_id"],
                    sale_id,
                    invoice_id,
                    current_time,
                    current_time,
                ),
            )

    for product_id in set(product_ids):
        recalculate_sale_costs(product_id)

    detail = get_invoice_detail(invoice_id, branch_id=branch_id)
    if payload.generate_pdf:
        pdf_path = pdf_dir / f"{invoice_number}.pdf"
        build_invoice_pdf(str(pdf_path), detail["invoice"], detail["items"])
        if not pdf_path.exists() or pdf_path.stat().st_size <= 0:
            raise HTTPException(status_code=500, detail="Invoice PDF could not be generated.")
        execute("UPDATE invoices SET pdf_path = ?, updated_at = ? WHERE id = ?", (str(pdf_path), now_iso(), invoice_id))
    if current_user:
        log_activity(current_user["username"], "invoice", "created", f"Invoice {invoice_number} generated for {payload.customer_name.strip()} via {source}.", invoice_id, branch_id=branch_id)
    return detail


# --- BRANCH MANAGEMENT API ---

@app.get("/api/branches")
def list_branches(current_user: Annotated[dict, Depends(require_ready_user)]):
    branches = fetch_all("SELECT * FROM branches ORDER BY id ASC")
    for b in branches:
        branch_id = b["id"]
        stats = fetch_one(
            """
            SELECT 
                (SELECT COUNT(*) FROM categories WHERE branch_id = ?) AS category_count,
                (SELECT COUNT(*) FROM products WHERE branch_id = ? AND active = 1) AS product_count,
                (SELECT COUNT(*) FROM invoices WHERE branch_id = ?) AS invoice_count
            """,
            (branch_id, branch_id, branch_id),
        ) or {"category_count": 0, "product_count": 0, "invoice_count": 0}
        b.update(stats)
    return branches


@app.get("/api/branches/{branch_id}")
def get_branch_detail(branch_id: int, current_user: Annotated[dict, Depends(require_ready_user)]):
    return _branch_exists(branch_id)


@app.post("/api/branches")
def create_branch(payload: BranchCreate, current_user: Annotated[dict, Depends(require_ready_user)]):
    name = payload.name.strip()
    key = normalize_key(name)
    if not name:
        raise HTTPException(status_code=400, detail="Branch name is required.")
    if fetch_one("SELECT id FROM branches WHERE name_key = ?", (key,)):
        raise HTTPException(status_code=400, detail="A branch with this name already exists.")

    now = now_iso()
    branch_id = execute(
        """
        INSERT INTO branches (name, name_key, address, description, image_path, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'Active', ?, ?)
        """,
        (name, key, payload.address.strip(), payload.description.strip(), payload.image_path.strip(), now, now),
    )

    seed_defaults(branch_id=branch_id)
    seed_catalog_models(branch_id=branch_id)

    log_activity(current_user["username"], "branch", "created", f"Branch '{name}' created.", branch_id, branch_id=branch_id)
    return _branch_exists(branch_id)


@app.put("/api/branches/{branch_id}")
def update_branch(branch_id: int, payload: BranchUpdate, current_user: Annotated[dict, Depends(require_ready_user)]):
    existing = _branch_exists(branch_id)
    name = payload.name.strip()
    key = normalize_key(name)
    if not name:
        raise HTTPException(status_code=400, detail="Branch name is required.")
    conflict = fetch_one("SELECT id FROM branches WHERE name_key = ? AND id != ?", (key, branch_id))
    if conflict:
        raise HTTPException(status_code=400, detail="Another branch already uses that name.")

    status_val = payload.status if payload.status in ("Active", "Closed") else existing["status"]
    execute(
        """
        UPDATE branches
        SET name = ?, name_key = ?, address = ?, description = ?, image_path = ?, status = ?, updated_at = ?
        WHERE id = ?
        """,
        (name, key, payload.address.strip(), payload.description.strip(), payload.image_path.strip(), status_val, now_iso(), branch_id),
    )
    log_activity(current_user["username"], "branch", "updated", f"Branch '{name}' updated (Status: {status_val}).", branch_id, branch_id=branch_id)
    return _branch_exists(branch_id)


@app.delete("/api/branches/{branch_id}")
def close_branch(branch_id: int, current_user: Annotated[dict, Depends(require_ready_user)]):
    branch = _branch_exists(branch_id)
    execute("UPDATE branches SET status = 'Closed', updated_at = ? WHERE id = ?", (now_iso(), branch_id))
    log_activity(current_user["username"], "branch", "closed", f"Branch '{branch['name']}' closed.", branch_id, branch_id=branch_id)
    return {"message": f"Branch '{branch['name']}' has been closed. Historical records remain preserved and read-only."}


# --- COMPANY MANAGEMENT API ---

@app.get("/api/companies")
def list_companies(
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
):
    companies = fetch_all("SELECT * FROM companies WHERE branch_id = ? ORDER BY name ASC", (branch_id,))
    known = get_known_companies(branch_id=branch_id)
    result = []
    seen = set()
    for c in companies:
        seen.add(normalize_key(c["name"]))
        result.append({
            "id": c["id"],
            "name": c["name"],
            "image_path": c.get("image_path") or "",
            "logo_slug": logo_slug_for_company(c["name"]),
        })
    for name in known:
        if normalize_key(name) not in seen:
            result.append({
                "id": None,
                "name": name,
                "image_path": "",
                "logo_slug": logo_slug_for_company(name),
            })
    return result


@app.post("/api/companies")
def create_company(
    payload: CompanyPayload,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    company_name = canonical_company_name(payload.name)
    key = normalize_key(company_name)
    if not company_name:
        raise HTTPException(status_code=400, detail="Company name is required.")
    if fetch_one("SELECT id FROM companies WHERE branch_id = ? AND name_key = ?", (branch_id, key)):
        raise HTTPException(status_code=400, detail="A company with this name already exists in this branch.")

    now = now_iso()
    company_id = execute(
        "INSERT INTO companies (branch_id, name, name_key, image_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (branch_id, company_name, key, payload.image_path.strip(), now, now),
    )
    log_activity(current_user["username"], "company", "created", f"Company '{company_name}' created.", company_id, branch_id=branch_id)
    return {"id": company_id, "name": company_name, "image_path": payload.image_path.strip(), "logo_slug": logo_slug_for_company(company_name)}


@app.put("/api/companies/{company_id}")
def update_company(
    company_id: int,
    payload: CompanyPayload,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    existing = fetch_one("SELECT * FROM companies WHERE id = ? AND branch_id = ?", (company_id, branch_id))
    if not existing:
        raise HTTPException(status_code=404, detail="Company not found.")
    company_name = canonical_company_name(payload.name)
    key = normalize_key(company_name)
    conflict = fetch_one("SELECT id FROM companies WHERE branch_id = ? AND name_key = ? AND id != ?", (branch_id, key, company_id))
    if conflict:
        raise HTTPException(status_code=400, detail="Another company in this branch already uses that name.")

    execute(
        "UPDATE companies SET name = ?, name_key = ?, image_path = ?, updated_at = ? WHERE id = ? AND branch_id = ?",
        (company_name, key, payload.image_path.strip(), now_iso(), company_id, branch_id),
    )
    log_activity(current_user["username"], "company", "updated", f"Company '{company_name}' updated.", company_id, branch_id=branch_id)
    return {"id": company_id, "name": company_name, "image_path": payload.image_path.strip(), "logo_slug": logo_slug_for_company(company_name)}


@app.delete("/api/companies/{company_id}")
def delete_company(
    company_id: int | str,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    comp_name = ""
    if str(company_id).isdigit():
        existing = fetch_one("SELECT * FROM companies WHERE id = ? AND branch_id = ?", (int(company_id), branch_id))
        if existing:
            comp_name = existing["name"]
    else:
        comp_name = str(company_id).strip()

    if not comp_name:
        raise HTTPException(status_code=404, detail="Company not found.")

    if comp_name.lower() in ['dawlance', 'haier']:
        raise HTTPException(status_code=403, detail=f"'{comp_name}' is a primary system brand and can never be deleted.")

    stock_count = fetch_one(
        """
        SELECT COUNT(*) AS count FROM products p
        WHERE p.branch_id = ? AND lower(p.company) = lower(?)
        AND (
            (SELECT COALESCE(SUM(quantity), 0) FROM purchase_entries WHERE product_id = p.id AND branch_id = p.branch_id) > 0
            OR (SELECT COALESCE(SUM(quantity), 0) FROM sale_entries WHERE product_id = p.id AND branch_id = p.branch_id) > 0
        )
        """,
        (branch_id, comp_name),
    ) or {"count": 0}

    if int(stock_count.get("count") or 0) > 0:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot delete '{comp_name}' because active stock or transactions are linked to it. Clear inventory first.",
        )

    execute("DELETE FROM products WHERE branch_id = ? AND lower(company) = lower(?)", (branch_id, comp_name))
    execute("DELETE FROM catalog_models WHERE branch_id = ? AND lower(company) = lower(?)", (branch_id, comp_name))
    execute("DELETE FROM companies WHERE branch_id = ? AND lower(name) = lower(?)", (branch_id, comp_name))

    log_activity(current_user["username"], "company", "deleted", f"Company '{comp_name}' and all its catalog models deleted.", branch_id=branch_id)
    return {"message": f"Company '{comp_name}' and all associated records deleted successfully."}


@app.get("/api/meta")
def app_meta(
    request: Request,
    current_user: Annotated[dict, Depends(get_current_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
):
    branches = fetch_all("SELECT id, name, status, address FROM branches ORDER BY id ASC")
    current_branch = fetch_one("SELECT * FROM branches WHERE id = ?", (branch_id,)) or (branches[0] if branches else None)
    return {
        "shop_name": "Malik Electronic",
        "current_branch": current_branch,
        "branches": branches,
        "brands": get_known_companies(branch_id=branch_id),
        "top_companies": get_known_companies(branch_id=branch_id),
        "company_options": get_known_companies(branch_id=branch_id),
        "logo_hints": LOGO_HINTS,
        "colors": COMMON_COLORS,
        "category_icons": CATEGORY_ICON_OPTIONS,
        "default_username": DEFAULT_USERNAME,
        "default_password_hint": "Use your current password. Reset only if needed.",
        "app_version": APP_VERSION,
        "can_view_prices": price_access_granted(request),
        "runtime_mode": RUNTIME_MODE,
    }


@app.get("/api/app-state")
def app_state(
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
):
    current_branch = fetch_one("SELECT * FROM branches WHERE id = ?", (branch_id,))
    branches = fetch_all("SELECT id, name, status FROM branches ORDER BY id ASC")
    return {
        "app_version": APP_VERSION,
        "current_branch": current_branch,
        "branches": branches,
        "can_view_prices": price_access_granted(request),
        "price_unlock_minutes": PRICE_UNLOCK_MINUTES,
        "runtime_mode": RUNTIME_MODE,
    }


# --- AUTH & CREDENTIALS ---

@app.post("/api/auth/login")
def login(payload: LoginRequest, response: Response):
    user = get_user_by_username(payload.username)
    if not user or not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    token = create_access_token(user["username_key"])
    response.delete_cookie("malik_accounts_access", path="/")
    branches = fetch_all("SELECT id, name, status, address, image_path FROM branches ORDER BY id ASC")
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {"username": user["username"], "must_change_password": bool(user["must_change_password"])},
        "branches": branches,
    }


@app.get("/api/auth/me")
def auth_me(current_user: Annotated[dict, Depends(get_current_user)]):
    return current_user


@app.post("/api/auth/verify-password")
def verify_current_password(payload: PasswordVerifyRequest, current_user: Annotated[dict, Depends(require_ready_user)]):
    db_user = get_user_by_username(current_user["username"])
    if not db_user or not verify_password(payload.password, db_user["password_hash"]):
        raise HTTPException(status_code=400, detail="Password is incorrect.")
    return {"message": "Password verified."}


@app.get("/api/auth/price-visibility")
def get_price_visibility(request: Request, current_user: Annotated[dict, Depends(require_ready_user)]):
    return {"can_view_prices": price_access_granted(request), "app_version": APP_VERSION, "unlock_minutes": PRICE_UNLOCK_MINUTES}


@app.post("/api/prices/unlock")
@app.post("/api/auth/price-visibility")
@app.post("/api/auth/price-visibility/unlock")
def unlock_price_visibility(payload: PasswordVerifyRequest, request: Request, response: Response, current_user: Annotated[dict, Depends(require_ready_user)]):
    db_user = get_user_by_username(current_user["username"])
    entered = (payload.password or "").strip()
    is_valid = is_valid_verification_secret(entered) or (
        db_user is not None and verify_password(entered, db_user["password_hash"])
    )
    if not is_valid:
        raise HTTPException(status_code=400, detail="Verification password is incorrect.")
    token = create_price_access_token(current_user["username"])
    response.set_cookie(PRICE_COOKIE_NAME, token, httponly=True, samesite="lax", secure=False, max_age=PRICE_UNLOCK_MINUTES * 60, path="/")
    return {"message": "Price visibility unlocked.", "can_view_prices": True, "app_version": APP_VERSION}


@app.post("/api/prices/lock")
@app.delete("/api/auth/price-visibility")
@app.post("/api/auth/price-visibility/lock")
def lock_price_visibility(response: Response, current_user: Annotated[dict, Depends(require_ready_user)]):
    response.delete_cookie(PRICE_COOKIE_NAME, path="/")
    return {"message": "Price protection enabled. Prices locked.", "can_view_prices": False, "app_version": APP_VERSION}


class CredentialUpdateWithKey(BaseModel):
    current_username: str
    current_password: str
    new_username: str = ""
    new_password: str = ""
    confirm_password: str = ""
    security_key: str


@app.post("/api/auth/update-credentials")
def update_credentials(payload: CredentialUpdateWithKey):
    if not is_valid_verification_secret(payload.security_key):
        raise HTTPException(status_code=403, detail="Invalid Verification Password. Password change rejected.")

    current_username = normalize_username(payload.current_username)
    user = get_user_by_username(current_username)
    if not user or not verify_password(payload.current_password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="Current username or last used password is incorrect.")

    requested_username = normalize_username(payload.new_username) if (payload.new_username or "").strip() else user["username"]
    requested_password = payload.new_password or ""
    effective_password = requested_password or payload.current_password

    if requested_password and len(requested_password) < 6:
        raise HTTPException(status_code=400, detail="New password must be at least 6 characters long.")
    if requested_password and payload.confirm_password != requested_password:
        raise HTTPException(status_code=400, detail="New password and confirm password must match.")
    if not requested_username:
        raise HTTPException(status_code=400, detail="New username cannot be empty.")
    if normalize_key(requested_username) == user["username_key"] and effective_password == payload.current_password:
        raise HTTPException(status_code=400, detail="Please change the username, password, or both before saving.")

    conflict = fetch_one("SELECT id FROM users WHERE username_key = ? AND id != ?", (normalize_key(requested_username), user["id"]))
    if conflict:
        raise HTTPException(status_code=400, detail="That username is already in use.")

    execute(
        "UPDATE users SET username = ?, username_key = ?, password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?",
        (requested_username, normalize_key(requested_username), hash_password(effective_password), now_iso(), user["id"]),
    )
    log_activity(user["username"], "user", "credentials_updated", f"Login credentials updated to username '{requested_username}'.", user["id"])
    token = create_access_token(normalize_key(requested_username))
    return {"message": "Credentials updated.", "access_token": token, "user": {"username": requested_username, "must_change_password": False}}


# --- FILE UPLOADS ---

def _handle_upload(file: UploadFile, directory: Path, prefix: str) -> dict:
    allowed = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".jfif", ".svg"}
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in allowed:
        raise HTTPException(status_code=400, detail="Image type not allowed.")
    file_name = f"{prefix}-{uuid4().hex}{suffix}"
    target = directory / file_name
    content = file.file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    target.write_bytes(content)
    rel_path = f"/media/{directory.name}/{file_name}" if directory != MEDIA_DIR else f"/media/{file_name}"
    return {"path": rel_path, "filename": file_name}


@app.post("/api/uploads/product-image")
def upload_product_image(file: UploadFile = File(...), current_user: Annotated[dict, Depends(require_ready_user)] = None):
    res = _handle_upload(file, MEDIA_DIR, "product")
    if current_user:
        log_activity(current_user["username"], "product_image", "uploaded", f"Product image uploaded as {res['filename']}.")
    return res


@app.post("/api/uploads/category-image")
def upload_category_image(file: UploadFile = File(...), current_user: Annotated[dict, Depends(require_ready_user)] = None):
    res = _handle_upload(file, CATEGORY_MEDIA_DIR, "category")
    if current_user:
        log_activity(current_user["username"], "category_image", "uploaded", f"Category image uploaded as {res['filename']}.")
    return res


@app.post("/api/uploads/company-image")
def upload_company_image(file: UploadFile = File(...), current_user: Annotated[dict, Depends(require_ready_user)] = None):
    res = _handle_upload(file, COMPANY_MEDIA_DIR, "company")
    if current_user:
        log_activity(current_user["username"], "company_image", "uploaded", f"Company logo uploaded as {res['filename']}.")
    return res


@app.post("/api/uploads/branch-image")
def upload_branch_image(file: UploadFile = File(...), current_user: Annotated[dict, Depends(require_ready_user)] = None):
    res = _handle_upload(file, BRANCH_MEDIA_DIR, "branch")
    if current_user:
        log_activity(current_user["username"], "branch_image", "uploaded", f"Branch image uploaded as {res['filename']}.")
    return res


# --- CATALOG MODELS (Master Models) ---

@app.get("/api/catalog/filters")
def catalog_filters(
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
):
    return {
        "companies": [row["company"] for row in fetch_all("SELECT DISTINCT company FROM catalog_models WHERE branch_id = ? ORDER BY company ASC", (branch_id,))],
        "categories": [row["category_name"] for row in fetch_all("SELECT DISTINCT category_name FROM catalog_models WHERE branch_id = ? ORDER BY category_name ASC", (branch_id,))],
        "series": [row["series"] for row in fetch_all("SELECT DISTINCT series FROM catalog_models WHERE branch_id = ? AND series != '' ORDER BY series ASC", (branch_id,))],
    }


@app.get("/api/catalog/models")
def catalog_models(
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
    company: str | None = Query(default=None),
    category: str | None = Query(default=None),
    series: str | None = Query(default=None),
    search: str = Query(default=""),
):
    conditions = ["branch_id = ?"]
    params: list = [branch_id]
    if company:
        conditions.append("company_key = ?")
        params.append(normalize_key(company))
    if category:
        conditions.append("category_key = ?")
        params.append(normalize_key(category))
    if series:
        conditions.append("series_key = ?")
        params.append(normalize_key(series))
    if search.strip():
        term = f"%{search.strip()}%"
        conditions.append("(model LIKE ? OR series LIKE ? OR category_name LIKE ? OR company LIKE ?)")
        params.extend([term, term, term, term])
    return fetch_all(
        f"SELECT * FROM catalog_models WHERE {' AND '.join(conditions)} ORDER BY company ASC, category_name ASC, series ASC, model ASC",
        tuple(params),
    )


class CatalogModelDelete(BaseModel):
    company: str
    category_name: str
    series: str
    model: str


@app.post("/api/catalog/models/delete-by-key")
def delete_catalog_model_by_key(
    payload: CatalogModelDelete,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    linked = fetch_one(
        "SELECT COUNT(*) AS count FROM products WHERE branch_id = ? AND lower(company) = lower(?) AND lower(series) = lower(?) AND lower(model) = lower(?)",
        (branch_id, payload.company, payload.series, payload.model)
    )
    if int(linked.get("count", 0)) > 0:
        raise HTTPException(status_code=400, detail="Cannot delete this model because it has linked stock variants. Delete the stock first.")
    
    execute(
        "DELETE FROM catalog_models WHERE branch_id = ? AND lower(company) = lower(?) AND lower(category_name) = lower(?) AND lower(series) = lower(?) AND lower(model) = lower(?)",
        (branch_id, payload.company, payload.category_name, payload.series, payload.model)
    )
    log_activity(current_user["username"], "catalog_model", "deleted", f"Master model '{payload.model}' deleted.", branch_id=branch_id)
    return {"message": "Model deleted successfully."}


@app.post("/api/catalog/models")
def create_catalog_model(
    payload: CatalogModelCreate,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    company_name = canonical_company_name(payload.company)
    category_row = fetch_one("SELECT id, name FROM categories WHERE branch_id = ? AND name_key = ?", (branch_id, normalize_key(payload.category_name)))
    if not category_row:
        raise HTTPException(status_code=404, detail="Create the category in this branch first, then add a master model.")
    conflict = fetch_one(
        "SELECT id FROM catalog_models WHERE branch_id = ? AND company_key = ? AND category_key = ? AND series_key = ? AND model_key = ?",
        (branch_id, normalize_key(company_name), normalize_key(category_row["name"]), normalize_key(payload.series), normalize_key(payload.model)),
    )
    if conflict:
        raise HTTPException(status_code=400, detail="That master model already exists for this company and category in this branch.")
    model_id = execute(
        """
        INSERT INTO catalog_models (
            branch_id, company, company_key, category_name, category_key, series, series_key, model, model_key,
            default_price, source_document, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)
        """,
        (
            branch_id,
            company_name,
            normalize_key(company_name),
            category_row["name"],
            normalize_key(category_row["name"]),
            payload.series.strip(),
            normalize_key(payload.series),
            payload.model.strip(),
            normalize_key(payload.model),
            float(payload.default_price or 0),
            now_iso(),
            now_iso(),
        ),
    )
    log_activity(current_user["username"], "catalog_model", "created", f"Master model '{payload.model.strip()}' added for {company_name} / {category_row['name']}.", model_id, branch_id=branch_id)
    return fetch_one("SELECT * FROM catalog_models WHERE id = ?", (model_id,))


# --- CATEGORIES ---

@app.get("/api/categories")
def list_categories(
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
):
    return secure_payload(request, get_category_rows(branch_id=branch_id))


@app.post("/api/categories")
def create_category(
    payload: CategoryCreate,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    key = normalize_key(payload.name)
    if fetch_one("SELECT id FROM categories WHERE branch_id = ? AND name_key = ?", (branch_id, key)):
        raise HTTPException(status_code=400, detail="Category already exists in this branch.")
    category_id = execute(
        "INSERT INTO categories (branch_id, name, name_key, icon, description, image_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (branch_id, payload.name.strip(), key, payload.icon.strip() or "📦", payload.description.strip(), payload.image_path.strip(), now_iso(), now_iso()),
    )
    log_activity(current_user["username"], "category", "created", f"Category '{payload.name.strip()}' created.", category_id, branch_id=branch_id)
    return _category_exists(category_id, branch_id=branch_id)


@app.put("/api/categories/{category_id}")
def update_category(
    category_id: int,
    payload: CategoryUpdate,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    existing = _category_exists(category_id, branch_id=branch_id)
    key = normalize_key(payload.name)
    conflict = fetch_one("SELECT id FROM categories WHERE branch_id = ? AND name_key = ? AND id != ?", (branch_id, key, category_id))
    if conflict:
        raise HTTPException(status_code=400, detail="Another category in this branch already uses that name.")
    execute(
        "UPDATE categories SET name = ?, name_key = ?, icon = ?, description = ?, image_path = ?, updated_at = ? WHERE id = ? AND branch_id = ?",
        (payload.name.strip(), key, payload.icon.strip() or existing["icon"], payload.description.strip(), payload.image_path.strip(), now_iso(), category_id, branch_id),
    )
    log_activity(current_user["username"], "category", "updated", f"Category '{payload.name.strip()}' updated.", category_id, branch_id=branch_id)
    return _category_exists(category_id, branch_id=branch_id)


@app.delete("/api/categories/{category_id}")
def delete_category(
    category_id: int,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
    force: bool = Query(default=False),
):
    category = _category_exists(category_id, branch_id=branch_id)
    linked_rows = fetch_all("SELECT id FROM products WHERE branch_id = ? AND category_id = ?", (branch_id, category_id))
    if linked_rows and not force:
        raise HTTPException(status_code=400, detail=f"This category has {len(linked_rows)} linked model record(s). Delete them first or use force delete.")
    for row in linked_rows:
        permanently_delete_product(int(row["id"]))
    execute("DELETE FROM categories WHERE id = ? AND branch_id = ?", (category_id, branch_id))
    log_activity(current_user["username"], "category", "deleted", f"Category '{category['name']}' deleted.", category_id, branch_id=branch_id)
    return {"message": "Category deleted."}


# --- LOCATIONS ---

@app.get("/api/locations")
def list_locations(
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
):
    return fetch_all(
        """
        SELECT l.*,
               COUNT(p.id) AS linked_variants,
               ROUND(COALESCE(SUM((SELECT COALESCE(SUM(pe.quantity),0) FROM purchase_entries pe WHERE pe.product_id = p.id AND pe.branch_id = l.branch_id) - (SELECT COALESCE(SUM(se.quantity),0) FROM sale_entries se WHERE se.product_id = p.id AND se.branch_id = l.branch_id)), 0), 2) AS current_units
        FROM locations l
        LEFT JOIN products p ON p.location_id = l.id AND p.branch_id = l.branch_id AND p.active = 1
        WHERE l.branch_id = ?
        GROUP BY l.id
        ORDER BY l.name ASC
        """,
        (branch_id,),
    )


@app.post("/api/locations")
def create_location(
    payload: LocationCreate,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    key = normalize_key(payload.name)
    if fetch_one("SELECT id FROM locations WHERE branch_id = ? AND name_key = ?", (branch_id, key)):
        raise HTTPException(status_code=400, detail="Location already exists in this branch.")
    location_id = execute(
        "INSERT INTO locations (branch_id, name, name_key, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (branch_id, payload.name.strip(), key, payload.description.strip(), now_iso(), now_iso()),
    )
    log_activity(current_user["username"], "location", "created", f"Location '{payload.name.strip()}' created.", location_id, branch_id=branch_id)
    return _location_exists(location_id, branch_id=branch_id)


@app.put("/api/locations/{location_id}")
def update_location(
    location_id: int,
    payload: LocationUpdate,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    _location_exists(location_id, branch_id=branch_id)
    key = normalize_key(payload.name)
    conflict = fetch_one("SELECT id FROM locations WHERE branch_id = ? AND name_key = ? AND id != ?", (branch_id, key, location_id))
    if conflict:
        raise HTTPException(status_code=400, detail="Another location in this branch already uses that name.")
    execute(
        "UPDATE locations SET name = ?, name_key = ?, description = ?, updated_at = ? WHERE id = ? AND branch_id = ?",
        (payload.name.strip(), key, payload.description.strip(), now_iso(), location_id, branch_id),
    )
    log_activity(current_user["username"], "location", "updated", f"Location '{payload.name.strip()}' updated.", location_id, branch_id=branch_id)
    return _location_exists(location_id, branch_id=branch_id)


@app.delete("/api/locations/{location_id}")
def delete_location(
    location_id: int,
    force: bool = Query(default=False),
    current_user: Annotated[dict, Depends(require_ready_user)] = None,
    branch_id: Annotated[int, Depends(require_active_branch)] = 1,
):
    location = _location_exists(location_id, branch_id=branch_id)
    linked = fetch_one("SELECT COUNT(*) AS total FROM products WHERE branch_id = ? AND location_id = ?", (branch_id, location_id)) or {"total": 0}
    if int(linked.get("total") or 0) > 0 and not force:
        raise HTTPException(status_code=400, detail=f"{location['name']} has {linked['total']} linked product(s). Pass force=true to unassign them.")
    if int(linked.get("total") or 0) > 0:
        execute("UPDATE products SET location_id = NULL, updated_at = ? WHERE branch_id = ? AND location_id = ?", (now_iso(), branch_id, location_id))
    execute("DELETE FROM locations WHERE id = ? AND branch_id = ?", (location_id, branch_id))
    if current_user:
        log_activity(current_user["username"], "location", "deleted", f"Location '{location['name']}' deleted.", location_id, branch_id=branch_id)
    return {"message": f"Location {location['name']} deleted."}


# --- PRODUCTS (Stock Variants) ---

@app.get("/api/products")
def list_products(
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
    category_id: int | None = Query(default=None),
    company: str | None = Query(default=None),
    series: str | None = Query(default=None),
    color: str | None = Query(default=None),
    location_id: int | None = Query(default=None),
    search: str = Query(default=""),
):
    return secure_payload(
        request,
        get_products_data(
            branch_id=branch_id,
            category_id=category_id,
            company=company,
            series=series,
            color=color,
            location_id=location_id,
            search=search,
        ),
    )


@app.get("/api/products/{product_id}")
def product_detail(
    product_id: int,
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
):
    product = _product_exists(product_id, branch_id=branch_id)
    product.update(get_product_stock_snapshot(product_id))
    product["product_label"] = format_product_label(product)
    purchases = get_purchase_rows(branch_id=branch_id, product_id=product_id)
    sales = get_sales_rows(branch_id=branch_id, product_id=product_id)
    return secure_payload(request, {"product": product, "purchases": purchases, "sales": sales})


@app.post("/api/products")
def create_product(
    payload: ProductCreate,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    _category_exists(payload.category_id, branch_id=branch_id)
    _location_exists(payload.location_id, branch_id=branch_id)
    where_clause, params = product_duplicate_clause(payload, branch_id=branch_id)
    duplicate = fetch_one(f"SELECT id FROM products WHERE {where_clause}", params)
    if duplicate:
        raise HTTPException(status_code=400, detail="This exact model variant already exists in this branch. Edit it instead.")
    product_id = execute(
        """
        INSERT INTO products (
            branch_id, category_id, location_id, series, model, company, color, size, image_path, min_stock,
            default_purchase_price, default_sale_price, notes, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        """,
        (
            branch_id,
            payload.category_id,
            payload.location_id,
            payload.series.strip(),
            payload.model.strip(),
            canonical_company_name(payload.company),
            payload.color.strip(),
            payload.size.strip(),
            payload.image_path.strip(),
            payload.min_stock,
            payload.default_purchase_price,
            payload.default_sale_price,
            payload.notes.strip(),
            now_iso(),
            now_iso(),
        ),
    )
    if int(payload.opening_quantity or 0) > 0:
        create_opening_purchase_entry(product_id, int(payload.opening_quantity or 0), float(payload.default_purchase_price or 0), current_user["username"], branch_id=branch_id)
    log_activity(current_user["username"], "product", "created", f"Product '{payload.model.strip()}' created.", product_id, branch_id=branch_id)
    return _product_exists(product_id, branch_id=branch_id)


@app.post("/api/products/bulk")
def create_product_batch(
    payload: ProductBatchCreate,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    _category_exists(payload.category_id, branch_id=branch_id)
    _location_exists(payload.location_id, branch_id=branch_id)
    colors = parse_multi_values(payload.colors, fallback="")
    sizes = parse_multi_values(payload.sizes, fallback="")
    created = []
    skipped = []
    for color in colors:
        for size in sizes:
            single = ProductCreate(
                category_id=payload.category_id,
                location_id=payload.location_id,
                model=payload.model,
                series=payload.series,
                company=payload.company,
                color=color,
                size=size,
                image_path=payload.image_path,
                min_stock=payload.min_stock,
                default_purchase_price=payload.default_purchase_price,
                default_sale_price=payload.default_sale_price,
                opening_quantity=payload.opening_quantity,
                notes=payload.notes,
            )
            where_clause, params = product_duplicate_clause(single, branch_id=branch_id)
            if fetch_one(f"SELECT id FROM products WHERE {where_clause}", params):
                skipped.append({"color": color, "size": size})
                continue
            created.append(create_product(single, current_user, branch_id))
    return {"created": created, "skipped": skipped, "count": len(created)}


@app.put("/api/products/{product_id}")
def update_product(
    product_id: int,
    payload: ProductUpdate,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    _product_exists(product_id, branch_id=branch_id)
    _category_exists(payload.category_id, branch_id=branch_id)
    _location_exists(payload.location_id, branch_id=branch_id)
    where_clause, params = product_duplicate_clause(payload, branch_id=branch_id)
    conflict = fetch_one(f"SELECT id FROM products WHERE {where_clause} AND id != ?", params + (product_id,))
    if conflict:
        raise HTTPException(status_code=400, detail="Another variant in this branch already uses this combination.")
    execute(
        """
        UPDATE products
        SET category_id = ?, location_id = ?, series = ?, model = ?, company = ?, color = ?, size = ?, image_path = ?,
            min_stock = ?, default_purchase_price = ?, default_sale_price = ?, notes = ?, active = ?, updated_at = ?
        WHERE id = ? AND branch_id = ?
        """,
        (
            payload.category_id,
            payload.location_id,
            payload.series.strip(),
            payload.model.strip(),
            canonical_company_name(payload.company),
            payload.color.strip(),
            payload.size.strip(),
            payload.image_path.strip(),
            payload.min_stock,
            payload.default_purchase_price,
            payload.default_sale_price,
            payload.notes.strip(),
            payload.active,
            now_iso(),
            product_id,
            branch_id,
        ),
    )
    if int(payload.added_quantity or 0) > 0:
        create_opening_purchase_entry(product_id, int(payload.added_quantity or 0), float(payload.default_purchase_price or 0), current_user["username"], note="Additional stock", branch_id=branch_id)
        recalculate_sale_costs(product_id)
    log_activity(current_user["username"], "product", "updated", f"Product #{product_id} updated (Added: {payload.added_quantity or 0} units).", product_id, branch_id=branch_id)
    return _product_exists(product_id, branch_id=branch_id)


@app.delete("/api/products/{product_id}")
def delete_product(
    product_id: int,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    product = _product_exists(product_id, branch_id=branch_id)
    permanently_delete_product(product_id)
    log_activity(current_user["username"], "product", "deleted", f"Product #{product_id} permanently deleted.", product_id, branch_id=branch_id)
    return {"message": f"{format_product_label(product)} deleted.", "archived": False}


# --- PURCHASES (Stock In) ---

class PurchaseItemInput(BaseModel):
    product_id: int | None = None
    company: str = ""
    category_id: int | None = None
    series: str = ""
    model: str = ""
    color: str = ""
    size: str = ""
    quantity: int
    unit_cost: float


class PurchasePayload(BaseModel):
    purchase_date: str = ""
    supplier_name: str = ""
    supplier_phone: str = ""
    reference_no: str = ""
    notes: str = ""
    items: list[PurchaseItemInput] = []
    product_id: int | None = None
    company: str = ""
    category_id: int | None = None
    series: str = ""
    model: str = ""
    color: str = ""
    size: str = ""
    quantity: int | None = None
    unit_cost: float | None = None


class PurchaseItemEditInput(BaseModel):
    id: int | None = None
    product_id: int | None = None
    company: str = ""
    category_id: int | None = None
    series: str = ""
    model: str = ""
    color: str = ""
    quantity: int
    unit_cost: float


class PurchaseUpdatePayload(BaseModel):
    purchase_date: str = ""
    supplier_name: str = ""
    supplier_phone: str = ""
    reference_no: str = ""
    notes: str = ""
    items: list[PurchaseItemEditInput] = []
    quantity: int | None = None
    unit_cost: float | None = None
    color: str = ""


class PurchaseDeleteRequest(BaseModel):
    security_code: str = ""


@app.get("/api/purchases")
def list_purchases(
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
    product_id: int | None = Query(default=None),
    category_id: int | None = Query(default=None),
    company: str | None = Query(default=None),
    supplier: str | None = Query(default=None),
    search: str = Query(default=""),
    stock_status: str = Query(default="all"),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
):
    return secure_payload(
        request,
        get_purchase_rows(
            branch_id=branch_id,
            product_id=product_id,
            category_id=category_id,
            company=company,
            supplier=supplier,
            search=search,
            stock_status=stock_status,
            start_date=start_date,
            end_date=end_date,
        ),
    )


@app.get("/api/purchases/{purchase_id}")
def get_purchase_detail(
    purchase_id: int,
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
):
    primary = fetch_one(
        """
        SELECT pe.*, p.series, p.model, p.company, p.color, p.size, c.id AS category_id, c.name AS category_name, b.name AS branch_name, b.address AS branch_address
        FROM purchase_entries pe
        JOIN products p ON p.id = pe.product_id AND p.branch_id = pe.branch_id
        JOIN categories c ON c.id = p.category_id AND c.branch_id = pe.branch_id
        JOIN branches b ON b.id = pe.branch_id
        WHERE pe.id = ? AND pe.branch_id = ?
        """,
        (purchase_id, branch_id),
    )
    if not primary:
        raise HTTPException(status_code=404, detail="Purchase record not found.")

    ref_no = primary.get("reference_no") or f"PUR-{primary['id']}"
    all_entries = fetch_all(
        """
        SELECT pe.*, p.series, p.model, p.company, p.color, p.size, c.id AS category_id, c.name AS category_name
        FROM purchase_entries pe
        JOIN products p ON p.id = pe.product_id AND p.branch_id = pe.branch_id
        JOIN categories c ON c.id = p.category_id AND c.branch_id = pe.branch_id
        WHERE pe.branch_id = ? AND pe.reference_no = ?
        ORDER BY pe.id ASC
        """,
        (branch_id, ref_no),
    )
    if not all_entries:
        all_entries = [primary]

    invoice_items = []
    total_invoice_amount = 0.0
    total_invoice_qty = 0

    for item in all_entries:
        qty = int(item["quantity"] or 0)
        cost = float(item["unit_cost"] or 0)
        line_tot = round(qty * cost, 2)
        total_invoice_amount += line_tot
        total_invoice_qty += qty
        snapshot = get_product_stock_snapshot(item["product_id"])
        invoice_items.append({
            "id": item["id"],
            "product_id": item["product_id"],
            "company": item["company"],
            "category_id": item["category_id"],
            "category_name": item["category_name"],
            "series": item["series"] or "",
            "model": item["model"],
            "color": item["color"] or "Standard",
            "quantity": qty,
            "unit_cost": cost,
            "total_amount": line_tot,
            "current_stock": snapshot.get("current_stock", 0),
        })

    primary["items"] = invoice_items
    primary["item_count"] = len(invoice_items)
    primary["total_amount"] = round(total_invoice_amount, 2)
    primary["total_quantity"] = total_invoice_qty
    primary["product_label"] = format_product_label(primary)
    return secure_payload(request, primary)


def _resolve_or_create_product_variant(
    *,
    branch_id: int,
    product_id: int | None,
    company: str,
    category_id: int | None,
    series: str,
    model: str,
    color: str,
    unit_cost: float,
) -> int:
    if product_id:
        existing = fetch_one("SELECT id FROM products WHERE id = ? AND branch_id = ? AND active = 1", (product_id, branch_id))
        if existing:
            return existing["id"]
    if not category_id or not model.strip():
        raise HTTPException(status_code=400, detail="Category and Model name are required for every purchase item.")

    comp_name = canonical_company_name(company or "Dawlance")
    cat = _category_exists(category_id, branch_id=branch_id)
    s_name = series.strip()
    m_name = model.strip()
    col_name = color.strip() or "Standard"

    existing_variant = fetch_one(
        """
        SELECT id FROM products
        WHERE branch_id = ? AND category_id = ? AND lower(company) = lower(?) AND lower(series) = lower(?) AND lower(model) = lower(?) AND lower(color) = lower(?) AND active = 1
        """,
        (branch_id, category_id, comp_name, s_name, m_name, col_name),
    )
    if existing_variant:
        return existing_variant["id"]

    new_pid = execute(
        """
        INSERT INTO products (
            branch_id, category_id, location_id, series, model, company, color, size, image_path, min_stock,
            default_purchase_price, default_sale_price, notes, active, created_at, updated_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, '', '', 2, ?, 0, '', 1, ?, ?)
        """,
        (branch_id, category_id, s_name, m_name, comp_name, col_name, float(unit_cost or 0), now_iso(), now_iso()),
    )
    catalog_match = fetch_one(
        "SELECT id FROM catalog_models WHERE branch_id = ? AND company_key = ? AND category_key = ? AND model_key = ?",
        (branch_id, normalize_key(comp_name), normalize_key(cat["name"]), normalize_key(m_name)),
    )
    if not catalog_match:
        execute(
            """
            INSERT INTO catalog_models (branch_id, company, company_key, category_name, category_key, series, series_key, model, model_key, default_price, source_document, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'purchase_flow', ?, ?)
            """,
            (branch_id, comp_name, normalize_key(comp_name), cat["name"], normalize_key(cat["name"]), s_name, normalize_key(s_name), m_name, normalize_key(m_name), float(unit_cost or 0), now_iso(), now_iso()),
        )
    return new_pid


@app.post("/api/purchases")
def create_purchase(
    payload: PurchasePayload,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    items_to_save = payload.items
    if not items_to_save:
        if (payload.quantity or 0) > 0:
            items_to_save = [
                PurchaseItemInput(
                    product_id=payload.product_id,
                    company=payload.company,
                    category_id=payload.category_id,
                    series=payload.series,
                    model=payload.model,
                    color=payload.color,
                    size=payload.size,
                    quantity=payload.quantity or 1,
                    unit_cost=payload.unit_cost or 0.0,
                )
            ]
        else:
            raise HTTPException(status_code=400, detail="At least one purchase item is required.")

    purchase_date_str = payload.purchase_date.strip() or datetime.utcnow().date().isoformat()
    ref_no = payload.reference_no.strip() or generate_purchase_number(purchase_date_str, branch_id=branch_id)
    now_str = now_iso()
    affected_pids = set()

    with get_db_cursor(commit=True) as (_, cursor):
        for item in items_to_save:
            if item.quantity <= 0:
                raise HTTPException(status_code=400, detail="Item quantity must be at least 1.")
            if item.unit_cost < 0:
                raise HTTPException(status_code=400, detail="Item unit cost cannot be negative.")

            target_pid = _resolve_or_create_product_variant(
                branch_id=branch_id,
                product_id=item.product_id,
                company=item.company,
                category_id=item.category_id,
                series=item.series,
                model=item.model,
                color=item.color,
                unit_cost=item.unit_cost,
            )
            affected_pids.add(target_pid)
            prod = _product_exists(target_pid, branch_id=branch_id)

            cursor.execute(
                """
                INSERT INTO purchase_entries (
                    branch_id, product_id, quantity, unit_cost, purchase_date, supplier_name, supplier_phone,
                    reference_no, notes, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    branch_id,
                    target_pid,
                    int(item.quantity),
                    float(item.unit_cost),
                    purchase_date_str,
                    payload.supplier_name.strip(),
                    payload.supplier_phone.strip(),
                    ref_no,
                    payload.notes.strip(),
                    now_str,
                    now_str,
                ),
            )
            purchase_id = cursor.lastrowid
            cursor.execute(
                """
                INSERT INTO account_transactions (
                    branch_id, transaction_date, transaction_at, transaction_type, direction, amount, status, party_name, party_phone, description,
                    category_id, product_id, purchase_id, created_at, updated_at
                ) VALUES (?, ?, ?, 'purchase', 'out', ?, 'Recorded', ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    branch_id,
                    purchase_date_str,
                    now_str,
                    round(int(item.quantity) * float(item.unit_cost), 2),
                    payload.supplier_name.strip(),
                    payload.supplier_phone.strip(),
                    f"Purchase recorded for {prod['model']} ({ref_no})",
                    prod["category_id"],
                    target_pid,
                    purchase_id,
                    now_str,
                    now_str,
                ),
            )
            if float(prod.get("default_purchase_price") or 0) <= 0:
                cursor.execute("UPDATE products SET default_purchase_price = ?, updated_at = ? WHERE id = ?", (float(item.unit_cost), now_str, target_pid))

    for pid in affected_pids:
        recalculate_sale_costs(pid)

    log_activity(current_user["username"], "purchase", "created", f"Purchase invoice {ref_no} ({len(items_to_save)} item(s)) recorded.", branch_id=branch_id)
    return {"message": f"Purchase invoice {ref_no} recorded with {len(items_to_save)} item(s).", "reference_no": ref_no}


@app.put("/api/purchases/{purchase_id}")
def update_purchase(
    purchase_id: int,
    payload: PurchaseUpdatePayload,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    primary = fetch_one("SELECT * FROM purchase_entries WHERE id = ? AND branch_id = ?", (purchase_id, branch_id))
    if not primary:
        raise HTTPException(status_code=404, detail="Purchase record not found.")

    ref_no = primary.get("reference_no") or f"PUR-{primary['id']}"
    existing_items = fetch_all("SELECT * FROM purchase_entries WHERE reference_no = ? AND branch_id = ?", (ref_no, branch_id))
    if not existing_items:
        existing_items = [primary]

    existing_by_id = {item["id"]: item for item in existing_items}
    incoming_items = payload.items

    if not incoming_items and payload.quantity is not None:
        incoming_items = [
            PurchaseItemEditInput(
                id=primary["id"],
                product_id=primary["product_id"],
                color=payload.color or primary["color"],
                quantity=payload.quantity,
                unit_cost=payload.unit_cost if payload.unit_cost is not None else primary["unit_cost"],
            )
        ]

    if not incoming_items:
        raise HTTPException(status_code=400, detail="Cannot save an empty invoice.")

    incoming_ids = set()
    for item in incoming_items:
        if item.quantity <= 0:
            raise HTTPException(status_code=400, detail="Item quantity must be at least 1.")
        if item.unit_cost < 0:
            raise HTTPException(status_code=400, detail="Item unit cost cannot be negative.")

        if item.id and item.id in existing_by_id:
            incoming_ids.add(item.id)
            old_qty = int(existing_by_id[item.id]["quantity"] or 0)
            diff = old_qty - int(item.quantity)
            if diff > 0:
                snapshot = get_product_stock_snapshot(existing_by_id[item.id]["product_id"])
                curr_stock = float(snapshot.get("current_stock") or 0)
                if curr_stock < diff:
                    prod = _product_exists(existing_by_id[item.id]["product_id"], branch_id=branch_id)
                    raise HTTPException(status_code=400, detail=f"Cannot reduce '{prod['model']}' by {diff}. Only {int(curr_stock)} unit(s) remain in stock.")

    removed_ids = set(existing_by_id.keys()) - incoming_ids
    for r_id in removed_ids:
        rem_item = existing_by_id[r_id]
        snapshot = get_product_stock_snapshot(rem_item["product_id"])
        curr_stock = float(snapshot.get("current_stock") or 0)
        rem_qty = float(rem_item["quantity"] or 0)
        if curr_stock < rem_qty:
            prod = _product_exists(rem_item["product_id"], branch_id=branch_id)
            raise HTTPException(status_code=400, detail=f"Cannot remove '{prod['model']}': {int(rem_qty)} unit(s) were purchased, but only {int(curr_stock)} remain in stock.")

    now_str = now_iso()
    purchase_date_str = payload.purchase_date.strip() or primary["purchase_date"]
    supplier_name = payload.supplier_name.strip() or primary["supplier_name"]
    supplier_phone = payload.supplier_phone.strip() or primary["supplier_phone"]
    notes = payload.notes.strip() or primary["notes"]
    affected_pids = set()

    with get_db_cursor(commit=True) as (_, cursor):
        for r_id in removed_ids:
            rem_item = existing_by_id[r_id]
            affected_pids.add(rem_item["product_id"])
            cursor.execute("DELETE FROM account_transactions WHERE purchase_id = ? AND branch_id = ?", (r_id, branch_id))
            cursor.execute("DELETE FROM purchase_entries WHERE id = ? AND branch_id = ?", (r_id, branch_id))

        for item in incoming_items:
            if item.id and item.id in existing_by_id:
                pid = existing_by_id[item.id]["product_id"]
                affected_pids.add(pid)
                cursor.execute(
                    """
                    UPDATE purchase_entries
                    SET quantity = ?, unit_cost = ?, purchase_date = ?, supplier_name = ?, supplier_phone = ?, notes = ?, updated_at = ?
                    WHERE id = ? AND branch_id = ?
                    """,
                    (int(item.quantity), float(item.unit_cost), purchase_date_str, supplier_name, supplier_phone, notes, now_str, item.id, branch_id),
                )
                if item.color.strip():
                    cursor.execute("UPDATE products SET color = ?, updated_at = ? WHERE id = ? AND branch_id = ?", (item.color.strip(), now_str, pid, branch_id))

                cursor.execute("DELETE FROM account_transactions WHERE purchase_id = ? AND branch_id = ?", (item.id, branch_id))
                prod = _product_exists(pid, branch_id=branch_id)
                cursor.execute(
                    """
                    INSERT INTO account_transactions (
                        branch_id, transaction_date, transaction_at, transaction_type, direction, amount, status, party_name, party_phone, description,
                        category_id, product_id, purchase_id, created_at, updated_at
                    ) VALUES (?, ?, ?, 'purchase', 'out', ?, 'Recorded', ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        branch_id,
                        purchase_date_str,
                        now_str,
                        round(int(item.quantity) * float(item.unit_cost), 2),
                        supplier_name,
                        supplier_phone,
                        f"Purchase updated for {prod['model']} ({ref_no})",
                        prod["category_id"],
                        pid,
                        item.id,
                        now_str,
                        now_str,
                    ),
                )
            else:
                new_target_pid = _resolve_or_create_product_variant(
                    branch_id=branch_id,
                    product_id=item.product_id,
                    company=item.company,
                    category_id=item.category_id,
                    series=item.series,
                    model=item.model,
                    color=item.color,
                    unit_cost=item.unit_cost,
                )
                affected_pids.add(new_target_pid)
                prod = _product_exists(new_target_pid, branch_id=branch_id)
                cursor.execute(
                    """
                    INSERT INTO purchase_entries (
                        branch_id, product_id, quantity, unit_cost, purchase_date, supplier_name, supplier_phone,
                        reference_no, notes, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        branch_id,
                        new_target_pid,
                        int(item.quantity),
                        float(item.unit_cost),
                        purchase_date_str,
                        supplier_name,
                        supplier_phone,
                        ref_no,
                        notes,
                        now_str,
                        now_str,
                    ),
                )
                new_purch_id = cursor.lastrowid
                cursor.execute(
                    """
                    INSERT INTO account_transactions (
                        branch_id, transaction_date, transaction_at, transaction_type, direction, amount, status, party_name, party_phone, description,
                        category_id, product_id, purchase_id, created_at, updated_at
                    ) VALUES (?, ?, ?, 'purchase', 'out', ?, 'Recorded', ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        branch_id,
                        purchase_date_str,
                        now_str,
                        round(int(item.quantity) * float(item.unit_cost), 2),
                        supplier_name,
                        supplier_phone,
                        f"Purchase added for {prod['model']} ({ref_no})",
                        prod["category_id"],
                        new_target_pid,
                        new_purch_id,
                        now_str,
                        now_str,
                    ),
                )

    for pid in affected_pids:
        recalculate_sale_costs(pid)

    log_activity(current_user["username"], "purchase", "updated", f"Purchase invoice {ref_no} updated.", branch_id=branch_id)
    return {"message": f"Purchase invoice {ref_no} updated successfully."}


@app.post("/api/purchases/{purchase_id}/reverse")
@app.delete("/api/purchases/{purchase_id}")
def delete_purchase(
    purchase_id: int,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
    security_code: str = Query(default=""),
    payload: PurchaseDeleteRequest | None = None,
):
    provided_code = (payload.security_code if payload and payload.security_code else security_code).strip()
    if not is_valid_verification_secret(provided_code):
        raise HTTPException(status_code=403, detail="Invalid Verification Password. Purchase reversal rejected.")

    primary = fetch_one("SELECT * FROM purchase_entries WHERE id = ? AND branch_id = ?", (purchase_id, branch_id))
    if not primary:
        raise HTTPException(status_code=404, detail="Purchase entry not found or already reversed.")

    ref_no = primary.get("reference_no") or f"PUR-{primary['id']}"
    invoice_items = fetch_all("SELECT * FROM purchase_entries WHERE branch_id = ? AND reference_no = ?", (branch_id, ref_no))
    if not invoice_items:
        invoice_items = [primary]

    for item in invoice_items:
        snapshot = get_product_stock_snapshot(item["product_id"])
        avail = float(snapshot.get("current_stock") or 0)
        req_qty = float(item["quantity"] or 0)
        if avail < req_qty:
            prod = _product_exists(item["product_id"], branch_id=branch_id)
            raise HTTPException(
                status_code=400,
                detail=f"Cannot reverse invoice {ref_no}: Only {int(avail)} unit(s) of '{prod['model']}' remain in stock, but {int(req_qty)} unit(s) were purchased. Some units have already been sold.",
            )

    affected_pids = set()
    with get_db_cursor(commit=True) as (_, cursor):
        for item in invoice_items:
            affected_pids.add(item["product_id"])
            cursor.execute("DELETE FROM account_transactions WHERE purchase_id = ? AND branch_id = ?", (item["id"], branch_id))
            cursor.execute("DELETE FROM purchase_entries WHERE id = ? AND branch_id = ?", (item["id"], branch_id))

    for pid in affected_pids:
        recalculate_sale_costs(pid)

    log_activity(
        current_user["username"],
        "purchase",
        "reversed_and_deleted",
        f"Purchase invoice {ref_no} ({len(invoice_items)} item(s)) reversed. Physical stock and ledger restored.",
        purchase_id,
        branch_id=branch_id,
    )
    return {"message": f"Purchase invoice {ref_no} reversed and deleted successfully. Stock and financials restored."}


# --- SALES & INVOICES (Stock Out) ---

@app.get("/api/sales")
def list_sales(
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
    product_id: int | None = Query(default=None),
    category_id: int | None = Query(default=None),
    customer: str | None = Query(default=None),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
):
    return secure_payload(request, get_sales_rows(branch_id=branch_id, product_id=product_id, category_id=category_id, customer=customer, start_date=start_date, end_date=end_date))


@app.post("/api/sales")
def create_sale(
    payload: SaleCreate,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    product = _product_exists(payload.product_id, branch_id=branch_id)
    snapshot = get_product_stock_snapshot(payload.product_id)
    if payload.quantity > int(snapshot["current_stock"]):
        raise HTTPException(status_code=400, detail=f"Only {int(snapshot['current_stock'])} units available in stock.")
    sale_id = execute(
        """
        INSERT INTO sale_entries (
            branch_id, product_id, invoice_id, quantity, unit_price, unit_cost_at_sale, total_profit,
            sale_date, customer_name, customer_phone, reference_no, notes, created_at, updated_at
        ) VALUES (?, ?, NULL, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            branch_id,
            payload.product_id,
            payload.quantity,
            payload.unit_price,
            payload.sale_date.isoformat(),
            payload.customer_name.strip(),
            payload.customer_phone.strip(),
            payload.reference_no.strip(),
            payload.notes.strip(),
            now_iso(),
            now_iso(),
        ),
    )
    recalculate_sale_costs(payload.product_id)
    sale_row = fetch_one("SELECT * FROM sale_entries WHERE id = ? AND branch_id = ?", (sale_id, branch_id))
    record_account_transaction(
        payload.sale_date.isoformat(),
        "sale",
        "in",
        payload.quantity * payload.unit_price,
        "Recorded",
        payload.customer_name,
        f"Direct sale recorded for {product['model']}",
        branch_id=branch_id,
        party_phone=payload.customer_phone,
        category_id=product["category_id"],
        product_id=payload.product_id,
        sale_id=sale_id,
    )
    log_activity(current_user["username"], "sale", "created", f"Sale entry added for product #{payload.product_id}.", sale_id, branch_id=branch_id)
    return {"message": "Sale recorded.", "id": sale_id, "profit": sale_row["total_profit"] if sale_row else 0}


@app.put("/api/sales/{sale_id}")
def update_sale(
    sale_id: int,
    payload: SaleUpdate,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    existing = fetch_one("SELECT * FROM sale_entries WHERE id = ? AND branch_id = ?", (sale_id, branch_id))
    if not existing:
        raise HTTPException(status_code=404, detail="Sale entry not found.")
    if existing.get("invoice_id"):
        raise HTTPException(status_code=400, detail="Invoice-generated sales must be edited from the invoice view.")
    product = _product_exists(payload.product_id, branch_id=branch_id)
    snapshot = get_product_stock_snapshot(payload.product_id)
    available_stock = int(snapshot["current_stock"]) + (int(existing["quantity"]) if existing["product_id"] == payload.product_id else 0)
    if payload.quantity > available_stock:
        raise HTTPException(status_code=400, detail=f"Only {available_stock} units available in stock.")
    execute(
        """
        UPDATE sale_entries
        SET product_id = ?, quantity = ?, unit_price = ?, sale_date = ?, customer_name = ?, customer_phone = ?, reference_no = ?, notes = ?, updated_at = ?
        WHERE id = ? AND branch_id = ?
        """,
        (
            payload.product_id,
            payload.quantity,
            payload.unit_price,
            payload.sale_date.isoformat(),
            payload.customer_name.strip(),
            payload.customer_phone.strip(),
            payload.reference_no.strip(),
            payload.notes.strip(),
            now_iso(),
            sale_id,
            branch_id,
        ),
    )
    recalculate_sale_costs(existing["product_id"])
    if existing["product_id"] != payload.product_id:
        recalculate_sale_costs(payload.product_id)
    execute("DELETE FROM account_transactions WHERE sale_id = ? AND branch_id = ?", (sale_id, branch_id))
    record_account_transaction(
        payload.sale_date.isoformat(),
        "sale",
        "in",
        payload.quantity * payload.unit_price,
        "Recorded",
        payload.customer_name,
        f"Direct sale recorded for {product['model']}",
        branch_id=branch_id,
        party_phone=payload.customer_phone,
        category_id=product["category_id"],
        product_id=payload.product_id,
        sale_id=sale_id,
    )
    log_activity(current_user["username"], "sale", "updated", f"Sale entry #{sale_id} updated.", sale_id, branch_id=branch_id)
    return {"message": "Sale updated."}


@app.delete("/api/sales/{sale_id}")
def delete_sale(
    sale_id: int,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    existing = fetch_one("SELECT * FROM sale_entries WHERE id = ? AND branch_id = ?", (sale_id, branch_id))
    if not existing:
        raise HTTPException(status_code=404, detail="Sale entry not found.")
    if existing.get("invoice_id"):
        raise HTTPException(status_code=400, detail="Invoice-generated sales must be deleted from the invoice view.")
    execute("DELETE FROM account_transactions WHERE sale_id = ? AND branch_id = ?", (sale_id, branch_id))
    execute("DELETE FROM sale_entries WHERE id = ? AND branch_id = ?", (sale_id, branch_id))
    recalculate_sale_costs(existing["product_id"])
    log_activity(current_user["username"], "sale", "deleted", f"Sale entry #{sale_id} deleted.", sale_id, branch_id=branch_id)
    return {"message": "Sale deleted."}


@app.get("/api/invoices")
def list_invoices(
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
    status: str | None = Query(default=None),
    customer: str | None = Query(default=None),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
):
    conditions = ["branch_id = ?"]
    params: list = [branch_id]
    if status:
        conditions.append("status = ?")
        params.append(status)
    if customer:
        conditions.append("customer_name LIKE ?")
        params.append(f"%{customer.strip()}%")
    if start_date:
        conditions.append("invoice_date >= ?")
        params.append(start_date)
    if end_date:
        conditions.append("invoice_date <= ?")
        params.append(end_date)
    rows = fetch_all(
        f"SELECT * FROM invoices WHERE {' AND '.join(conditions)} ORDER BY invoice_date DESC, id DESC",
        tuple(params),
    )
    return secure_payload(request, rows)


@app.get("/api/invoices/{invoice_id}")
def invoice_detail(
    invoice_id: int,
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
):
    return secure_payload(request, get_invoice_detail(invoice_id, branch_id=branch_id))


@app.post("/api/invoices")
def create_invoice(
    payload: InvoiceCreate,
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    transaction = SaleTransactionCreate(
        customer_name=payload.customer_name,
        phone_number=payload.phone_number,
        address=payload.address,
        status=payload.status,
        transaction_at=datetime.fromisoformat(f"{payload.invoice_date.isoformat()}T12:00:00"),
        notes=payload.notes,
        generate_pdf=payload.generate_pdf,
        ignore_duplicate=payload.ignore_duplicate,
        apply_discount=payload.apply_discount,
        discount_name=payload.discount_name,
        discount_type=payload.discount_type,
        discount_value=payload.discount_value,
        items=[{"product_id": item.product_id, "quantity": item.quantity, "unit_price": item.unit_price} for item in payload.items],
    )
    return secure_payload(request, create_sale_transaction_record(transaction, current_user, source="invoice_api", branch_id=branch_id))


@app.post("/api/sales/transactions")
def create_sale_transaction(
    payload: SaleTransactionCreate,
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    return secure_payload(request, create_sale_transaction_record(payload, current_user, source="sales_transaction", branch_id=branch_id))


@app.get("/api/invoices/{invoice_id}/pdf")
def invoice_pdf(
    invoice_id: int,
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
):
    if not price_access_granted(request):
        raise HTTPException(status_code=403, detail="Unlock prices first to open the invoice PDF.")
    invoice = fetch_one("SELECT * FROM invoices WHERE id = ? AND branch_id = ?", (invoice_id, branch_id))
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found.")
    pdf_path = Path(invoice.get("pdf_path") or "")
    if (not pdf_path.exists()) or pdf_path.stat().st_size <= 0:
        detail = get_invoice_detail(invoice_id, branch_id=branch_id)
        pdf_path = DATA_DIR / "invoices" / f"{invoice['invoice_number']}.pdf"
        build_invoice_pdf(str(pdf_path), detail["invoice"], detail["items"])
        if not pdf_path.exists() or pdf_path.stat().st_size <= 0:
            raise HTTPException(status_code=500, detail="Invoice PDF could not be generated.")
        execute("UPDATE invoices SET pdf_path = ?, updated_at = ? WHERE id = ?", (str(pdf_path), now_iso(), invoice_id))
    return FileResponse(
        str(pdf_path),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"inline; filename={invoice['invoice_number']}.pdf",
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "X-Content-Type-Options": "nosniff",
        },
    )


class InvoiceReversePayload(BaseModel):
    security_code: str = ""


@app.post("/api/invoices/{invoice_id}/reverse")
@app.delete("/api/invoices/{invoice_id}")
def reverse_and_delete_invoice(
    invoice_id: int,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
    security_code: str = Query(default=""),
    payload: InvoiceReversePayload | None = None,
):
    provided_code = (payload.security_code if payload and payload.security_code else security_code).strip()
    if not is_valid_verification_secret(provided_code):
        raise HTTPException(status_code=403, detail="Invalid verification password. Sale reversal rejected.")

    invoice = fetch_one("SELECT * FROM invoices WHERE id = ?", (invoice_id,))
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found or already reversed.")

    actual_branch_id = invoice.get("branch_id") or branch_id
    items = fetch_all("SELECT DISTINCT product_id FROM invoice_items WHERE invoice_id = ?", (invoice_id,))

    with get_db_cursor(commit=True) as (_, cursor):
        cursor.execute("DELETE FROM sale_entries WHERE invoice_id = ?", (invoice_id,))
        cursor.execute("DELETE FROM account_transactions WHERE invoice_id = ?", (invoice_id,))
        cursor.execute("DELETE FROM invoice_items WHERE invoice_id = ?", (invoice_id,))
        cursor.execute("DELETE FROM invoices WHERE id = ?", (invoice_id,))

    for item in items:
        if item.get("product_id"):
            try:
                recalculate_sale_costs(item["product_id"])
            except Exception as e:
                logger.warning(f"Cost recalculation skipped for product #{item['product_id']}: {e}")

    try:
        log_activity(
            current_user["username"],
            "invoice",
            "reversed_and_deleted",
            f"Sale invoice {invoice.get('invoice_number', invoice_id)} reversed & deleted. Stock restored.",
            invoice_id,
            branch_id=actual_branch_id,
        )
    except Exception:
        pass

    return {"message": "Sale transaction reversed and deleted successfully. Stock restored."}


@app.get("/api/dashboard/overview")
def dashboard_overview(
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
    company: str | None = Query(default=None),
    category_id: int | None = Query(default=None),
    search: str = Query(default=""),
    series: str | None = Query(default=None),
    stock_status: str = Query(default="all"),
):
    return secure_payload(
        request,
        build_dashboard_insights(
            company=company,
            category_id=category_id,
            search=search,
            series=series,
            stock_status=stock_status,
            branch_id=branch_id,
        ),
    )


@app.get("/api/dashboard/summary")
def dashboard_summary(
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
):
    return secure_payload(request, build_dashboard_insights(branch_id=branch_id))


@app.get("/api/dashboard/insights")
def dashboard_insights(
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
):
    return secure_payload(request, build_dashboard_insights(branch_id=branch_id))


@app.get("/api/stocks/overview")
def stocks_overview(
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
    company: str | None = Query(default=None),
    category_id: int | None = Query(default=None),
    search: str = Query(default=""),
    stock_status: str = Query(default="in_stock"),
):
    return secure_payload(
        request,
        build_stocks_overview(
            company=company,
            category_id=category_id,
            search=search,
            stock_status=stock_status,
            branch_id=branch_id,
        ),
    )


@app.get("/api/categories/{category_id}/detail")
def category_detail(
    category_id: int,
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
    company: str | None = Query(default=None),
    search: str = Query(default=""),
    series: str | None = Query(default=None),
    stock_status: str = Query(default="all"),
):
    return secure_payload(
        request,
        build_category_detail(
            category_id,
            company=company,
            search=search,
            series=series,
            stock_status=stock_status,
            branch_id=branch_id,
        ),
    )


ACCOUNTS_COOKIE_NAME = "malik_accounts_access"
ACCOUNTS_SECURITY_KEY = "Alyas51214"


class AccountsUnlockRequest(BaseModel):
    security_key: str


def create_accounts_access_token(username: str) -> str:
    expires = datetime.now(timezone.utc) + timedelta(minutes=PRICE_UNLOCK_MINUTES)
    payload = {"sub": username, "scope": "accounts_access", "exp": expires}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def accounts_access_granted(request: Request) -> bool:
    token = request.cookies.get(ACCOUNTS_COOKIE_NAME)
    if not token:
        return False
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload.get("scope") == "accounts_access"
    except jwt.InvalidTokenError:
        return False


@app.get("/api/accounts/auth/status")
def get_accounts_auth_status(request: Request, current_user: Annotated[dict, Depends(require_ready_user)]):
    return {"can_view_accounts": accounts_access_granted(request)}


@app.post("/api/accounts/auth/unlock")
def unlock_accounts_access(payload: AccountsUnlockRequest, request: Request, response: Response, current_user: Annotated[dict, Depends(require_ready_user)]):
    if not is_valid_verification_secret(payload.security_key):
        raise HTTPException(status_code=403, detail="Invalid verification password. Accounts remain protected.")
    token = create_accounts_access_token(current_user["username"])
    response.set_cookie(ACCOUNTS_COOKIE_NAME, token, httponly=True, samesite="lax", secure=False, max_age=PRICE_UNLOCK_MINUTES * 60, path="/")
    return {"message": "Accounts unlocked successfully.", "can_view_accounts": True}


@app.post("/api/accounts/auth/lock")
@app.delete("/api/accounts/auth/lock")
def lock_accounts_access(response: Response, current_user: Annotated[dict, Depends(require_ready_user)]):
    response.delete_cookie(ACCOUNTS_COOKIE_NAME, path="/")
    return {"message": "Accounts locked.", "can_view_accounts": False}


@app.get("/api/accounts/summary")
def accounts_summary(
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
    period: str | None = Query(default=None),
    company: str | None = Query(default=None),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
):
    PKT = timezone(timedelta(hours=5))
    local_today = datetime.now(PKT).date()
    today_str = local_today.isoformat()
    clean_company = canonical_company_name(company) if company else ""

    s_date = (start_date or "").strip()
    e_date = (end_date or "").strip()

    if not s_date and not e_date:
        if period == "today" or not period:
            s_date = today_str
            e_date = today_str
        elif period == "yesterday":
            y_str = (local_today - timedelta(days=1)).isoformat()
            s_date = y_str
            e_date = y_str
        elif period == "this_week":
            s_date = (local_today - timedelta(days=local_today.weekday())).isoformat()
            e_date = today_str
        elif period == "last_week":
            s_date = (local_today - timedelta(days=local_today.weekday() + 7)).isoformat()
            e_date = (local_today - timedelta(days=local_today.weekday() + 1)).isoformat()
        elif period == "this_month":
            s_date = local_today.replace(day=1).isoformat()
            e_date = today_str
        elif period == "last_month":
            first_this_month = local_today.replace(day=1)
            last_month_end = first_this_month - timedelta(days=1)
            s_date = last_month_end.replace(day=1).isoformat()
            e_date = last_month_end.isoformat()
        elif period == "this_year":
            s_date = local_today.replace(month=1, day=1).isoformat()
            e_date = today_str
        elif period == "last_year":
            last_year_num = local_today.year - 1
            s_date = f"{last_year_num}-01-01"
            e_date = f"{last_year_num}-12-31"
        elif period == "all":
            s_date = ""
            e_date = ""

    sales_conditions = [
        "se.branch_id = ?",
        "ifnull(se.customer_name, '') NOT LIKE 'Internal%'",
        "ifnull(se.customer_name, '') NOT LIKE 'Branch Transfer%'",
        "ifnull(se.reference_no, '') NOT LIKE 'TR-%'",
        "ifnull(se.reference_no, '') NOT LIKE 'TRANSFER%'",
    ]
    sales_params = [branch_id]
    if clean_company:
        sales_conditions.append("lower(p.company) = lower(?)")
        sales_params.append(clean_company)
    if s_date:
        sales_conditions.append("se.sale_date >= ?")
        sales_params.append(s_date)
    if e_date:
        sales_conditions.append("se.sale_date <= ?")
        sales_params.append(e_date)

    sales_items_rows = fetch_all(
        f"""
        SELECT se.id, se.invoice_id, se.product_id, se.quantity, se.unit_price, se.total_profit, se.sale_date,
               se.customer_name, se.customer_phone, inv.invoice_number, inv.status AS invoice_status,
               p.model, p.company, p.series, p.color,
               COALESCE(ii.total_price, se.quantity * se.unit_price) AS line_revenue
        FROM sale_entries se
        JOIN products p ON p.id = se.product_id AND p.branch_id = se.branch_id
        LEFT JOIN invoices inv ON inv.id = se.invoice_id AND inv.branch_id = se.branch_id
        LEFT JOIN invoice_items ii ON ii.sale_entry_id = se.id AND ii.branch_id = se.branch_id
        WHERE {' AND '.join(sales_conditions)}
        ORDER BY se.sale_date DESC, se.id DESC
        """,
        tuple(sales_params),
    )

    purchase_conditions = [
        "pe.branch_id = ?",
        "ifnull(pe.supplier_name, '') NOT LIKE 'Internal%'",
        "ifnull(pe.supplier_name, '') NOT LIKE 'Branch Transfer%'",
        "ifnull(pe.reference_no, '') NOT LIKE 'TR-%'",
        "ifnull(pe.reference_no, '') NOT LIKE 'TRANSFER%'",
    ]
    purchase_params = [branch_id]
    if clean_company:
        purchase_conditions.append("lower(p.company) = lower(?)")
        purchase_params.append(clean_company)
    if s_date:
        purchase_conditions.append("pe.purchase_date >= ?")
        purchase_params.append(s_date)
    if e_date:
        purchase_conditions.append("pe.purchase_date <= ?")
        purchase_params.append(e_date)

    purchase_items_rows = fetch_all(
        f"""
        SELECT pe.id, pe.product_id, pe.quantity, pe.unit_cost, pe.purchase_date, pe.supplier_name,
               pe.supplier_phone, pe.reference_no, pe.notes,
               p.model, p.company, p.series, p.color,
               ROUND(pe.quantity * pe.unit_cost, 2) AS line_spend
        FROM purchase_entries pe
        JOIN products p ON p.id = pe.product_id AND p.branch_id = pe.branch_id
        WHERE {' AND '.join(purchase_conditions)}
        ORDER BY pe.purchase_date DESC, pe.id DESC
        """,
        tuple(purchase_params),
    )

    sales_invoices_map: dict[str, dict] = {}
    total_sales_revenue = 0.0
    total_gross_profit = 0.0
    total_units_sold = 0

    for item in sales_items_rows:
        inv_key = item.get("invoice_number") or f"DIR-{item['id']}"
        rev = float(item["line_revenue"] or 0)
        profit = float(item["total_profit"] or 0)
        qty = int(item["quantity"] or 0)

        total_sales_revenue += rev
        total_gross_profit += profit
        total_units_sold += qty

        if inv_key not in sales_invoices_map:
            sales_invoices_map[inv_key] = {
                "invoice_id": item.get("invoice_id"),
                "invoice_number": inv_key,
                "date": item["sale_date"],
                "customer_name": item["customer_name"] or "Walk-in Customer",
                "phone_number": item["customer_phone"] or "",
                "status": item["invoice_status"] or "Paid",
                "total_amount": 0.0,
                "total_profit": 0.0,
                "total_quantity": 0,
                "items": [],
            }
        sales_invoices_map[inv_key]["total_amount"] = round(sales_invoices_map[inv_key]["total_amount"] + rev, 2)
        sales_invoices_map[inv_key]["total_profit"] = round(sales_invoices_map[inv_key]["total_profit"] + profit, 2)
        sales_invoices_map[inv_key]["total_quantity"] += qty
        sales_invoices_map[inv_key]["items"].append(item)

    purchase_invoices_map: dict[str, dict] = {}
    total_purchases_spend = 0.0
    total_units_purchased = 0

    for item in purchase_items_rows:
        ref_key = item["reference_no"] or f"PUR-{item['id']}"
        spend = float(item["line_spend"] or 0)
        qty = int(item["quantity"] or 0)

        total_purchases_spend += spend
        total_units_purchased += qty

        if ref_key not in purchase_invoices_map:
            purchase_invoices_map[ref_key] = {
                "id": item["id"],
                "reference_no": ref_key,
                "date": item["purchase_date"],
                "supplier_name": item["supplier_name"] or "Vendor",
                "supplier_phone": item["supplier_phone"] or "",
                "notes": item["notes"] or "",
                "total_amount": 0.0,
                "total_quantity": 0,
                "items": [],
            }
        purchase_invoices_map[ref_key]["total_amount"] = round(purchase_invoices_map[ref_key]["total_amount"] + spend, 2)
        purchase_invoices_map[ref_key]["total_quantity"] += qty
        purchase_invoices_map[ref_key]["items"].append(item)

    all_known_companies = get_known_companies(branch_id=branch_id)
    all_branch_inventory = get_products_data(branch_id=branch_id)
    company_breakdown = []

    for comp_name in all_known_companies:
        comp_inventory = [p for p in all_branch_inventory if canonical_company_name(p.get("company")) == comp_name]
        c_sales = [s for s in sales_items_rows if canonical_company_name(s.get("company")) == comp_name]
        c_purchases = [pu for pu in purchase_items_rows if canonical_company_name(pu.get("company")) == comp_name]

        comp_breakdown = {
            "company": comp_name,
            "sales_revenue": round(sum(float(x["line_revenue"] or 0) for x in c_sales), 2),
            "purchase_spend": round(sum(float(x["line_spend"] or 0) for x in c_purchases), 2),
            "gross_profit": round(sum(float(x["total_profit"] or 0) for x in c_sales), 2),
            "units_sold": sum(int(x["quantity"] or 0) for x in c_sales),
            "units_purchased": sum(int(x["quantity"] or 0) for x in c_purchases),
            "current_stock": round(sum(float(p.get("current_stock") or 0) for p in comp_inventory), 2),
            "stock_value": round(sum(float(p.get("current_stock_value") or 0) for p in comp_inventory), 2),
        }
        company_breakdown.append(comp_breakdown)

    current_inventory = get_products_data(branch_id=branch_id, company=clean_company or None)
    current_stock_units = round(sum(float(p.get("current_stock") or 0) for p in current_inventory), 2)
    current_stock_val = round(sum(float(p.get("current_stock_value") or 0) for p in current_inventory), 2)

    branch_record = fetch_one("SELECT name, address FROM branches WHERE id = ?", (branch_id,)) or {"name": "Main Branch", "address": ""}

    payload = {
        "period": period or "today",
        "selected_company": clean_company,
        "start_date": s_date,
        "end_date": e_date,
        "branch_name": branch_record["name"],
        "branch_address": branch_record["address"],
        "summary": {
            "sales_total": round(total_sales_revenue, 2),
            "purchase_total": round(total_purchases_spend, 2),
            "gross_profit": round(total_gross_profit, 2),
            "current_stock_value": current_stock_val,
            "current_stock_units": current_stock_units,
            "sales_count": len(sales_invoices_map),
            "purchase_count": len(purchase_invoices_map),
            "sold_units": total_units_sold,
            "purchased_units": total_units_purchased,
        },
        "sales_invoices": list(sales_invoices_map.values()),
        "purchase_invoices": list(purchase_invoices_map.values()),
        "company_breakdown": company_breakdown,
        "companies": all_known_companies,
    }

    unlocked = accounts_access_granted(request)
    if not unlocked:
        payload = _mask_sensitive_prices(payload)
    payload["can_view_accounts"] = unlocked
    return payload


# --- EXPORTS & REPORTS ---

@app.get("/api/exports/report")
def export_report(
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
    category_id: int | None = Query(default=None),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
):
    if not price_access_granted(request):
        raise HTTPException(status_code=403, detail="Unlock prices first to export a report.")
    category_name = None
    if category_id:
        category_name = _category_exists(category_id, branch_id=branch_id)["name"]
    categories = get_category_rows(branch_id=branch_id)
    inventory = get_products_data(branch_id=branch_id, category_id=category_id)
    purchases = get_purchase_rows(branch_id=branch_id, category_id=category_id, start_date=start_date, end_date=end_date)
    sales = get_sales_rows(branch_id=branch_id, category_id=category_id, start_date=start_date, end_date=end_date)
    accounts = get_account_rows(branch_id=branch_id, category_id=category_id, start_date=start_date, end_date=end_date)
    if category_id:
        categories = [item for item in categories if item["id"] == category_id]
    summary = {
        "total_categories": len(categories),
        "total_products": len(inventory),
        "current_stock_units": round(sum(float(item.get("current_stock") or 0) for item in inventory), 2),
        "current_stock_value": round(sum(float(item.get("current_stock_value") or 0) for item in inventory), 2),
        "purchase_total": round(sum(float(item.get("total_amount") or 0) for item in purchases), 2),
        "sales_total": round(sum(float(item.get("total_amount") or 0) for item in sales), 2),
        "gross_profit": round(sum(float(item.get("total_profit") or 0) for item in sales), 2),
    }
    temp_file = NamedTemporaryFile(delete=False, suffix=".xlsx")
    temp_file.close()
    build_export_file(
        temp_file.name,
        summary=summary,
        categories=categories,
        inventory=inventory,
        purchases=purchases,
        sales=sales,
        accounts=accounts,
        filters={
            "category_name": category_name,
            "start_date": start_date,
            "end_date": end_date,
            "generated_at": now_iso(),
        },
    )
    filename = "malik-electronic-report.xlsx"
    return FileResponse(
        temp_file.name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=filename,
    )


# --- DISCOUNT RULES ---

@app.get("/api/discount-rules")
def list_discount_rules(
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
):
    return fetch_all("SELECT * FROM discount_rules WHERE branch_id = ? ORDER BY active DESC, name ASC", (branch_id,))


@app.post("/api/discount-rules")
def create_discount_rule(
    payload: DiscountRuleCreate,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    key = normalize_key(payload.name)
    if fetch_one("SELECT id FROM discount_rules WHERE branch_id = ? AND name_key = ?", (branch_id, key)):
        raise HTTPException(status_code=400, detail="A discount with this name already exists in this branch.")
    now = now_iso()
    rule_id = execute(
        "INSERT INTO discount_rules (branch_id, name, name_key, discount_type, discount_value, description, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (branch_id, payload.name.strip(), key, payload.discount_type, float(payload.discount_value or 0), payload.description.strip(), int(payload.active or 0), now, now),
    )
    log_activity(current_user["username"], "discount_rule", "created", f"Discount rule '{payload.name.strip()}' created.", rule_id, branch_id=branch_id)
    return fetch_one("SELECT * FROM discount_rules WHERE id = ?", (rule_id,))


@app.put("/api/discount-rules/{rule_id}")
def update_discount_rule(
    rule_id: int,
    payload: DiscountRuleUpdate,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    existing = fetch_one("SELECT * FROM discount_rules WHERE id = ? AND branch_id = ?", (rule_id, branch_id))
    if not existing:
        raise HTTPException(status_code=404, detail="Discount rule not found.")
    key = normalize_key(payload.name)
    conflict = fetch_one("SELECT id FROM discount_rules WHERE branch_id = ? AND name_key = ? AND id != ?", (branch_id, key, rule_id))
    if conflict:
        raise HTTPException(status_code=400, detail="Another discount already uses this name.")
    execute(
        "UPDATE discount_rules SET name = ?, name_key = ?, discount_type = ?, discount_value = ?, description = ?, active = ?, updated_at = ? WHERE id = ? AND branch_id = ?",
        (payload.name.strip(), key, payload.discount_type, float(payload.discount_value or 0), payload.description.strip(), int(payload.active or 0), now_iso(), rule_id, branch_id),
    )
    log_activity(current_user["username"], "discount_rule", "updated", f"Discount rule '{payload.name.strip()}' updated.", rule_id, branch_id=branch_id)
    return fetch_one("SELECT * FROM discount_rules WHERE id = ?", (rule_id,))


@app.delete("/api/discount-rules/{rule_id}")
def delete_discount_rule(
    rule_id: int,
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(require_active_branch)],
):
    existing = fetch_one("SELECT * FROM discount_rules WHERE id = ? AND branch_id = ?", (rule_id, branch_id))
    if not existing:
        raise HTTPException(status_code=404, detail="Discount rule not found.")
    execute("DELETE FROM discount_rules WHERE id = ? AND branch_id = ?", (rule_id, branch_id))
    log_activity(current_user["username"], "discount_rule", "deleted", f"Discount rule '{existing['name']}' deleted.", rule_id, branch_id=branch_id)
    return {"message": "Discount rule deleted."}


# --- ISSUE 2: MOVE STOCK LOCATION (Warehouse to Display) ---

class StockTransferPayload(BaseModel):
    from_product_id: int
    to_location_id: int
    quantity: int


@app.post("/api/products/transfer")
def transfer_product_stock(
    payload: StockTransferPayload,
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
):
    branch_id = resolve_branch_id(request)
    if payload.quantity <= 0:
        raise HTTPException(status_code=400, detail="Transfer quantity must be at least 1 unit.")

    src = _product_exists(payload.from_product_id, branch_id=branch_id)
    dest_loc = _location_exists(payload.to_location_id, branch_id=branch_id)
    if not dest_loc:
        raise HTTPException(status_code=400, detail="Target destination location not found.")

    if src.get("location_id") == payload.to_location_id:
        raise HTTPException(status_code=400, detail="Product is already in this location.")

    snapshot = get_product_stock_snapshot(payload.from_product_id)
    curr_avail = float(snapshot.get("current_stock") or 0)
    if payload.quantity > curr_avail:
        raise HTTPException(status_code=400, detail=f"Cannot move {payload.quantity} units. Only {int(curr_avail)} unit(s) available in current location.")

    dest_variant = fetch_one(
        """
        SELECT id FROM products
        WHERE branch_id = ? AND category_id = ? AND location_id = ? 
          AND lower(series) = lower(?) AND lower(model) = lower(?) 
          AND lower(company) = lower(?) AND lower(color) = lower(?) AND lower(size) = lower(?) AND active = 1
        """,
        (branch_id, src["category_id"], payload.to_location_id, src["series"], src["model"], src["company"], src["color"], src["size"]),
    )

    now_str = now_iso()
    today_str = datetime.utcnow().date().isoformat()
    cost_price = float(src.get("default_purchase_price") or 0)

    with get_db_cursor(commit=True) as (_, cursor):
        if dest_variant:
            dest_pid = dest_variant["id"]
        else:
            cursor.execute(
                """
                INSERT INTO products (
                    branch_id, category_id, location_id, series, model, company, color, size, image_path, min_stock,
                    default_purchase_price, default_sale_price, notes, active, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                """,
                (
                    branch_id, src["category_id"], payload.to_location_id, src["series"], src["model"], src["company"],
                    src["color"], src["size"], src["image_path"], src["min_stock"], cost_price,
                    float(src.get("default_sale_price") or 0), src.get("notes") or "", now_str, now_str
                ),
            )
            dest_pid = cursor.lastrowid

        cursor.execute(
            """
            INSERT INTO sale_entries (
                branch_id, product_id, quantity, unit_price, unit_cost_at_sale, total_profit,
                sale_date, transaction_at, customer_name, reference_no, notes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'Internal Movement', 'TRANSFER-LOC', ?, ?, ?)
            """,
            (
                branch_id, src["id"], payload.quantity, cost_price, cost_price,
                today_str, now_str, f"Moved to {dest_loc['name']}", now_str, now_str
            ),
        )

        cursor.execute(
            """
            INSERT INTO purchase_entries (
                branch_id, product_id, quantity, unit_cost, purchase_date, supplier_name,
                reference_no, notes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'Internal Movement', 'TRANSFER-LOC', ?, ?, ?)
            """,
            (
                branch_id, dest_pid, payload.quantity, cost_price, today_str,
                f"Moved from {src.get('location_name') or 'Warehouse'}", now_str, now_str
            ),
        )

    recalculate_sale_costs(src["id"])
    recalculate_sale_costs(dest_pid)
    log_activity(current_user["username"], "stock_transfer", "moved", f"Moved {payload.quantity} unit(s) of '{src['model']}' to {dest_loc['name']}.", src["id"], branch_id=branch_id)
    return {"message": f"Successfully moved {payload.quantity} unit(s) to {dest_loc['name']}."}


# --- INTER-BRANCH TRANSFER ENGINE (Talagang City <-> Multan Khurd) ---

class InterBranchTransferPayload(BaseModel):
    to_branch_id: int
    product_id: int
    quantity: int
    notes: str = ""


def _ensure_branch_transfers_table():
    execute("""
        CREATE TABLE IF NOT EXISTS branch_transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_branch_id INTEGER NOT NULL,
            to_branch_id INTEGER NOT NULL,
            from_product_id INTEGER NOT NULL,
            to_product_id INTEGER,
            company TEXT NOT NULL,
            category_name TEXT NOT NULL,
            series TEXT DEFAULT '',
            model TEXT NOT NULL,
            color TEXT DEFAULT '',
            size TEXT DEFAULT '',
            quantity INTEGER NOT NULL,
            unit_cost REAL NOT NULL DEFAULT 0,
            reference_no TEXT NOT NULL,
            transfer_date TEXT NOT NULL,
            transfer_at TEXT NOT NULL,
            notes TEXT DEFAULT '',
            username TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            FOREIGN KEY (from_branch_id) REFERENCES branches(id) ON DELETE CASCADE,
            FOREIGN KEY (to_branch_id) REFERENCES branches(id) ON DELETE CASCADE
        );
    """)
    execute("CREATE INDEX IF NOT EXISTS idx_bt_from ON branch_transfers(from_branch_id);")
    execute("CREATE INDEX IF NOT EXISTS idx_bt_to ON branch_transfers(to_branch_id);")


@app.get("/api/branch-transfers")
def list_branch_transfers(
    current_user: Annotated[dict, Depends(require_ready_user)],
    branch_id: Annotated[int, Depends(get_current_branch_id)],
):
    _ensure_branch_transfers_table()
    rows = fetch_all(
        """
        SELECT bt.*,
               fb.name AS from_branch_name,
               tb.name AS to_branch_name
        FROM branch_transfers bt
        JOIN branches fb ON fb.id = bt.from_branch_id
        JOIN branches tb ON tb.id = bt.to_branch_id
        WHERE bt.from_branch_id = ? OR bt.to_branch_id = ?
        ORDER BY bt.id DESC
        """,
        (branch_id, branch_id),
    )
    for r in rows:
        r["transfer_type"] = "outward" if r["from_branch_id"] == branch_id else "inward"
    return rows

BRAND_EQUIVALENT_GROUPS = [
    {"bonus", "bouns"},
    {"ecoplus", "ecoplusled"},
    {"superflame", "superflam"},
    {"gasstove", "stove"},
    {"national", "nationalgold"},
]


def _company_compact_key(name: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").strip().lower())


def _companies_are_equivalent(name_a: str | None, name_b: str | None) -> bool:
    key_a = _company_compact_key(name_a)
    key_b = _company_compact_key(name_b)
    if not key_a or not key_b:
        return False
    if key_a == key_b:
        return True
    for group in BRAND_EQUIVALENT_GROUPS:
        if key_a in group and key_b in group:
            return True
    return False


def _model_compact_key(model: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (model or "").strip().lower())


def _model_core_code(model: str | None) -> str:
    """
    Extracts the core model code when a branch omits a leading alphabetic prefix.
    Example: 'RP-134' -> '134', 'RP 134' -> '134', '134' -> '134'.
    """
    clean = (model or "").strip().lower()
    # Match patterns like 'rp-134', 'rp 134', 'dw-650', 'ac-18'
    m = re.match(r"^[a-z]{1,5}[-\s_]+([a-z0-9]+)$", clean)
    if m:
        return re.sub(r"[^a-z0-9]", "", m.group(1))
    # Match patterns like 'rp134' where letters are followed by >=2 digits
    m2 = re.match(r"^[a-z]{1,4}(\d{2,}[a-z0-9]*)$", re.sub(r"[^a-z0-9]", "", clean))
    if m2:
        return m2.group(1)
    return _model_compact_key(clean)


def _models_are_equivalent(model_a: str | None, model_b: str | None) -> tuple[bool, int]:
    """
    Returns (is_match, priority_score) where:
    - priority 100 = exact case/punctuation-insensitive match (e.g., 'RP-134' == 'rp-134' or 'RP 134')
    - priority 80  = prefix-stripped core code match (e.g., 'RP-134' <-> '134')
    """
    comp_a = _model_compact_key(model_a)
    comp_b = _model_compact_key(model_b)
    if not comp_a or not comp_b:
        return (False, 0)
    if comp_a == comp_b:
        return (True, 100)

    core_a = _model_core_code(model_a)
    core_b = _model_compact_key(model_b)
    core_b_stripped = _model_core_code(model_b)

    # Only match core code if it has at least 2 characters (e.g., '134') and matches exactly
    if len(core_a) >= 2 and (core_a == core_b or comp_a == core_b_stripped or core_a == core_b_stripped):
        return (True, 80)

    return (False, 0)


def _resolve_destination_company(to_branch_id: int, src_company: str, now_str: str) -> str:
    """
    Finds an existing company in the destination branch that matches src_company
    (handling capitalization, spacing, and known spelling variations like Bouns <-> bouns/Bonus).
    If found, returns the destination branch's existing company name; otherwise creates it.
    """
    raw_company = (src_company or "").strip()
    if not raw_company:
        return ""

    existing_companies = fetch_all("SELECT id, name FROM companies WHERE branch_id = ?", (to_branch_id,))
    for row in existing_companies:
        if _companies_are_equivalent(row["name"], raw_company):
            return row["name"]

    existing_prod_companies = fetch_all(
        "SELECT DISTINCT company FROM products WHERE branch_id = ? AND ifnull(company, '') != ''",
        (to_branch_id,),
    )
    for row in existing_prod_companies:
        if _companies_are_equivalent(row["company"], raw_company):
            matched_name = row["company"]
            execute(
                "INSERT OR IGNORE INTO companies (branch_id, name, name_key, image_path, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)",
                (to_branch_id, matched_name, normalize_key(matched_name), now_str, now_str),
            )
            return matched_name

    existing_cat_companies = fetch_all(
        "SELECT DISTINCT company FROM catalog_models WHERE branch_id = ? AND ifnull(company, '') != ''",
        (to_branch_id,),
    )
    for row in existing_cat_companies:
        if _companies_are_equivalent(row["company"], raw_company):
            matched_name = row["company"]
            execute(
                "INSERT OR IGNORE INTO companies (branch_id, name, name_key, image_path, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)",
                (to_branch_id, matched_name, normalize_key(matched_name), now_str, now_str),
            )
            return matched_name

    canonical = canonical_company_name(raw_company)
    execute(
        "INSERT OR IGNORE INTO companies (branch_id, name, name_key, image_path, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)",
        (to_branch_id, canonical, normalize_key(canonical), now_str, now_str),
    )
    return canonical


def _find_matching_destination_product(to_branch_id: int, dst_cat_id: int, src_prod: dict, resolved_company: str) -> dict | None:
    """
    Finds an equivalent product variant in the destination branch so transfers update
    existing company/model stock instead of creating duplicate records.
    """
    candidates = fetch_all(
        "SELECT * FROM products WHERE branch_id = ? AND category_id = ? AND active = 1",
        (to_branch_id, dst_cat_id),
    )
    if not candidates:
        # Also check across all categories in destination branch if the model was categorized slightly differently
        candidates = fetch_all(
            "SELECT * FROM products WHERE branch_id = ? AND active = 1",
            (to_branch_id,),
        )

    src_color = normalize_key(src_prod.get("color") or "Standard") or "standard"
    src_series = normalize_key(src_prod.get("series") or "")
    src_size = normalize_key(src_prod.get("size") or "")

    scored_matches: list[tuple[int, dict]] = []
    for cand in candidates:
        if not _companies_are_equivalent(cand.get("company"), resolved_company):
            continue

        is_model_match, model_score = _models_are_equivalent(src_prod.get("model"), cand.get("model"))
        if not is_model_match:
            continue

        cand_color = normalize_key(cand.get("color") or "Standard") or "standard"
        # If both specify distinct non-standard colors (e.g. Red vs Black), keep colors separate
        if src_color != cand_color and src_color not in ("", "standard") and cand_color not in ("", "standard"):
            continue

        total_score = model_score
        if cand["category_id"] == dst_cat_id:
            total_score += 30
        if src_color == cand_color:
            total_score += 20
        if src_series and normalize_key(cand.get("series") or "") == src_series:
            total_score += 10
        if src_size and normalize_key(cand.get("size") or "") == src_size:
            total_score += 5

        scored_matches.append((total_score, cand))

    if not scored_matches:
        return None

    scored_matches.sort(key=lambda item: (-item[0], item[1]["id"]))
    return scored_matches[0][1]


@app.post("/api/branch-transfers")
def execute_branch_transfer(
    payload: InterBranchTransferPayload,
    request: Request,
    current_user: Annotated[dict, Depends(require_ready_user)],
):
    _ensure_branch_transfers_table()
    if payload.quantity <= 0:
        raise HTTPException(status_code=400, detail="Transfer quantity must be at least 1 unit.")

    src_prod = fetch_one(
        """
        SELECT p.*, c.name AS category_name, c.icon AS category_icon, l.name AS location_name
        FROM products p
        JOIN categories c ON c.id = p.category_id AND c.branch_id = p.branch_id
        LEFT JOIN locations l ON l.id = p.location_id AND l.branch_id = p.branch_id
        WHERE p.id = ?
        """,
        (payload.product_id,),
    )
    if not src_prod:
        raise HTTPException(status_code=404, detail="Source product not found.")

    from_branch_id = int(src_prod["branch_id"])
    if from_branch_id == payload.to_branch_id:
        raise HTTPException(status_code=400, detail="Source and destination branch cannot be the same.")

    src_branch = _branch_exists(from_branch_id)
    dst_branch = _branch_exists(payload.to_branch_id)

    snapshot = get_product_stock_snapshot(payload.product_id)
    available = float(snapshot.get("current_stock") or 0)
    if payload.quantity > available:
        raise HTTPException(status_code=400, detail=f"Cannot transfer {payload.quantity} units. Only {int(available)} available in {src_branch['name']}.")

    now_str = now_iso()
    today_str = datetime.utcnow().date().isoformat()
    cost_price = float(src_prod.get("default_purchase_price") or 0)
    sale_price = float(src_prod.get("default_sale_price") or 0)

    # 1. Ensure Category exists in target branch (case/plural-insensitive matching)
    src_cat_key = normalize_key(src_prod["category_name"]).rstrip("s")
    dst_categories = fetch_all("SELECT * FROM categories WHERE branch_id = ?", (payload.to_branch_id,))
    dst_cat = next(
        (c for c in dst_categories if normalize_key(c["name"]).rstrip("s") == src_cat_key),
        None,
    )
    if not dst_cat:
        dst_cat_id = execute(
            "INSERT INTO categories (branch_id, name, name_key, icon, description, image_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (payload.to_branch_id, src_prod["category_name"], normalize_key(src_prod["category_name"]), src_prod.get("category_icon") or "📦", "", "", now_str, now_str)
        )
        dst_cat_name = src_prod["category_name"]
    else:
        dst_cat_id = dst_cat["id"]
        dst_cat_name = dst_cat["name"]

    # 2. Intelligently match or create Company in destination branch (e.g. Bouns <-> bouns)
    resolved_company = _resolve_destination_company(payload.to_branch_id, src_prod.get("company") or "", now_str)

    # 3. Intelligently match existing Product Variant in destination branch (e.g. RP-134 <-> 134)
    dst_prod = _find_matching_destination_product(payload.to_branch_id, dst_cat_id, src_prod, resolved_company)

    if dst_prod:
        dst_pid = dst_prod["id"]
        target_model_name = dst_prod["model"]
        target_company_name = dst_prod["company"]
    else:
        target_model_name = src_prod["model"]
        target_company_name = resolved_company
        # Check if catalog_models in destination branch already has an equivalent model
        existing_cat_models = fetch_all(
            "SELECT * FROM catalog_models WHERE branch_id = ? AND category_key = ?",
            (payload.to_branch_id, normalize_key(dst_cat_name)),
        )
        matched_catalog = next(
            (
                cm for cm in existing_cat_models
                if _companies_are_equivalent(cm.get("company"), resolved_company)
                and _models_are_equivalent(src_prod.get("model"), cm.get("model"))[0]
            ),
            None,
        )
        if matched_catalog:
            target_model_name = matched_catalog["model"]
            target_company_name = matched_catalog["company"]
        else:
            execute(
                """
                INSERT OR IGNORE INTO catalog_models (
                    branch_id, company, company_key, category_name, category_key, series, series_key, model, model_key,
                    default_price, source_document, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'branch_transfer', ?, ?)
                """,
                (
                    payload.to_branch_id,
                    target_company_name,
                    normalize_key(target_company_name),
                    dst_cat_name,
                    normalize_key(dst_cat_name),
                    src_prod.get("series") or "",
                    normalize_key(src_prod.get("series") or ""),
                    target_model_name,
                    normalize_key(target_model_name),
                    sale_price or cost_price,
                    now_str,
                    now_str,
                ),
            )

        dst_pid = execute(
            """
            INSERT INTO products (
                branch_id, category_id, location_id, series, model, company, color, size, image_path, min_stock,
                default_purchase_price, default_sale_price, notes, active, created_at, updated_at
            ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (
                payload.to_branch_id,
                dst_cat_id,
                matched_catalog["series"] if matched_catalog else (src_prod.get("series") or ""),
                target_model_name,
                target_company_name,
                src_prod.get("color") or "Standard",
                src_prod.get("size") or "",
                src_prod.get("image_path") or "",
                src_prod.get("min_stock") or 0,
                cost_price,
                sale_price,
                src_prod.get("notes") or "",
                now_str,
                now_str,
            ),
        )

    ref_no = f"TR-{today_str.replace('-', '')}-{uuid4().hex[:6].upper()}"

    with get_db_cursor(commit=True) as (_, cursor):
        # 1. Deduct stock from source branch
        cursor.execute(
            """
            INSERT INTO sale_entries (
                branch_id, product_id, invoice_id, quantity, unit_price, unit_cost_at_sale, total_profit,
                sale_date, transaction_at, customer_name, customer_phone, reference_no, notes, created_at, updated_at
            ) VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?, ?, '', ?, ?, ?, ?)
            """,
            (
                from_branch_id,
                src_prod["id"],
                payload.quantity,
                cost_price,
                cost_price,
                today_str,
                now_str,
                f"Branch Transfer -> {dst_branch['name']}",
                ref_no,
                f"Transferred to {dst_branch['name']} (Matched: {target_company_name} {target_model_name}). {payload.notes}".strip(),
                now_str,
                now_str,
            ),
        )

        # 2. Add stock to destination branch
        cursor.execute(
            """
            INSERT INTO purchase_entries (
                branch_id, product_id, quantity, unit_cost, purchase_date, supplier_name,
                supplier_phone, reference_no, notes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)
            """,
            (
                payload.to_branch_id,
                dst_pid,
                payload.quantity,
                cost_price,
                today_str,
                f"Branch Transfer <- {src_branch['name']}",
                ref_no,
                f"Received from {src_branch['name']} (Source: {src_prod['company']} {src_prod['model']}). {payload.notes}".strip(),
                now_str,
                now_str,
            ),
        )

        # 3. Log permanent inter-branch transfer record
        cursor.execute(
            """
            INSERT INTO branch_transfers (
                from_branch_id, to_branch_id, from_product_id, to_product_id, company, category_name,
                series, model, color, size, quantity, unit_cost, reference_no, transfer_date, transfer_at,
                notes, username, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                from_branch_id,
                payload.to_branch_id,
                src_prod["id"],
                dst_pid,
                target_company_name,
                dst_cat_name,
                src_prod["series"] or "",
                target_model_name,
                src_prod["color"] or "Standard",
                src_prod["size"] or "",
                payload.quantity,
                cost_price,
                ref_no,
                today_str,
                now_str,
                payload.notes.strip(),
                current_user["username"],
                now_str,
            ),
        )

    recalculate_sale_costs(src_prod["id"])
    recalculate_sale_costs(dst_pid)

    log_activity(current_user["username"], "branch_transfer", "dispatched", f"Transferred {payload.quantity} units of {src_prod['company']} {src_prod['model']} to {dst_branch['name']} (mapped to {target_company_name} {target_model_name}).", branch_id=from_branch_id)
    log_activity(current_user["username"], "branch_transfer", "received", f"Received {payload.quantity} units of {target_company_name} {target_model_name} from {src_branch['name']}.", branch_id=payload.to_branch_id)

    return {
        "message": f"Successfully transferred {payload.quantity} unit(s) of '{src_prod['company']} {src_prod['model']}' from {src_branch['name']} to {dst_branch['name']} (Matched to '{target_company_name} {target_model_name}').",
        "reference_no": ref_no,
        "matched_company": target_company_name,
        "matched_model": target_model_name,
        "destination_product_id": dst_pid,
    }