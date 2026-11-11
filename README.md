# Malik Electronic Professional App v17

This v17 build hardens cache behavior for Chrome/localhost, removes the sidebar Stocks shortcut, upgrades price locking, adds reusable sales discounts, simplifies dashboard navigation, and renames the inventory page to **Category & Location Management**.

## Highlights
- versioned frontend assets with app freshness checks
- no-store cache headers on pages, static assets, and API responses
- secure price visibility session with password on unlock and lock
- reusable discount library in Sales
- dashboard now links directly into the full category manager
- improved category search suggestions and richer location stats

## Run locally
```bash
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8001
```

Use Chrome with a fresh tab. The app is designed to invalidate stale frontend state automatically.
