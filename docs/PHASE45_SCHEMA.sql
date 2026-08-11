-- tenko Phase 4.5: 実行したDDLの全文
-- 今回に限り CC がこのDBに対して実行してよい（追加のみ。DROP / TRUNCATE は行わない）。
-- 既存の列・制約・トリガーには手を入れていない。

-- ============================================================
-- 1) 今日やること（機能1）
-- 履歴は残さない。1人1日1行を上書きする。
-- 履歴を持つとタスク管理ツールの領域に入るため（PO の懸念に沿う）。
-- 本文の長さの上限はDBでも持つ。アプリ側の検証だけに頼らない（S1）。
-- ============================================================
CREATE TABLE daily_notes (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  note_date  DATE   NOT NULL,
  body       TEXT   NOT NULL CHECK (char_length(body) BETWEEN 1 AND 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX daily_notes_user_date_uq ON daily_notes (user_id, note_date);

-- ============================================================
-- 2) 勤怠の修正申請（機能5）
-- 承認済みの記録は書き換えない。修正は新しい記録として立て、元の記録との関係を持たせる。
-- 承認の仕組みは Phase 4 のものを再利用するため、新しい状態やフローは作らない。
-- 元の記録が「差し替えられたか」は、承認済みの修正が自分を指しているかで導出する（列を増やさない）。
-- ============================================================
ALTER TABLE attendance_records
  ADD COLUMN corrects_record_id BIGINT REFERENCES attendance_records(id);

ALTER TABLE attendance_records
  ADD COLUMN correction_reason TEXT;

CREATE INDEX attendance_records_corrects_idx
  ON attendance_records (corrects_record_id) WHERE corrects_record_id IS NOT NULL;

-- ============================================================
-- ロールバック（実行前に必ず用意する。今回は使っていない）
-- ============================================================
-- DROP INDEX IF EXISTS attendance_records_corrects_idx;
-- ALTER TABLE attendance_records DROP COLUMN IF EXISTS correction_reason;
-- ALTER TABLE attendance_records DROP COLUMN IF EXISTS corrects_record_id;
-- DROP INDEX IF EXISTS daily_notes_user_date_uq;
-- DROP TABLE IF EXISTS daily_notes;
