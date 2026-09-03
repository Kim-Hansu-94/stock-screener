-- 부동산 관련 뉴스·유튜브 링크 (홈 상단 노출)
--
-- 매일 아침 한 번 통째로 갈아끼우는 "오늘의 스냅샷"이라 날짜별 이력을 쌓지
-- 않는다(뉴스는 어제 것을 보여줄 이유가 없다) — realestate_media_main.py가
-- 매 실행마다 테이블을 비우고 새로 채운다.

create table if not exists realestate_media (
  id             bigint generated always as identity primary key,
  media_type     text not null check (media_type in ('news', 'video')),
  title          text not null,
  url            text not null,
  source         text,             -- news: 언론사명, video: 채널명
  thumbnail_url  text,             -- video만 채워짐
  published_at   timestamptz,
  collected_date date not null,
  created_at     timestamptz not null default now()
);

create index if not exists idx_realestate_media_type
  on realestate_media (media_type, published_at desc);
