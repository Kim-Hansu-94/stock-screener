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


# ── 우선주 → 보통주 corp_code 폴백 ──────────────────────────────────────
# DART corpCode.xml은 법인당 대표 종목코드(보통 보통주) 하나만 매핑해서,
# 우선주 티커로는 애초에 못 찾는다. 재무제표는 종목이 아니라 법인 단위라
# 보통주 쪽 값을 그대로 써도 회계적으로 맞다.

def test_strip_preferred_suffix_recognizes_known_patterns():
    assert dart_fundamentals._strip_preferred_suffix("현대차우") == "현대차"
    assert dart_fundamentals._strip_preferred_suffix("두산2우B") == "두산"
    assert dart_fundamentals._strip_preferred_suffix("삼성전기우") == "삼성전기"
    assert dart_fundamentals._strip_preferred_suffix("LG전자우") == "LG전자"


def test_strip_preferred_suffix_returns_none_for_ordinary_names():
    assert dart_fundamentals._strip_preferred_suffix("삼성전자") is None
    assert dart_fundamentals._strip_preferred_suffix("두산") is None


def test_strip_preferred_suffix_rejects_degenerate_whole_string_match():
    # 이름 전체가 접미사 패턴이면(예: "우" 단독) 빈 문자열이 나오므로 매칭하지 않는다
    assert dart_fundamentals._strip_preferred_suffix("우") is None


def test_extract_falls_back_to_common_stock_corp_code(monkeypatch):
    """우선주 티커 자체는 corpCode.xml에 없지만, 이름으로 찾은 보통주는 있다."""
    monkeypatch.setenv("DART_API_KEY", "fake-key")
    monkeypatch.setattr(
        dart_fundamentals, "_load_corp_codes",
        lambda _key: {"005380": "corp-hyundai"},  # 보통주만 매핑, 005385(우선주)는 없음
    )
    monkeypatch.setattr(
        dart_fundamentals, "_fetch_year",
        lambda corp, _key, _year: (
            ({"revenue_latest": 1.0}, "ok") if corp == "corp-hyundai" else (None, "dart_status_013")
        ),
    )

    data, reason = dart_fundamentals.extract(
        "005385", 2025, name="현대차우", name_to_ticker={"현대차": "005380"},
    )
    assert data == {"revenue_latest": 1.0}
    assert reason == "ok_via_common_stock"


def test_extract_stays_corp_code_not_found_when_no_common_stock_matches(monkeypatch):
    """이름이 우선주 패턴이 아니거나, 매핑에 보통주가 없으면 그냥 기존과 동일하게 실패한다."""
    monkeypatch.setenv("DART_API_KEY", "fake-key")
    monkeypatch.setattr(dart_fundamentals, "_load_corp_codes", lambda _key: {})

    data, reason = dart_fundamentals.extract(
        "005385", 2025, name="현대차우", name_to_ticker={},  # 보통주 매핑 없음
    )
    assert data is None
    assert reason == "corp_code_not_found"


def test_extract_without_name_args_behaves_as_before(monkeypatch):
    """name/name_to_ticker를 안 넘기면(기존 호출부) 폴백을 시도하지 않는다."""
    monkeypatch.setenv("DART_API_KEY", "fake-key")
    monkeypatch.setattr(dart_fundamentals, "_load_corp_codes", lambda _key: {"005380": "corp-hyundai"})
    data, reason = dart_fundamentals.extract("005385", 2025)
    assert data is None
    assert reason == "corp_code_not_found"


# ── no_key_accounts 진단 상세 ────────────────────────────────────────────

def test_fetch_year_includes_actual_account_names_when_parse_fails(monkeypatch):
    """영업수익 폴백도 실패하는 업종이 있어, 실제 계정명을 사유에 실어 보낸다 —
    이 네트워크에서 DART를 직접 호출할 수 없으니 로그 자체가 다음 폴백명을
    알려주는 진단이 되게 한다.
    """
    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {
                "status": "000",
                "list": [
                    {"account_nm": "이자수익", "fs_div": "CFS", "thstrm_amount": "100", "bfefrmtrm_amount": "80"},
                    {"account_nm": "이자수익", "fs_div": "OFS", "thstrm_amount": "90", "bfefrmtrm_amount": "70"},
                ],
            }

    monkeypatch.setattr(dart_fundamentals.requests, "get", lambda *a, **k: _Resp())
    _, reason = dart_fundamentals._fetch_year("corp1", "key", 2025)
    assert reason == "no_key_accounts:이자수익"


def test_parse_year_falls_back_to_net_income_loss_label_for_financial_companies():
    """증권·보험·금융지주는 "당기순이익" 대신 "당기순이익(손실)"로 잡힌다 — 실제
    실행에서 no_key_accounts로 떨어진 5개(NH투자증권·삼성증권·BNK금융지주·
    롯데손보·제주은행) 전부 이 표기였다. 매출액 계열 계정이 아예 없어도
    순이익만 잡히면 통과해야 한다(이 업종은 매출 항목이 원래 없는 경우가 흔함).
    """
    rows = [
        _row("당기순이익(손실)", "CFS", "150", "100"),
        _row("부채총계", "CFS", "9,999", "9,999"),  # 순이익·매출과 무관한 계정
    ]
    result = _parse_year(rows, 2025)
    assert result is not None
    assert result["net_income_latest"] == 150.0
    assert result["net_income_prior"] == 100.0
    assert result["revenue_latest"] is None  # 매출 계열 계정 자체가 없어도 통과


def test_parse_year_prefers_net_income_over_the_loss_label_fallback():
    rows = [
        _row("당기순이익", "CFS", "150", "100"),
        _row("당기순이익(손실)", "CFS", "9,999", "9,999"),  # 있어도 정식 계정명이 우선
    ]
    result = _parse_year(rows, 2025)
    assert result["net_income_latest"] == 150.0
