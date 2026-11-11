"""
MALIK ELECTRONIC ERP — COMPLETE SQLITE TO NEON POSTGRESQL MIGRATION & AUDIT UTILITY
"""

import json
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

try:
    from dotenv import load_dotenv  # type: ignore[import-not-found]
except ImportError:
    load_dotenv = None

import psycopg2  # type: ignore[import-untyped]
import psycopg2.extras  # type: ignore[import-untyped]

from backend.app.db import (
    POSTGRES_DSN,
    POSTGRES_ROUND_FUNCTION_SQL,
    POSTGRES_SCHEMA_SQL,
    TABLES_WITH_SERIAL_ID,
)

PROJECT_ROOT = Path(__file__).resolve().parent

if load_dotenv is not None and (PROJECT_ROOT / ".env").exists():
    load_dotenv(PROJECT_ROOT / ".env")

SQLITE_CANDIDATES = [
    PROJECT_ROOT / "backend" / "data" / "malik_electronic_pro_v4.db",
    PROJECT_ROOT / "data" / "malik_electronic_pro_v4.db",
]

MIGRATION_ORDER = [
    "branches",
    "users",
    "app_settings",
    "categories",
    "locations",
    "companies",
    "catalog_models",
    "products",
    "invoices",
    "purchase_entries",
    "sale_entries",
    "invoice_items",
    "discount_rules",
    "account_transactions",
    "activity_logs",
    "branch_transfers",
]


def find_sqlite_db() -> Path:
    for candidate in SQLITE_CANDIDATES:
        if candidate.exists():
            return candidate
    for found in PROJECT_ROOT.rglob("malik_electronic_pro_v4.db"):
        return found
    raise FileNotFoundError("Could not find local malik_electronic_pro_v4.db to migrate.")


def get_sqlite_metrics(sq_conn: sqlite3.Connection) -> dict:
    cur = sq_conn.cursor()
    existing_tables = {
        r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    counts = {}
    for tbl in MIGRATION_ORDER:
        if tbl in existing_tables:
            counts[tbl] = int(cur.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0] or 0)
        else:
            counts[tbl] = 0

    purch = cur.execute(
        "SELECT COALESCE(SUM(quantity), 0), ROUND(COALESCE(SUM(quantity * unit_cost), 0), 2) FROM purchase_entries"
    ).fetchone()
    inv = cur.execute(
        "SELECT ROUND(COALESCE(SUM(total_amount), 0), 2) FROM invoices"
    ).fetchone()
    sales = cur.execute(
        "SELECT COALESCE(SUM(quantity), 0), ROUND(COALESCE(SUM(total_profit), 0), 2) FROM sale_entries"
    ).fetchone()
    acct = cur.execute(
        "SELECT ROUND(COALESCE(SUM(amount), 0), 2) FROM account_transactions"
    ).fetchone()

    return {
        "counts": counts,
        "financials": {
            "total_purchased_units": int(purch[0] or 0),
            "total_purchase_spend": float(purch[1] or 0.0),
            "total_invoice_amount": float(inv[0] or 0.0),
            "total_sold_units": int(sales[0] or 0),
            "total_gross_profit": float(sales[1] or 0.0),
            "total_account_ledger_amount": float(acct[0] or 0.0),
        },
    }


def get_postgres_metrics(pg_conn) -> dict:
    cur = pg_conn.cursor()
    counts = {}
    for tbl in MIGRATION_ORDER:
        cur.execute(f"SELECT COUNT(*) FROM {tbl}")
        counts[tbl] = int(cur.fetchone()[0] or 0)

    cur.execute(
        "SELECT COALESCE(SUM(quantity), 0), ROUND(CAST(COALESCE(SUM(quantity * unit_cost), 0) AS NUMERIC), 2) FROM purchase_entries"
    )
    purch = cur.fetchone()

    cur.execute("SELECT ROUND(CAST(COALESCE(SUM(total_amount), 0) AS NUMERIC), 2) FROM invoices")
    inv = cur.fetchone()

    cur.execute(
        "SELECT COALESCE(SUM(quantity), 0), ROUND(CAST(COALESCE(SUM(total_profit), 0) AS NUMERIC), 2) FROM sale_entries"
    )
    sales = cur.fetchone()

    cur.execute("SELECT ROUND(CAST(COALESCE(SUM(amount), 0) AS NUMERIC), 2) FROM account_transactions")
    acct = cur.fetchone()

    return {
        "counts": counts,
        "financials": {
            "total_purchased_units": int(purch[0] or 0),
            "total_purchase_spend": float(purch[1] or 0.0),
            "total_invoice_amount": float(inv[0] or 0.0),
            "total_sold_units": int(sales[0] or 0),
            "total_gross_profit": float(sales[1] or 0.0),
            "total_account_ledger_amount": float(acct[0] or 0.0),
        },
    }


def run_migration():
    if not POSTGRES_DSN:
        raise RuntimeError("DATABASE_URL is not set in .env! Please add your Neon connection string to .env first.")

    sqlite_path = find_sqlite_db()
    print(f"[1/6] Found local SQLite database: {sqlite_path}")

    backup_dir = PROJECT_ROOT.parent / "Malik_Electronic_SQLite_Backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_file = backup_dir / f"malik_electronic_pro_v4_PRE_NEON_BACKUP_{ts}.db"
    shutil.copy2(str(sqlite_path), str(backup_file))
    print(f"[2/6] Created safe recoverable backup at: {backup_file}")

    sq_conn = sqlite3.connect(str(sqlite_path))
    sq_conn.row_factory = sqlite3.Row
    pre_metrics = get_sqlite_metrics(sq_conn)
    print("\n--- PRE-MIGRATION SQLITE SUMMARY ---")
    for tbl, cnt in pre_metrics["counts"].items():
        print(f"  {tbl:24s}: {cnt} rows")
    for k, v in pre_metrics["financials"].items():
        print(f"  {k:28s}: {v}")

    print("\n[3/6] Connecting to Neon PostgreSQL and creating schema...")
    pg_conn = psycopg2.connect(POSTGRES_DSN, connect_timeout=20)
    pg_cur = pg_conn.cursor()

    pg_cur.execute(POSTGRES_ROUND_FUNCTION_SQL)
    for stmt in [s.strip() for s in POSTGRES_SCHEMA_SQL.split(";") if s.strip()]:
        pg_cur.execute(stmt)
    pg_conn.commit()

    print("[4/6] Migrating all historical and current records to Neon PostgreSQL...")
    sq_cur = sq_conn.cursor()
    existing_sq_tables = {
        r[0] for r in sq_cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }

    try:
        for tbl in reversed(MIGRATION_ORDER):
            pg_cur.execute(f"TRUNCATE TABLE {tbl} RESTART IDENTITY CASCADE;")

        valid_ids: dict[str, set[int]] = {}

        for tbl in MIGRATION_ORDER:
            if tbl not in existing_sq_tables:
                valid_ids[tbl] = set()
                continue
            rows = sq_cur.execute(f"SELECT * FROM {tbl}").fetchall()
            if not rows:
                valid_ids[tbl] = set()
                continue

            cols = list(rows[0].keys())
            if "id" in cols:
                valid_ids[tbl] = {int(r["id"]) for r in rows if r["id"] is not None}

            cleaned_values = []
            for r in rows:
                d = dict(r)
                # Sanitize nullable foreign key references if an old parent record was deleted in SQLite
                if tbl == "products" and d.get("location_id") and d["location_id"] not in valid_ids.get("locations", set()):
                    d["location_id"] = None
                if tbl == "sale_entries" and d.get("invoice_id") and d["invoice_id"] not in valid_ids.get("invoices", set()):
                    d["invoice_id"] = None
                if tbl == "invoice_items" and d.get("sale_entry_id") and d["sale_entry_id"] not in valid_ids.get("sale_entries", set()):
                    d["sale_entry_id"] = None
                if tbl == "account_transactions":
                    if d.get("category_id") and d["category_id"] not in valid_ids.get("categories", set()):
                        d["category_id"] = None
                    if d.get("product_id") and d["product_id"] not in valid_ids.get("products", set()):
                        d["product_id"] = None
                    if d.get("purchase_id") and d["purchase_id"] not in valid_ids.get("purchase_entries", set()):
                        d["purchase_id"] = None
                    if d.get("sale_id") and d["sale_id"] not in valid_ids.get("sale_entries", set()):
                        d["sale_id"] = None
                    if d.get("invoice_id") and d["invoice_id"] not in valid_ids.get("invoices", set()):
                        d["invoice_id"] = None

                cleaned_values.append(tuple(d[c] for c in cols))

            col_list_sql = ", ".join(cols)
            insert_sql = f"INSERT INTO {tbl} ({col_list_sql}) VALUES %s"
            psycopg2.extras.execute_values(pg_cur, insert_sql, cleaned_values, page_size=500)
            print(f"  -> Migrated {len(cleaned_values):5d} records into '{tbl}'")

        for tbl in TABLES_WITH_SERIAL_ID:
            pg_cur.execute(
                f"SELECT setval(pg_get_serial_sequence('{tbl}', 'id'), COALESCE((SELECT MAX(id) FROM {tbl}), 1), (SELECT COUNT(*) > 0 FROM {tbl}));"
            )

        pg_conn.commit()
    except Exception as exc:
        pg_conn.rollback()
        sq_conn.close()
        pg_conn.close()
        raise RuntimeError(f"Migration aborted and rolled back safely. Reason: {exc}") from exc

    print("\n[5/6] Verifying record counts and financial totals in Neon PostgreSQL...")
    post_metrics = get_postgres_metrics(pg_conn)

    mismatches = []
    for tbl, sq_cnt in pre_metrics["counts"].items():
        pg_cnt = post_metrics["counts"].get(tbl, -1)
        if sq_cnt != pg_cnt:
            mismatches.append(f"Table '{tbl}' count mismatch: SQLite={sq_cnt} vs Neon={pg_cnt}")

    for key, sq_val in pre_metrics["financials"].items():
        pg_val = post_metrics["financials"].get(key, -1)
        if abs(float(sq_val) - float(pg_val)) > 0.01:
            mismatches.append(f"Financial '{key}' mismatch: SQLite={sq_val} vs Neon={pg_val}")

    sq_conn.close()
    pg_conn.close()

    if mismatches:
        raise RuntimeError("VERIFICATION FAILED! Local DB was NOT removed:\n" + "\n".join(mismatches))

    print("\n=== 100% VERIFICATION PASSED: ALL COUNTS & FINANCIAL TOTALS MATCH EXACTLY ===")
    for k, v in post_metrics["financials"].items():
        print(f"  Verified {k:28s}: {v}")

    print("\n[6/6] Retiring active local SQLite database files (recoverable backup preserved)...")
    for db_file in SQLITE_CANDIDATES:
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(db_file) + suffix)
            if p.exists():
                p.unlink()
                print(f"  Removed local file: {p}")

    receipt_path = PROJECT_ROOT / "backend" / "data" / "NEON_MIGRATION_VERIFIED.json"
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path.write_text(
        json.dumps(
            {
                "migrated_at": datetime.utcnow().isoformat(),
                "status": "VERIFIED_100_PERCENT",
                "backup_location": str(backup_file),
                "metrics": post_metrics,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\nSUCCESS! All business data is now permanently live on Neon PostgreSQL.")
    print(f"Recoverable pre-migration backup saved at: {backup_file}")


if __name__ == "__main__":
    run_migration()