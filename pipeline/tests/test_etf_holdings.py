"""etf_holdings 수집기 — 이름 잇기와 비중 계산이 핵심이라 그 둘을 고정한다."""
from pipeline.src.etf_holdings import normalize_name, resolve_ticker


def test_normalize_strips_corporate_words_by_token_not_by_substring():
    # 글자로 자르면 'ORACLE CORPORATION'이 'ORACLE ORATION'이 된다 — 실제로 겪은 버그다.
    assert normalize_name("ORACLE CORP") == "ORACLE"
    assert normalize_name("Oracle Corporation") == "ORACLE"
    assert normalize_name("ORACLE CORP") == normalize_name("Oracle Corporation")


def test_normalize_absorbs_punctuation_and_share_class():
    assert normalize_name("AMAZON.COM INC") == "AMAZON COM"
    assert normalize_name("ALPHABET INC-CL A") == "ALPHABET"
    assert normalize_name("Alphabet Inc. Class A") == "ALPHABET"
    assert normalize_name("PALANTIR TECHNOLOGIES INC-A") == "PALANTIR TECHNOLOGIES"


_UNIVERSE = {
    normalize_name("NVIDIA Corporation"): "NVDA",
    normalize_name("Amazon"): "AMZN",
    normalize_name("Vertiv"): "VRT",
    normalize_name("Intel"): "INTC",
}


def test_resolve_matches_exact_name():
    assert resolve_ticker("NVIDIA CORP", _UNIVERSE) == "NVDA"


def test_resolve_matches_when_db_uses_a_shorter_name():
    # 네이버는 정식명("VERTIV HOLDINGS CO-A"), stock_universe는 통칭("Vertiv")을 쓴다.
    assert resolve_ticker("VERTIV HOLDINGS CO-A", _UNIVERSE) == "VRT"
    assert resolve_ticker("AMAZON.COM INC", _UNIVERSE) == "AMZN"


def test_resolve_gives_up_when_ambiguous():
    # 후보가 둘이면 엉뚱한 종목을 고르느니 못 이었다고 드러내는 편이 낫다 —
    # 잘못 이으면 틀린 비중이 조용히 들어간다.
    universe = {normalize_name("Apple"): "AAPL", normalize_name("Apple Hospitality"): "APLE"}
    assert resolve_ticker("APPLE HOSPITALITY REIT INC", universe) is None


def test_resolve_returns_none_for_unknown_name():
    assert resolve_ticker("SOME UNLISTED THING", _UNIVERSE) is None


def test_known_tickers_matches_the_frontend_list():
    """파이프라인의 KNOWN_TICKERS ↔ 화면의 FALLBACK_PROXY_HOLDINGS.

    2026-09-25에 만든 **동기화 지점**이다. 어긋나면 파이프라인이 "구성이 바뀌었다"고
    매일 잘못 알리거나(파이썬 목록이 짧을 때), 진짜 바뀐 걸 놓친다(길 때).
    화면 쪽을 고치고 여기를 안 고치는 실수가 조용히 지나가지 않게 실제 파일을 읽어 비교한다.
    """
    import re
    from pathlib import Path

    from pipeline.src.etf_holdings_main import KNOWN_TICKERS

    ts = (Path(__file__).resolve().parents[2] / "frontend/lib/etfEntryCheck.ts").read_text(encoding="utf-8")
    block = ts.split("FALLBACK_PROXY_HOLDINGS")[1].split("] as const")[0]
    frontend = set(re.findall(r"ticker:\s*'([A-Z.]+)'", block))

    assert frontend, "화면 목록을 못 읽었다 — etfEntryCheck.ts 구조가 바뀌었는지 확인할 것"
    assert KNOWN_TICKERS == frontend, (
        f"목록이 어긋난다. 파이프라인에만: {sorted(KNOWN_TICKERS - frontend)} / "
        f"화면에만: {sorted(frontend - KNOWN_TICKERS)}"
    )
