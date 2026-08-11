-- tenko Phase 4.9 の追加DDL
--
-- 方針（Phase 4.5 と同じ条件）:
--   - 追加のみ。既存の列・制約・トリガーには触れない
--   - ロールバックSQLを先に書く（このファイルの末尾）
--   - DROP / TRUNCATE / ALTER COLUMN は書かない
--
-- 追加するもの: announcements（村の噴水に出すお知らせ）と、誰がどこまで読んだかの記録
--
-- なぜ流れて消える形にしないか:
--   重要な連絡に向かないため（POの判断）。行として残し、消すのは明示的な操作にする。
--   消すのも「消した印を付ける」形にして、後から誰が何を出したかを追えるようにする。

-- 1) お知らせ本体
CREATE TABLE announcements (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),   -- 書いた人（admin のみ。検証はAPI側）
  body       TEXT   NOT NULL CHECK (char_length(body) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ                              -- 消しても行は残す
);

CREATE INDEX announcements_live_idx ON announcements (created_at DESC) WHERE deleted_at IS NULL;

-- 2) どこまで読んだか。未読があることを噴水で示すために使う。
--    read_states と同じ形（1人1行、最後に読んだIDを持つ）にして、考え方を揃える
CREATE TABLE announcement_reads (
  user_id                 BIGINT NOT NULL REFERENCES users(id),
  last_read_announcement_id BIGINT NOT NULL DEFAULT 0,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id)
);

-- 確認用
-- SELECT id, user_id, left(body, 20), created_at FROM announcements ORDER BY id DESC LIMIT 5;


-- ============================================================
-- ロールバック（この変更を戻す場合。実行前にこちらを用意しておく）
-- ============================================================
-- DROP TABLE IF EXISTS announcement_reads;
-- DROP TABLE IF EXISTS announcements;
--
-- 新しい表を2つ足すだけで、既存の表には触れていないため、落としても他に波及しない。
