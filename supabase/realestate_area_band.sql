-- realestate_monthly에 면적 구간(area_band) 추가
--
-- 이미 만든 테이블이 있다면 이 파일을 실행할 것. 아직 데이터가 없으므로
-- (첫 백필이 60분 타임아웃에 걸려 0행으로 끝났다) 그냥 다시 만든다.
-- 데이터가 들어 있는 상태라면 drop 대신 alter로 컬럼을 추가하고 PK를 바꿔야 한다.

drop table if exists realestate_monthly;

create table realestate_monthly (
  region_code   text not null,          -- 법정동코드 앞 5자리 (시군구)
  region_name   text not null,          -- '서울 강남구'
  month         date not null,          -- 계약 연월 (그달 1일)

  -- 전용면적 구간: 'ALL'(구 전체) / '~60' / '60~85' / '85~135' / '135~'
  area_band     text not null,

  -- 매매
  deal_count            int,
  price_avg             numeric,        -- 평균 거래금액 (만원)
  price_median          numeric,
  price_per_area_avg    numeric,        -- ㎡당 평균 단가 (만원)

  -- 전세 (월세 0인 계약만)
  jeonse_count          int,
  deposit_avg           numeric,
  deposit_median        numeric,

  -- 월세 (참고용 건수만)
  monthly_rent_count    int,

  jeonse_ratio          numeric,        -- 평균 보증금 / 평균 매매가
  gap_avg               numeric,        -- 매매 - 전세 (만원)

  updated_at    timestamptz not null default now(),
  primary key (region_code, month, area_band)
);

create index if not exists idx_realestate_month
  on realestate_monthly (month desc, region_code);
