from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Annotated

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Depends, HTTPException, Query, Request, status
from fastapi.security import OAuth2PasswordBearer

from .db import fetch_one

SECRET_KEY = "malik-electronic-local-secret-2026"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 12
password_hasher = PasswordHasher()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        return password_hasher.verify(hashed_password, plain_password)
    except VerifyMismatchError:
        return False


def create_access_token(username: str) -> str:
    expires = datetime.now(timezone.utc) + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)
    payload = {"sub": username, "exp": expires}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.InvalidTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session expired or invalid token.",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


def get_current_user(token: Annotated[str, Depends(oauth2_scheme)]):
    payload = decode_access_token(token)
    username = payload.get("sub")
    user = fetch_one(
        "SELECT id, username, username_key, must_change_password, created_at, updated_at FROM users WHERE username_key = lower(?)",
        (username,),
    )
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account not found.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def require_ready_user(current_user: Annotated[dict, Depends(get_current_user)]):
    return current_user


def get_current_branch_id(
    request: Request,
    branch_id: int | None = Query(default=None),
) -> int:
    """
    Extracts the active branch ID with graceful fallbacks:
    1. Direct Query parameter (?branch_id=...)
    2. HTTP Header (X-Branch-Id)
    3. Cookie (malik_branch_id)
    4. Default fallback to Branch 1 (Talagang City)
    """
    if branch_id is not None and branch_id > 0:
        return branch_id
    header_val = request.headers.get("x-branch-id") or request.headers.get("X-Branch-Id")
    if header_val:
        try:
            val = int(header_val)
            if val > 0:
                return val
        except ValueError:
            pass
    cookie_val = request.cookies.get("malik_branch_id")
    if cookie_val:
        try:
            val = int(cookie_val)
            if val > 0:
                return val
        except ValueError:
            pass
    return 1


def require_active_branch(
    branch_id: Annotated[int, Depends(get_current_branch_id)],
) -> int:
    """
    Ensures the branch exists and is NOT closed before allowing mutating actions (POST/PUT/DELETE).
    Closed branches allow read-only viewing of historical data.
    """
    branch = fetch_one("SELECT id, name, status FROM branches WHERE id = ?", (branch_id,))
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found.")
    if branch["status"] == "Closed":
        raise HTTPException(
            status_code=403,
            detail=f"Branch '{branch['name']}' is closed. New entries and updates are blocked on closed branches.",
        )
    return branch_id