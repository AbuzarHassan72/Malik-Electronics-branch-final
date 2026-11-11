import os
import time
import hmac
import hashlib
import secrets
import sqlite3
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ==========================================================
# CONFIGURATION: MAIN SHOP OWNER & VERIFICATION PASSWORD
# ==========================================================
OWNER_FULL_NAME = "Malik Alyas"
MASTER_VERIFICATION_PASSWORD = os.getenv("MALIK_SECURITY_KEY", "Alyas51214")
SESSION_INACTIVITY_LIMIT_SECONDS = 15 * 60  # 15 Minutes
BIOMETRIC_TOKEN_TTL_SECONDS = 120           # Signed biometric token valid for 120s
SECRET_SIGNING_KEY = os.getenv("MALIK_SECRET_KEY", "malik-electronic-v33-secret-key-alyas51214")

_SESSION_LAST_ACTIVE: dict[str, float] = {}
_REVOKED_TOKENS: set[str] = set()


class BiometricChallengeRequest(BaseModel):
    action: str = "sensitive_action"


class BiometricVerifyRequest(BaseModel):
    action: str = "sensitive_action"
    challenge: str
    credential_id: str
    client_data_json: Optional[str] = None
    authenticator_data: Optional[str] = None
    signature: Optional[str] = None


class SecurityCodePayload(BaseModel):
    security_key: Optional[str] = None
    security_code: Optional[str] = None
    password: Optional[str] = None
    biometric_token: Optional[str] = None


def generate_stateless_challenge(action: str = "any") -> str:
    """Generates a stateless HMAC-signed WebAuthn challenge that works across all Vercel serverless instances."""
    ts = str(int(time.time()))
    nonce = secrets.token_urlsafe(18).replace(".", "").replace("-", "")
    raw = f"{action}:{ts}:{nonce}"
    sig = hmac.new(
        SECRET_SIGNING_KEY.encode("utf-8"),
        raw.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()[:32]
    return f"{ts}_{nonce}_{sig}"


def verify_stateless_challenge(challenge: str, action: str = "any") -> bool:
    """Verifies a stateless challenge generated within the last 180 seconds."""
    if not challenge or "_" not in challenge:
        return False
    parts = challenge.split("_")
    if len(parts) != 3:
        return False
    ts_str, nonce, sig = parts
    try:
        issued_at = int(ts_str)
        if abs(time.time() - issued_at) > 180:
            return False
    except ValueError:
        return False

    raw = f"{action}:{ts_str}:{nonce}"
    expected_sig = hmac.new(
        SECRET_SIGNING_KEY.encode("utf-8"),
        raw.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()[:32]
    return hmac.compare_digest(sig, expected_sig)


def generate_biometric_verification_token(action: str = "any") -> str:
    """Generates a short-lived HMAC-signed token after device biometric verification."""
    ts = str(int(time.time()))
    nonce = secrets.token_hex(8)
    payload = f"{action}:{ts}:{nonce}"
    sig = hmac.new(
        SECRET_SIGNING_KEY.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"BIO.{payload}.{sig}"


def is_valid_verification_secret(provided: Optional[str]) -> bool:
    """
    Validates either:
    1. The owner verification password ('Alyas51214')
    2. A valid backend-signed Biometric Verification Token ('BIO....')
    """
    if not provided:
        return False
    clean = str(provided).strip()

    # 1. Direct owner verification password
    if hmac.compare_digest(clean, MASTER_VERIFICATION_PASSWORD):
        return True

    # 2. Signed biometric verification token (stateless check safe for middleware + route handler)
    if clean.startswith("BIO."):
        parts = clean.split(".")
        if len(parts) == 3:
            _, payload, sig = parts
            expected_sig = hmac.new(
                SECRET_SIGNING_KEY.encode("utf-8"),
                payload.encode("utf-8"),
                hashlib.sha256,
            ).hexdigest()
            if not hmac.compare_digest(sig, expected_sig):
                return False
            subparts = payload.split(":")
            if len(subparts) == 3:
                _, ts_str, _ = subparts
                try:
                    issued_at = int(ts_str)
                    if abs(time.time() - issued_at) <= BIOMETRIC_TOKEN_TTL_SECONDS:
                        return True
                except ValueError:
                    return False
    return False


def sync_sqlite_owner_and_security_key(db_path: Optional[Path] = None) -> None:
    if os.getenv("DATABASE_URL") or os.getenv("VERCEL"):
        return
    search_paths = []
    if db_path:
        search_paths.append(db_path)
    base_dir = Path(__file__).resolve().parent.parent
    for candidate in base_dir.rglob("*.db"):
        search_paths.append(candidate)

    for path in search_paths:
        if not path.exists():
            continue
        try:
            conn = sqlite3.connect(str(path))
            cur = conn.cursor()
            tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
            if "users" in tables:
                cols = [r[1] for r in cur.execute("PRAGMA table_info(users)").fetchall()]
                if "full_name" in cols:
                    cur.execute("UPDATE users SET full_name = ?", (OWNER_FULL_NAME,))
                if "display_name" in cols:
                    cur.execute("UPDATE users SET display_name = ?", (OWNER_FULL_NAME,))
            conn.commit()
            conn.close()
        except Exception:
            pass


def _extract_bearer_token(request: Request) -> Optional[str]:
    auth = request.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return request.cookies.get("malik_token")


def register_phase2_security(app: FastAPI) -> None:
    os.environ["MALIK_SECURITY_KEY"] = MASTER_VERIFICATION_PASSWORD
    os.environ["SECURITY_KEY"] = MASTER_VERIFICATION_PASSWORD
    os.environ["VERIFICATION_PASSWORD"] = MASTER_VERIFICATION_PASSWORD

    @app.middleware("http")
    async def session_inactivity_and_security_middleware(request: Request, call_next):
        path = request.url.path
        token = _extract_bearer_token(request)

        public_paths = {"/api/auth/login", "/api/auth/update-credentials", "/login", "/"}
        if path.startswith("/api/") and path not in public_paths:
            if token:
                if token in _REVOKED_TOKENS:
                    return JSONResponse(
                        status_code=401,
                        content={"detail": "Session has been logged out. Please sign in again."},
                    )
                now = time.time()
                last_active = _SESSION_LAST_ACTIVE.get(token)
                if last_active is not None and (now - last_active) > SESSION_INACTIVITY_LIMIT_SECONDS:
                    _REVOKED_TOKENS.add(token)
                    _SESSION_LAST_ACTIVE.pop(token, None)
                    return JSONResponse(
                        status_code=401,
                        content={"detail": "Session expired after 15 minutes of inactivity."},
                    )
                _SESSION_LAST_ACTIVE[token] = now

        response = await call_next(request)
        return response

    @app.post("/api/auth/logout")
    async def api_logout(request: Request):
        token = _extract_bearer_token(request)
        if token:
            _REVOKED_TOKENS.add(token)
            _SESSION_LAST_ACTIVE.pop(token, None)
        resp = JSONResponse({"status": "logged_out", "message": "Logged out successfully."})
        resp.delete_cookie("malik_token")
        return resp

    @app.post("/api/auth/session-heartbeat")
    async def api_session_heartbeat(request: Request):
        token = _extract_bearer_token(request)
        if not token or token in _REVOKED_TOKENS:
            raise HTTPException(status_code=401, detail="Session expired.")
        now = time.time()
        last_active = _SESSION_LAST_ACTIVE.get(token)
        if last_active and (now - last_active) > SESSION_INACTIVITY_LIMIT_SECONDS:
            _REVOKED_TOKENS.add(token)
            raise HTTPException(status_code=401, detail="Session expired due to inactivity.")
        _SESSION_LAST_ACTIVE[token] = now
        return {
            "active": True,
            "owner": OWNER_FULL_NAME,
            "remaining_seconds": SESSION_INACTIVITY_LIMIT_SECONDS,
        }

    @app.post("/api/auth/biometric/challenge")
    async def api_biometric_challenge(payload: BiometricChallengeRequest, request: Request):
        token = _extract_bearer_token(request)
        if not token or token in _REVOKED_TOKENS:
            raise HTTPException(status_code=401, detail="Authentication required for biometric challenge.")
        challenge = generate_stateless_challenge(payload.action)
        return {
            "challenge": challenge,
            "rp_name": "Malik Electronic ERP",
            "user_display_name": OWNER_FULL_NAME,
            "action": payload.action,
        }

    @app.post("/api/auth/biometric/verify")
    async def api_biometric_verify(payload: BiometricVerifyRequest, request: Request):
        token = _extract_bearer_token(request)
        if not token or token in _REVOKED_TOKENS:
            raise HTTPException(status_code=401, detail="Unauthorized session.")

        if not verify_stateless_challenge(payload.challenge, payload.action):
            raise HTTPException(status_code=400, detail="Invalid or expired biometric challenge.")
        if not payload.credential_id:
            raise HTTPException(status_code=400, detail="Missing biometric credential.")

        verification_token = generate_biometric_verification_token(payload.action)
        return {
            "verified": True,
            "action": payload.action,
            "verification_token": verification_token,
            "security_code": MASTER_VERIFICATION_PASSWORD,
        }

    @app.post("/api/auth/verify-action")
    async def api_verify_sensitive_action(payload: SecurityCodePayload, request: Request):
        token = _extract_bearer_token(request)
        if not token or token in _REVOKED_TOKENS:
            raise HTTPException(status_code=401, detail="Unauthorized session.")
        candidate = (
            payload.biometric_token
            or payload.security_code
            or payload.security_key
            or payload.password
        )
        if not is_valid_verification_secret(candidate):
            raise HTTPException(status_code=403, detail="Invalid verification password.")
        return {"verified": True, "owner": OWNER_FULL_NAME}