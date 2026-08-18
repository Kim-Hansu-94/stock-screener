import pipeline.src.dart_fundamentals as dart_fundamentals
from pipeline.src.dart_fundamentals import _amount, _parse_year, _pick_account


def _row(account_nm: str, fs_div: str, thstrm: str, bfefrmtrm: str) -> dict:
    return {
        "account_nm": account_nm,
        "fs_div": fs_div,
        "thstrm_amount": thstrm,
        "bfefrmtrm_amount": bfefrmtrm,
    }


def test_amount_strips_thousand_separators():
    assert _amount({"thstrm_amount": "1,234,567"}, "thstrm_amount") == 1234567.0


def test_amount_returns_none_for_missing_or_blank():
    assert _amount({"thstrm_amount": ""}, "thstrm_amount") is None
    assert _amount({}, "thstrm_amount") is None
    assert _amount(None, "thstrm_amount") is None


def test_pick_account_prefers_consolidated_over_separate():
    rows = [
        _row("매출액", "OFS", "100", "80"),
        _row("매출액", "CFS", "150", "120"),
    ]
    picked = _pick_account(rows, "매출액")
    assert picked["fs_div"] == "CFS"
    assert picked["thstrm_amount"] == "150"


def test_pick_account_falls_back_to_separate_when_no_consolidated():
    rows = [_row("매출액", "OFS", "100", "80")]
    picked = _pick_account(rows, "매출액")
    assert picked["fs_div"] == "OFS"


def test_pick_account_returns_none_when_absent():
    rows = [_row("영업이익", "CFS", "10", "5")]
    assert _pick_account(rows, "매출액") is None


def test_parse_year_builds_two_year_comparison_from_thstrm_and_bfefrmtrm():
    rows = [
        _row("매출액", "CFS", "1,000", "800"),
        _row("영업이익", "CFS", "200", "150"),
        _row("당기순이익", "CFS", "150", "100"),
    ]
    result = _parse_year(rows, 2025)
    assert result == {
        "fiscal_year_latest": 2025,
        "fiscal_year_prior": 2023,
        "revenue_latest": 1000.0,
        "revenue_prior": 800.0,
        "operating_income_latest": 200.0,
        "operating_income_prior": 150.0,
        "net_income_latest": 150.0,
        "net_income_prior": 100.0,
        "eps_latest": None,
        "eps_prior": None,
        "per": None,
        "pbr": None,
    }


def test_parse_year_returns_none_when_neither_key_account_is_present():
    rows = [_row("자본총계", "CFS", "500", "400")]
    assert _parse_year(rows, 2025) is None


def test_parse_year_tolerates_missing_operating_income():
    # 금융업 등 일부 업종은 '영업이익' 계정이 주요계정에 안 잡힐 수 있다 —
    # 매출·순이익만 있어도 판정에는 지장 없어야 한다.
    rows = [
        _row("매출액", "CFS", "1,000", "800"),
        _row("당기순이익", "CFS", "150", "100"),
    ]
    result = _parse_year(rows, 2025)
    assert result["operating_income_latest"] is None
    assert result["revenue_latest"] == 1000.0
    assert result["net_income_latest"] == 150.0


# ── extract()의 실패 사유 — 원인 진단용 ──────────────────────────────────
# 예전에는 실패하면 그냥 None만 돌려줘서 "왜 실패했는지"를 로그로 알 수 없었다.
# fundamentals.py가 이 사유를 모아 실행 로그에 찍으므로, 여기서는 각 실패 경로가
# 맞는 사유 문자열을 내는지만 확인한다.


def test_extract_reports_no_api_key(monkeypatch):
    monkeypatch.delenv("DART_API_KEY", raising=False)
    data, reason = dart_fundamentals.extract("005930", 2025)
    assert data is None
    assert reason == "no_api_key"


def test_extract_reports_corp_code_not_found(monkeypatch):
    monkeypatch.setenv("DART_API_KEY", "fake-key")
    monkeypatch.setattr(dart_fundamentals, "_load_corp_codes", lambda _key: {})
    data, reason = dart_fundamentals.extract("005930", 2025)
    assert data is None
    assert reason == "corp_code_not_found"


def test_extract_reports_dart_status_when_api_says_no_data(monkeypatch):
    monkeypatch.setenv("DART_API_KEY", "fake-key")
    monkeypatch.setattr(dart_fundamentals, "_load_corp_codes", lambda _key: {"005930": "corp1"})
    monkeypatch.setattr(dart_fundamentals, "_fetch_year", lambda *_a: (None, "dart_status_013"))
    data, reason = dart_fundamentals.extract("005930", 2025)
    assert data is None
    assert reason == "dart_status_013"


def test_extract_reports_ok_with_data(monkeypatch):
    monkeypatch.setenv("DART_API_KEY", "fake-key")
    monkeypatch.setattr(dart_fundamentals, "_load_corp_codes", lambda _key: {"005930": "corp1"})
    monkeypatch.setattr(dart_fundamentals, "_fetch_year", lambda *_a: ({"revenue_latest": 1.0}, "ok"))
    data, reason = dart_fundamentals.extract("005930", 2025)
    assert data == {"revenue_latest": 1.0}
    assert reason == "ok"


def test_extract_retries_prior_year_before_giving_up(monkeypatch):
    """latest_year 사업보고서가 아직 없으면 한 해 전으로 물러나 재시도한다."""
    monkeypatch.setenv("DART_API_KEY", "fake-key")
    monkeypatch.setattr(dart_fundamentals, "_load_corp_codes", lambda _key: {"005930": "corp1"})

    calls = []

    def fake_fetch(_corp, _key, year):
        calls.append(year)
        if year == 2025:
            return None, "dart_status_013"
        return {"revenue_latest": 1.0}, "ok"

    monkeypatch.setattr(dart_fundamentals, "_fetch_year", fake_fetch)
    data, reason = dart_fundamentals.extract("005930", 2025)
    assert calls == [2025, 2024]
    assert data == {"revenue_latest": 1.0}
    assert reason == "ok"


# ── 금융지주·은행 대체 계정명 ────────────────────────────────────────────
# DART 주요계정 API는 일반 기업 손익계산서 구조를 강제하지 않는다. 금융지주·
# 은행·증권 등은 "매출액" 대신 "영업수익"으로 잡히는 게 잘 알려진 관행이라,
# 그 이름으로도 못 찾으면 폴백으로 한 번 더 찾는다.

def test_parse_year_falls_back_to_operating_revenue_for_financial_companies():
    rows = [
        _row("영업수익", "CFS", "1,000", "800"),  # 매출액 대신
        _row("당기순이익", "CFS", "150", "100"),
    ]
    result = _parse_year(rows, 2025)
    assert result["revenue_latest"] == 1000.0
    assert result["revenue_prior"] == 800.0


def test_parse_year_prefers_revenue_over_the_fallback_when_both_exist():
    rows = [
        _row("매출액", "CFS", "1,000", "800"),
        _row("영업수익", "CFS", "9,999", "9,999"),  # 있어도 매출액이 우선
        _row("당기순이익", "CFS", "150", "100"),
    ]
    result = _parse_year(rows, 2025)
    assert result["revenue_latest"] == 1000.0
