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
