from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

try:
    from dotenv import load_dotenv  # type: ignore[import-not-found]
except ImportError:
    load_dotenv = None

try:
    import psycopg2  # type: ignore[import-untyped]
    import psycopg2.extras  # type: ignore[import-untyped]
    import psycopg2.pool  # type: ignore[import-untyped]
except ImportError:
    psycopg2 = None

from .runtime_paths import catalog_seed_path, ensure_persistent_db, persistent_data_dir

logger = logging.getLogger("malik_db")

BASE_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BASE_DIR.parent


def _load_env_files() -> None:
    for env_candidate in (PROJECT_ROOT / ".env", BASE_DIR / ".env"):
        if not env_candidate.exists():
            continue
        if load_dotenv is not None:
            load_dotenv(dotenv_path=env_candidate, override=False)
        for line in env_candidate.read_text(encoding="utf-8", errors="ignore").splitlines():
            clean = line.strip()
            if not clean or clean.startswith("#") or "=" not in clean:
                continue
            k, v = clean.split("=", 1)
            k = k.strip()
            v = v.strip().strip("'").strip('"')
            if k and k not in os.environ:
                os.environ[k] = v


_load_env_files()

DATA_DIR = persistent_data_dir()
DATA_DIR.mkdir(parents=True, exist_ok=True)
CATALOG_SEED_PATH = catalog_seed_path()


def _clean_postgres_dsn(raw_url: str) -> str:
    url = (raw_url or "").strip().strip("'").strip('"')
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    parsed = urlparse(url)
    query_params = [(k, v) for k, v in parse_qsl(parsed.query) if k.lower() != "channel_binding"]
    if not any(k.lower() == "sslmode" for k, _ in query_params):
        query_params.append(("sslmode", "require"))
    return urlunparse(parsed._replace(query=urlencode(query_params)))


RAW_DATABASE_URL = (
    os.getenv("DATABASE_URL")
    or os.getenv("POSTGRES_URL")
    or os.getenv("NEON_DATABASE_URL")
    or ""
).strip()

USE_POSTGRES = bool(RAW_DATABASE_URL)
POSTGRES_DSN = _clean_postgres_dsn(RAW_DATABASE_URL) if USE_POSTGRES else ""
DB_PATH = (DATA_DIR / "malik_electronic_pro_v4.db") if USE_POSTGRES else ensure_persistent_db()

# High-speed read-through cache (automatically invalidated on any INSERT/UPDATE/DELETE)
_QUERY_CACHE: dict[tuple[str, tuple[Any, ...]], tuple[float, list[dict[str, Any]]]] = {}
_CACHE_TTL_SECONDS = 300.0


def invalidate_query_cache() -> None:
    _QUERY_CACHE.clear()


DEFAULT_CATEGORIES = [
    ("Refrigerators", "🧊", "Single door, double door, inverter and premium refrigerator lines"),
    ("Deep Freezers", "🧺", "Single door, inverter, vertical and convertible freezer lines"),
    ("Air Conditioners", "❄️", "Split, inverter, T3 and premium residential AC lines"),
    ("Commercial Air Conditioners", "🏢", "Commercial and floor standing AC units"),
    ("Washing Machines", "🫧", "Semi automatic, spinner and standard washing machine lines"),
    ("Automatic Washing Machines", "🌀", "Top load and front load automatic washing machine lines"),
    ("Air Coolers", "🌬️", "Room coolers, desert coolers and portable air coolers"),
    ("Heaters", "🔥", "Electric, fan and infrared heaters"),
    ("LED TVs", "📺", "Smart TVs, QLED, OLED and LED screen lines"),
    ("Microwave Ovens", "🍲", "Solo, grill, convection and air fryer microwave lines"),
    ("Kitchen Appliances", "🍳", "Hobs, hoods, built in appliances and kitchen electronics"),
    ("Built-in Ovens", "🧁", "Built in full electric and premium oven lines"),
    ("Built-in Microwave Ovens", "🥘", "Built in and premium microwave oven lines"),
    ("Kitchen Hoods", "🌫️", "Kitchen hood lines"),
    ("Kitchen Hobs", "🍽️", "Gas hob and built in hob lines"),
    ("Dishwashers", "🧼", "Dishwasher lines"),
    ("Water Dispensers", "💧", "Water dispenser and glass door dispenser lines"),
    ("Room Coolers", "🧊", "Local room cooler lines"),
    ("Juicer Machines", "🥤", "Juicer and blender lines"),
]

DEFAULT_LOCATIONS: list[tuple[str, str]] = []
DEFAULT_COMPANIES = ["Dawlance", "Haier", "Super Asia", "Bonus", "Local Machines"]

TABLES_WITH_SERIAL_ID = {
    "branches",
    "users",
    "categories",
    "locations",
    "companies",
    "products",
    "purchase_entries",
    "invoices",
    "sale_entries",
    "invoice_items",
    "discount_rules",
    "account_transactions",
    "activity_logs",
    "catalog_models",
    "branch_transfers",
}


class HybridRow(dict):
    """Row object supporting both dict lookup (row['id']) and tuple index lookup (row[0])."""

    def __init__(self, columns: list[str], values: tuple[Any, ...]):
        super().__init__(zip(columns, values))
        self._values = values

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, int):
            return self._values[key]
        return super().__getitem__(key)


def translate_sqlite_to_postgres(sql: str, has_params: bool = False) -> tuple[str, bool]:
    q = sql.strip()
    q = re.sub(r"\bifnull\s*\(", "COALESCE(", q, flags=re.IGNORECASE)
    q = re.sub(r"\bNOT\s+LIKE\b", "NOT ILIKE", q, flags=re.IGNORECASE)
    q = re.sub(r"\bLIKE\b", "ILIKE", q, flags=re.IGNORECASE)

    if re.search(r"INSERT\s+OR\s+REPLACE\s+INTO\s+app_settings", q, flags=re.IGNORECASE):
        q = re.sub(r"INSERT\s+OR\s+REPLACE\s+INTO", "INSERT INTO", q, flags=re.IGNORECASE)
        q = q.rstrip().rstrip(";")
        q += " ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at"

    is_ignore = False
    if re.search(r"INSERT\s+OR\s+IGNORE\s+INTO", q, flags=re.IGNORECASE):
        q = re.sub(r"INSERT\s+OR\s+IGNORE\s+INTO", "INSERT INTO", q, flags=re.IGNORECASE)
        is_ignore = True

    q = re.sub(
        r"INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT",
        "SERIAL PRIMARY KEY",
        q,
        flags=re.IGNORECASE,
    )

    out_chars: list[str] = []
    in_single_quote = False
    i = 0
    n = len(q)
    while i < n:
        ch = q[i]
        if ch == "'":
            out_chars.append(ch)
            if in_single_quote and i + 1 < n and q[i + 1] == "'":
                out_chars.append(q[i + 1])
                i += 2
                continue
            in_single_quote = not in_single_quote
        elif ch == "%" and has_params:
            out_chars.append("%%")
        elif ch == "?" and not in_single_quote:
            out_chars.append("%s")
        else:
            out_chars.append(ch)
        i += 1

    translated = "".join(out_chars)
    if is_ignore and "ON CONFLICT" not in translated.upper():
        translated = translated.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"

    return translated, is_ignore


class PostgresCursorWrapper:
    def __init__(self, raw_cursor):
        self._cur = raw_cursor
        self.lastrowid: int | None = None

    def execute(self, query: str, params: Iterable[Any] | tuple[Any, ...] = ()):
        q_clean = query.strip()
        if not q_clean or q_clean.upper().startswith("PRAGMA"):
            return self

        param_tuple = tuple(params) if params else ()
        has_params = len(param_tuple) > 0
        pg_sql, _ = translate_sqlite_to_postgres(q_clean, has_params=has_params)

        if not pg_sql.lstrip().upper().startswith("SELECT"):
            invalidate_query_cache()

        m_ins = re.match(r"^\s*INSERT\s+INTO\s+([a-zA-Z0-9_]+)", pg_sql, flags=re.IGNORECASE)
        auto_returning = False
        if m_ins:
            tbl = m_ins.group(1).lower()
            if tbl in TABLES_WITH_SERIAL_ID and "RETURNING " not in pg_sql.upper():
                pg_sql = pg_sql.rstrip().rstrip(";") + " RETURNING id"
                auto_returning = True

        if has_params:
            self._cur.execute(pg_sql, param_tuple)
        else:
            self._cur.execute(pg_sql)

        if auto_returning:
            row = self._cur.fetchone()
            self.lastrowid = int(row[0]) if row and row[0] is not None else None
        return self

    def executescript(self, script: str):
        invalidate_query_cache()
        statements = [s.strip() for s in script.split(";") if s.strip()]
        for stmt in statements:
            self.execute(stmt)
        return self

    def fetchone(self) -> HybridRow | None:
        if not self._cur.description:
            return None
        row = self._cur.fetchone()
        if row is None:
            return None
        cols = [col.name for col in self._cur.description]
        return HybridRow(cols, tuple(row))

    def fetchall(self) -> list[HybridRow]:
        if not self._cur.description:
            return []
        rows = self._cur.fetchall()
        cols = [col.name for col in self._cur.description]
        return [HybridRow(cols, tuple(r)) for r in rows]

    def close(self):
        self._cur.close()


def now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat()


def normalize_key(value: str) -> str:
    return " ".join((value or "").strip().lower().split())


def dict_from_row(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    if isinstance(row, dict):
        return dict(row)
    return {key: row[key] for key in row.keys()}


_PG_POOL: Any = None


def _get_pg_pool():
    global _PG_POOL
    if psycopg2 is None:
        raise RuntimeError("psycopg2-binary is required for Neon PostgreSQL.")
    if _PG_POOL is None:
        _PG_POOL = psycopg2.pool.ThreadedConnectionPool(
            minconn=2,
            maxconn=16,
            dsn=POSTGRES_DSN,
            connect_timeout=15,
            keepalives=1,
            keepalives_idle=30,
            keepalives_interval=10,
            keepalives_count=5,
        )
    return _PG_POOL


def get_connection():
    if USE_POSTGRES:
        pool = _get_pg_pool()
        conn = pool.getconn()
        if getattr(conn, "closed", 0) != 0:
            try:
                pool.putconn(conn, close=True)
            except Exception:
                pass
            conn = psycopg2.connect(POSTGRES_DSN, connect_timeout=15)
        return conn

    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    return conn


@contextmanager
def get_db_cursor(commit: bool = False):
    if USE_POSTGRES:
        if commit:
            invalidate_query_cache()
        pool = _get_pg_pool()
        conn = get_connection()
        raw_cur = None
        wrapped_cur = None
        try:
            raw_cur = conn.cursor()
            wrapped_cur = PostgresCursorWrapper(raw_cur)
            yield conn, wrapped_cur
            if commit:
                conn.commit()
        except (psycopg2.OperationalError, psycopg2.InterfaceError):
            try:
                pool.putconn(conn, close=True)
            except Exception:
                pass
            conn = psycopg2.connect(POSTGRES_DSN, connect_timeout=15)
            raw_cur = conn.cursor()
            wrapped_cur = PostgresCursorWrapper(raw_cur)
            yield conn, wrapped_cur
            if commit:
                conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            if wrapped_cur is not None:
                try:
                    wrapped_cur.close()
                except Exception:
                    pass
            try:
                pool.putconn(conn)
            except Exception:
                try:
                    conn.close()
                except Exception:
                    pass
    else:
        conn = get_connection()
        try:
            cursor = conn.cursor()
            yield conn, cursor
            if commit:
                conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def fetch_one(query: str, params: Iterable[Any] | tuple[Any, ...] = ()) -> dict[str, Any] | None:
    param_tuple = tuple(params) if params else ()
    q_clean = query.strip()
    is_select = q_clean.upper().startswith("SELECT")
    cache_key = (q_clean, param_tuple)

    if is_select and cache_key in _QUERY_CACHE:
        ts, rows = _QUERY_CACHE[cache_key]
        if (time.time() - ts) <= _CACHE_TTL_SECONDS:
            return dict(rows[0]) if rows else None

    with get_db_cursor() as (_, cursor):
        cursor.execute(q_clean, param_tuple)
        res = dict_from_row(cursor.fetchone())

    if is_select:
        _QUERY_CACHE[cache_key] = (time.time(), [dict(res)] if res else [])
    return res


def fetch_all(query: str, params: Iterable[Any] | tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    param_tuple = tuple(params) if params else ()
    q_clean = query.strip()
    is_select = q_clean.upper().startswith("SELECT")
    cache_key = (q_clean, param_tuple)

    if is_select and cache_key in _QUERY_CACHE:
        ts, rows = _QUERY_CACHE[cache_key]
        if (time.time() - ts) <= _CACHE_TTL_SECONDS:
            return [dict(r) for r in rows]

    with get_db_cursor() as (_, cursor):
        cursor.execute(q_clean, param_tuple)
        rows = [dict_from_row(row) for row in cursor.fetchall() if row is not None]

    if is_select:
        _QUERY_CACHE[cache_key] = (time.time(), [dict(r) for r in rows])
    return rows


def execute(query: str, params: Iterable[Any] | tuple[Any, ...] = ()) -> int:
    invalidate_query_cache()
    with get_db_cursor(commit=True) as (_, cursor):
        cursor.execute(query, tuple(params))
        return int(cursor.lastrowid or 0)


def _table_columns(table_name: str) -> set[str]:
    if USE_POSTGRES:
        rows = fetch_all(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?",
            (table_name.lower(),),
        )
        return {r["column_name"] for r in rows}
    with get_db_cursor() as (_, cursor):
        cursor.execute(f"PRAGMA table_info({table_name})")
        return {row[1] for row in cursor.fetchall()}


def _ensure_column(table_name: str, column_name: str, definition_sql: str) -> None:
    if column_name in _table_columns(table_name):
        return
    with get_db_cursor(commit=True) as (_, cursor):
        cursor.execute(f"ALTER TABLE {table_name} ADD COLUMN {definition_sql}")


POSTGRES_ROUND_FUNCTION_SQL = """
CREATE OR REPLACE FUNCTION round(double precision, integer)
RETURNS double precision AS $$
    SELECT ROUND($1::numeric, $2)::double precision;
$$ LANGUAGE SQL IMMUTABLE;
"""

POSTGRES_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS branches (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    address TEXT DEFAULT '',
    description TEXT DEFAULT '',
    image_path TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '📦',
    description TEXT DEFAULT '',
    image_path TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(branch_id, name_key)
);

CREATE TABLE IF NOT EXISTS locations (
    id SERIAL PRIMARY KEY,
    branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(branch_id, name_key)
);

CREATE TABLE IF NOT EXISTS companies (
    id SERIAL PRIMARY KEY,
    branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    image_path TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(branch_id, name_key)
);

CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
    series TEXT DEFAULT '',
    model TEXT NOT NULL,
    company TEXT DEFAULT '',
    color TEXT DEFAULT '',
    size TEXT DEFAULT '',
    image_path TEXT DEFAULT '',
    min_stock INTEGER NOT NULL DEFAULT 0,
    default_purchase_price DOUBLE PRECISION NOT NULL DEFAULT 0,
    default_sale_price DOUBLE PRECISION NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_entries (
    id SERIAL PRIMARY KEY,
    branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL,
    unit_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
    purchase_date TEXT NOT NULL,
    supplier_name TEXT DEFAULT '',
    supplier_phone TEXT DEFAULT '',
    reference_no TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
    id SERIAL PRIMARY KEY,
    branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id) ON DELETE CASCADE,
    invoice_number TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    phone_number TEXT DEFAULT '',
    address TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Paid',
    subtotal DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
    invoice_date TEXT NOT NULL,
    transaction_at TEXT DEFAULT '',
    sale_signature TEXT DEFAULT '',
    pdf_path TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    discount_name TEXT DEFAULT '',
    discount_type TEXT DEFAULT 'fixed',
    discount_value DOUBLE PRECISION NOT NULL DEFAULT 0,
    discount_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(branch_id, invoice_number)
);

CREATE TABLE IF NOT EXISTS sale_entries (
    id SERIAL PRIMARY KEY,
    branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    quantity INTEGER NOT NULL,
    unit_price DOUBLE PRECISION NOT NULL DEFAULT 0,
    unit_cost_at_sale DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_profit DOUBLE PRECISION NOT NULL DEFAULT 0,
    sale_date TEXT NOT NULL,
    transaction_at TEXT DEFAULT '',
    customer_name TEXT DEFAULT '',
    customer_phone TEXT DEFAULT '',
    reference_no TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_items (
    id SERIAL PRIMARY KEY,
    branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id) ON DELETE CASCADE,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    sale_entry_id INTEGER REFERENCES sale_entries(id) ON DELETE SET NULL,
    quantity INTEGER NOT NULL,
    unit_price DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_price DOUBLE PRECISION NOT NULL DEFAULT 0,
    base_unit_price DOUBLE PRECISION NOT NULL DEFAULT 0,
    discount_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discount_rules (
    id SERIAL PRIMARY KEY,
    branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    discount_type TEXT NOT NULL DEFAULT 'fixed',
    discount_value DOUBLE PRECISION NOT NULL DEFAULT 0,
    description TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(branch_id, name_key)
);

CREATE TABLE IF NOT EXISTS account_transactions (
    id SERIAL PRIMARY KEY,
    branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id) ON DELETE CASCADE,
    transaction_date TEXT NOT NULL,
    transaction_at TEXT DEFAULT '',
    transaction_type TEXT NOT NULL,
    direction TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Recorded',
    party_name TEXT DEFAULT '',
    party_phone TEXT DEFAULT '',
    description TEXT DEFAULT '',
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    purchase_id INTEGER REFERENCES purchase_entries(id) ON DELETE SET NULL,
    sale_id INTEGER REFERENCES sale_entries(id) ON DELETE SET NULL,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_logs (
    id SERIAL PRIMARY KEY,
    branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    action TEXT NOT NULL,
    details TEXT NOT NULL,
    username TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog_models (
    id SERIAL PRIMARY KEY,
    branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id) ON DELETE CASCADE,
    company TEXT NOT NULL,
    company_key TEXT NOT NULL,
    category_name TEXT NOT NULL,
    category_key TEXT NOT NULL,
    series TEXT DEFAULT '',
    series_key TEXT DEFAULT '',
    model TEXT NOT NULL,
    model_key TEXT NOT NULL,
    default_price DOUBLE PRECISION NOT NULL DEFAULT 0,
    source_document TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(branch_id, company_key, category_key, series_key, model_key)
);

CREATE TABLE IF NOT EXISTS branch_transfers (
    id SERIAL PRIMARY KEY,
    from_branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    to_branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    from_product_id INTEGER NOT NULL,
    to_product_id INTEGER,
    company TEXT NOT NULL,
    category_name TEXT NOT NULL,
    series TEXT DEFAULT '',
    model TEXT NOT NULL,
    color TEXT DEFAULT '',
    size TEXT DEFAULT '',
    quantity INTEGER NOT NULL,
    unit_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
    reference_no TEXT NOT NULL,
    transfer_date TEXT NOT NULL,
    transfer_at TEXT NOT NULL,
    notes TEXT DEFAULT '',
    username TEXT DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(branch_id, category_id);
CREATE INDEX IF NOT EXISTS idx_products_location ON products(branch_id, location_id);
CREATE INDEX IF NOT EXISTS idx_products_company_model ON products(branch_id, company, series, model);
CREATE INDEX IF NOT EXISTS idx_purchase_product_date ON purchase_entries(branch_id, product_id, purchase_date);
CREATE INDEX IF NOT EXISTS idx_sale_product_date ON sale_entries(branch_id, product_id, sale_date);
CREATE INDEX IF NOT EXISTS idx_invoice_date ON invoices(branch_id, invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoice_signature ON invoices(branch_id, sale_signature);
CREATE INDEX IF NOT EXISTS idx_account_date ON account_transactions(branch_id, transaction_date);
CREATE INDEX IF NOT EXISTS idx_activity_date ON activity_logs(branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_catalog_lookup ON catalog_models(branch_id, company_key, category_key, series_key, model_key);
CREATE INDEX IF NOT EXISTS idx_bt_from ON branch_transfers(from_branch_id);
CREATE INDEX IF NOT EXISTS idx_bt_to ON branch_transfers(to_branch_id);
"""


def initialize_database() -> None:
    if USE_POSTGRES:
        with get_db_cursor(commit=True) as (raw_conn, cursor):
            with raw_conn.cursor() as raw_cur:
                raw_cur.execute(POSTGRES_ROUND_FUNCTION_SQL)
            branch_count = 0
            try:
                branch_count = int(cursor.execute("SELECT COUNT(*) FROM branches").fetchone()[0] or 0)
            except Exception:
                cursor.executescript(POSTGRES_SCHEMA_SQL)
                branch_count = int(cursor.execute("SELECT COUNT(*) FROM branches").fetchone()[0] or 0)

            if branch_count == 0:
                cursor.executescript(POSTGRES_SCHEMA_SQL)
                current_time = now_iso()
                cursor.execute(
                    """
                    INSERT INTO branches (id, name, name_key, address, created_at, updated_at) VALUES
                    (1, 'Talagang City', 'talagang-city', 'Talagang, Punjab', ?, ?),
                    (2, 'Multan Khurd', 'multan-khurd', 'Multan Khurd, Punjab', ?, ?)
                    ON CONFLICT (id) DO NOTHING
                    """,
                    (current_time, current_time, current_time, current_time),
                )
        logger.info("Connected permanently to Neon PostgreSQL database.")
        return

    with get_db_cursor(commit=True) as (_, cursor):
        cursor.executescript(POSTGRES_SCHEMA_SQL.replace("SERIAL PRIMARY KEY", "INTEGER PRIMARY KEY AUTOINCREMENT").replace("DOUBLE PRECISION", "REAL"))
        branch_count = cursor.execute("SELECT COUNT(*) FROM branches").fetchone()[0]
        if branch_count == 0:
            current_time = now_iso()
            cursor.execute(
                """
                INSERT INTO branches (id, name, name_key, address, created_at, updated_at) VALUES 
                (1, 'Talagang City', 'talagang-city', 'Talagang, Punjab', ?, ?),
                (2, 'Multan Khurd', 'multan-khurd', 'Multan Khurd, Punjab', ?, ?)
                """,
                (current_time, current_time, current_time, current_time),
            )

    seed_defaults(branch_id=1)
    seed_catalog_models(branch_id=1)


def seed_defaults(branch_id: int = 1) -> None:
    current_time = now_iso()
    with get_db_cursor(commit=True) as (_, cursor):
        category_seeded = cursor.execute(
            "SELECT value FROM app_settings WHERE key = 'defaults_seeded_categories_v1'"
        ).fetchone()
        if category_seeded is None:
            existing_count = int(cursor.execute("SELECT COUNT(*) FROM categories WHERE branch_id = ?", (branch_id,)).fetchone()[0] or 0)
            if existing_count == 0:
                for name, icon, description in DEFAULT_CATEGORIES:
                    cursor.execute(
                        """
                        INSERT OR IGNORE INTO categories (branch_id, name, name_key, icon, description, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (branch_id, name, normalize_key(name), icon, description, current_time, current_time),
                    )
            cursor.execute(
                "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
                ("defaults_seeded_categories_v1", "1", current_time),
            )

        location_seeded = cursor.execute(
            "SELECT value FROM app_settings WHERE key = 'defaults_seeded_locations_v1'"
        ).fetchone()
        if location_seeded is None:
            existing_count = int(cursor.execute("SELECT COUNT(*) FROM locations WHERE branch_id = ?", (branch_id,)).fetchone()[0] or 0)
            if existing_count == 0:
                for name, description in DEFAULT_LOCATIONS:
                    cursor.execute(
                        """
                        INSERT OR IGNORE INTO locations (branch_id, name, name_key, description, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (branch_id, name, normalize_key(name), description, current_time, current_time),
                    )
            cursor.execute(
                "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
                ("defaults_seeded_locations_v1", "1", current_time),
            )

        company_count = int(cursor.execute("SELECT COUNT(*) FROM companies WHERE branch_id = ?", (branch_id,)).fetchone()[0] or 0)
        if company_count == 0:
            for company in DEFAULT_COMPANIES:
                cursor.execute(
                    """
                    INSERT OR IGNORE INTO companies (branch_id, name, name_key, image_path, created_at, updated_at)
                    VALUES (?, ?, ?, '', ?, ?)
                    """,
                    (branch_id, company, normalize_key(company), current_time, current_time),
                )


def seed_catalog_models(branch_id: int = 1) -> None:
    if not CATALOG_SEED_PATH.exists():
        return
    try:
        payload = json.loads(CATALOG_SEED_PATH.read_text())
    except Exception:
        return
    current_time = now_iso()
    with get_db_cursor(commit=True) as (_, cursor):
        catalog_seeded = cursor.execute(
            "SELECT value FROM app_settings WHERE key = 'catalog_models_seeded_v3'"
        ).fetchone()
        if catalog_seeded is not None:
            return

        seed_companies = sorted({str(item.get("company") or "").strip() for item in payload if str(item.get("company") or "").strip()})
        for company in seed_companies:
            cursor.execute(
                "INSERT OR IGNORE INTO companies (branch_id, name, name_key, image_path, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)",
                (branch_id, company, normalize_key(company), current_time, current_time),
            )

        if seed_companies:
            placeholders = ",".join("?" for _ in seed_companies)
            cursor.execute(f"DELETE FROM catalog_models WHERE branch_id = {branch_id} AND company IN ({placeholders})", tuple(seed_companies))

        for item in payload:
            company = str(item.get("company") or "").strip()
            category_name = str(item.get("category") or "").strip()
            series = str(item.get("series") or "").strip()
            model = str(item.get("model") or "").strip()
            price = float(item.get("price") or 0)
            source_document = str(item.get("source_document") or "catalog seed").strip() or "catalog seed"
            if not company or not category_name or not model:
                continue
            cursor.execute(
                """
                INSERT OR IGNORE INTO catalog_models (
                    branch_id, company, company_key, category_name, category_key, series, series_key,
                    model, model_key, default_price, source_document, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    branch_id,
                    company,
                    normalize_key(company),
                    category_name,
                    normalize_key(category_name),
                    series,
                    normalize_key(series),
                    model,
                    normalize_key(model),
                    price,
                    source_document,
                    current_time,
                    current_time,
                ),
            )
        cursor.execute(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
            ("catalog_models_seeded_v3", "1", current_time),
        )


def log_activity(username: str, entity_type: str, action: str, details: str, entity_id: int | None = None, branch_id: int = 1) -> None:
    execute(
        """
        INSERT INTO activity_logs (branch_id, entity_type, entity_id, action, details, username, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (branch_id, entity_type, entity_id, action, details, username, now_iso()),
    )


def get_product_stock_snapshot(product_id: int) -> dict[str, float]:
    purchase = fetch_one(
        "SELECT COALESCE(SUM(quantity), 0) AS qty, COALESCE(SUM(quantity * unit_cost), 0) AS value FROM purchase_entries WHERE product_id = ?",
        (product_id,),
    ) or {"qty": 0, "value": 0}
    sales = fetch_one(
        """
        SELECT COALESCE(SUM(se.quantity), 0) AS qty,
               ROUND(CAST(COALESCE(SUM(COALESCE(ii.total_price, se.quantity * se.unit_price)), 0) AS NUMERIC), 2) AS revenue,
               ROUND(CAST(COALESCE(SUM(se.total_profit), 0) AS NUMERIC), 2) AS profit
        FROM sale_entries se
        LEFT JOIN invoice_items ii ON ii.sale_entry_id = se.id
        WHERE se.product_id = ?
        """,
        (product_id,),
    ) or {"qty": 0, "revenue": 0, "profit": 0}
    purchased_qty = float(purchase.get("qty") or 0)
    purchased_value = float(purchase.get("value") or 0)
    sold_qty = float(sales.get("qty") or 0)
    avg_cost = purchased_value / purchased_qty if purchased_qty else 0.0
    current_stock = max(0.0, purchased_qty - sold_qty)
    return {
        "purchased_qty": purchased_qty,
        "purchased_value": purchased_value,
        "sold_qty": sold_qty,
        "sale_revenue": float(sales.get("revenue") or 0),
        "gross_profit": float(sales.get("profit") or 0),
        "average_unit_cost": avg_cost,
        "current_stock": current_stock,
        "current_stock_value": current_stock * avg_cost,
    }


def recalculate_sale_costs(product_id: int) -> None:
    purchases = fetch_all(
        "SELECT quantity, unit_cost, purchase_date FROM purchase_entries WHERE product_id = ? ORDER BY purchase_date ASC, id ASC",
        (product_id,),
    )
    sales = fetch_all(
        """
        SELECT se.id, se.quantity, se.unit_price, se.sale_date,
               COALESCE(ii.total_price, se.quantity * se.unit_price) AS sale_revenue
        FROM sale_entries se
        LEFT JOIN invoice_items ii ON ii.sale_entry_id = se.id
        WHERE se.product_id = ?
        ORDER BY se.sale_date ASC, se.id ASC
        """,
        (product_id,),
    )
    purchase_cursor = 0
    total_qty = 0.0
    total_value = 0.0
    with get_db_cursor(commit=True) as (_, cursor):
        for sale in sales:
            while purchase_cursor < len(purchases) and purchases[purchase_cursor]["purchase_date"] <= sale["sale_date"]:
                total_qty += float(purchases[purchase_cursor]["quantity"] or 0)
                total_value += float(purchases[purchase_cursor]["quantity"] or 0) * float(purchases[purchase_cursor]["unit_cost"] or 0)
                purchase_cursor += 1
            avg_cost = total_value / total_qty if total_qty else 0.0
            revenue = float(sale.get("sale_revenue") or (float(sale["unit_price"] or 0) * float(sale["quantity"] or 0)))
            profit = round(revenue - (avg_cost * float(sale["quantity"] or 0)), 2)
            cursor.execute(
                "UPDATE sale_entries SET unit_cost_at_sale = ?, total_profit = ?, updated_at = ? WHERE id = ?",
                (round(avg_cost, 2), profit, now_iso(), sale["id"]),
            )


def record_account_transaction(
    transaction_date: str,
    transaction_type: str,
    direction: str,
    amount: float,
    status: str,
    party_name: str,
    description: str,
    *,
    branch_id: int = 1,
    transaction_at: str | None = None,
    party_phone: str = "",
    category_id: int | None = None,
    product_id: int | None = None,
    purchase_id: int | None = None,
    sale_id: int | None = None,
    invoice_id: int | None = None,
) -> int:
    timestamp = now_iso()
    return execute(
        """
        INSERT INTO account_transactions (
            branch_id, transaction_date, transaction_at, transaction_type, direction, amount, status,
            party_name, party_phone, description, category_id, product_id,
            purchase_id, sale_id, invoice_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            branch_id,
            transaction_date,
            transaction_at or transaction_date,
            transaction_type,
            direction,
            amount,
            status,
            party_name.strip(),
            party_phone.strip(),
            description.strip(),
            category_id,
            product_id,
            purchase_id,
            sale_id,
            invoice_id,
            timestamp,
            timestamp,
        ),
    )