"""한국투자증권 KIS OpenAPI OAuth 토큰 관리.

KIS는 토큰 발급을 분당 1회로 제한하므로 토큰을 디스크에 캐싱 (24시간 유효).
"""

from __future__ import annotations

import json
import os
import pathlib
import time

import requests

_KIS_BASE = "https://openapi.koreainvestment.com:9443"
_CACHE_FILE = pathlib.Path(__file__).parent.parent / ".kis_token_cache.json"

_mem: dict = {"token": None, "expires_at": 0.0}


def _get_token() -> str:
    # 1. 메모리 캐시
    if _mem["token"] and time.time() < _mem["expires_at"]:
        return _mem["token"]

    # 2. 디스크 캐시 (프로세스 간 공유)
    if _CACHE_FILE.exists():
        try:
            cached = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
            if time.time() < cached.get("expires_at", 0):
                _mem.update(cached)
                return cached["token"]
        except Exception:
            pass

    # 3. 신규 발급
    resp = requests.post(
        f"{_KIS_BASE}/oauth2/tokenP",
        json={
            "grant_type": "client_credentials",
            "appkey": os.environ["KIS_APP_KEY"],
            "appsecret": os.environ["KIS_APP_SECRET"],
        },
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    entry = {
        "token": data["access_token"],
        "expires_at": time.time() + float(data.get("expires_in", 86400)) - 300,
    }
    _CACHE_FILE.write_text(json.dumps(entry), encoding="utf-8")
    _mem.update(entry)
    return entry["token"]


def headers(tr_id: str) -> dict[str, str]:
    return {
        "authorization": f"Bearer {_get_token()}",
        "appkey": os.environ["KIS_APP_KEY"],
        "appsecret": os.environ["KIS_APP_SECRET"],
        "tr_id": tr_id,
        "Content-Type": "application/json; charset=utf-8",
    }
