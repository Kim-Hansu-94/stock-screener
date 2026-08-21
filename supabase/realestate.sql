-- 부동산 실거래 동향 (수도권 시군구 단위 월별 집계)
--
-- 건별 원본은 저장하지 않는다. 수도권 아파트 실거래는 매매+전월세 합쳐 월 7만 건
-- 수준이라 3년치면 250만 행 — 일봉(160만 행, 360MB)보다 크다. 보고 싶은 게
-- "구 단위 대략적인 흐름"이므로 시군구 × 월로 집계하면 80지역 × 36개월 ≈ 3천 행,
-- 몇 MB로 끝난다.
--
-- 평균과 함께 중위값도 담는 이유: 평균만 보면 그달에 고가 단지 한 건이 거래된 것이
-- 동네 시세 급등으로 보인다. ㎡당 단가도 같이 두는 이유: 큰 평수가 많이 거래된 달을
-- 가격 상승으로 착각하지 않기 위해서다. 화면에는 평균을 쓰되 왜곡이 의심되면
-- 나머지 둘로 확인한다.

create table if not exists realestate_monthly (
  region_code   text not null,          -- 법정동코드 앞 5자리 (시군구)
  region_name   text not null,          -- '서울 강남구'
  month         date not null,          -- 계약 연월 (그달 1일)

  -- 매매
  deal_count            int,            -- 거래 건수
  price_avg             numeric,        -- 평균 거래금액 (만원)
  price_median          numeric,        -- 중위 거래금액 (만원)
  price_per_area_avg    numeric,        -- ㎡당 평균 단가 (만원)

  -- 전세 (월세 0인 계약만)
  jeonse_count          int,
  deposit_avg           numeric,        -- 평균 보증금 (만원)
  deposit_median        numeric,

  -- 월세 (참고용 건수만)
  monthly_rent_count    int,

  -- 전세가율 = 평균 보증금 / 평균 매매가. 갭 = 매매 - 전세.
  -- 저장해두면 화면에서 매번 계산 안 해도 되고, 분모가 0인 달을 여기서 걸러낸다.
  jeonse_ratio          numeric,
  gap_avg               numeric,        -- 평균 갭 (만원)

  updated_at    timestamptz not null default now(),
  primary key (region_code, month)
);

create index if not exists idx_realestate_month
  on realestate_monthly (month desc, region_code);
