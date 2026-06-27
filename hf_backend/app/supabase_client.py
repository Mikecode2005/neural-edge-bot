"""Thin Supabase wrapper used by the backend."""
from __future__ import annotations
from functools import lru_cache
from typing import Any, Optional
from supabase import create_client, Client

from .config import get_settings


@lru_cache
def sb() -> Optional[Client]:
    s = get_settings()
    if not s.SUPABASE_URL or not s.SUPABASE_SERVICE_ROLE_KEY:
        return None
    return create_client(s.SUPABASE_URL, s.SUPABASE_SERVICE_ROLE_KEY)


def insert(table: str, row: dict[str, Any]) -> Optional[dict]:
    c = sb()
    if not c:
        return None
    res = c.table(table).insert(row).execute()
    return (res.data or [None])[0]


def update(table: str, row_id: str, patch: dict[str, Any]) -> Optional[dict]:
    c = sb()
    if not c:
        return None
    res = c.table(table).update(patch).eq("id", row_id).execute()
    return (res.data or [None])[0]


def select(table: str, *, eq: Optional[dict] = None,
           order: Optional[str] = None, desc: bool = True,
           limit: int = 100) -> list[dict]:
    c = sb()
    if not c:
        return []
    q = c.table(table).select("*")
    for k, v in (eq or {}).items():
        q = q.eq(k, v)
    if order:
        q = q.order(order, desc=desc)
    res = q.limit(limit).execute()
    return res.data or []
