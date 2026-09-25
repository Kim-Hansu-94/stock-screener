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
