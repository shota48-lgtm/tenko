-- tenko Phase 4: 上長による承認と、月次の勤怠記録
-- 実行先: Neon の tenko プロジェクト（パンくずで tenko を確認してから実行すること）
-- 実行は PO が SQL Editor で手動で行う。CC は実行しない。
--
-- 方針:
--   attendance_drafts（Phase 3）は「本人が確定するまで」を表す。ここには手を入れない。
--   本人が確定した時点で attendance_records に1行作り、以降の承認・差し戻しはそちらで回す。
--   既存のトリガーは drafts の confirmed 行を凍結するため、drafts に承認の状態を足すと衝突する。
--   テーブルを分けることで、既存のトリガーを一切変更せずに済む。

-- 1) 承認者の割り当て。誰が誰の上長かを users に持つ
ALTER TABLE users
  ADD COLUMN manager_id BIGINT REFERENCES users(id);

-- 自分を自分の上長にできないようにする
ALTER TABLE users
  ADD CONSTRAINT users_manager_not_self CHECK (manager_id IS NULL OR manager_id <> id);

CREATE INDEX users_manager_idx ON users (manager_id);

-- 2) 勤怠記録。本人が確定した時点で作られ、上長の承認を受ける
CREATE TABLE attendance_records (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id),
  draft_id       BIGINT REFERENCES attendance_drafts(id),   -- 根拠の下書き。手入力の記録では NULL
  kind           TEXT   NOT NULL CHECK (kind IN ('arrive', 'leave', 'break', 'late')),
  event_at       TIMESTAMPTZ NOT NULL,                      -- 実際の時刻
  work_date      DATE   NOT NULL,                           -- 集計の単位。時刻から推測せず明示的に持つ
  status         TEXT   NOT NULL DEFAULT 'submitted'
                 CHECK (status IN ('submitted', 'approved', 'returned')),
  confirmed_at   TIMESTAMPTZ NOT NULL,                      -- 本人が確定した時刻
  approved_at    TIMESTAMPTZ,
  approved_by    BIGINT REFERENCES users(id),
  returned_at    TIMESTAMPTZ,
  returned_by    BIGINT REFERENCES users(id),
  return_reason  TEXT,                                      -- 差し戻しの理由。本人が直すために必要
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 承認済みなら承認者と時刻が必ず入る。差し戻しなら理由が必ず入る
  CONSTRAINT records_status_consistency CHECK (
    (status = 'submitted' AND approved_at IS NULL AND approved_by IS NULL) OR
    (status = 'approved'  AND approved_at IS NOT NULL AND approved_by IS NOT NULL) OR
    (status = 'returned'  AND returned_at IS NOT NULL AND returned_by IS NOT NULL
                          AND return_reason IS NOT NULL AND length(btrim(return_reason)) > 0)
  )
);

-- 1つの下書きから記録は1件だけ。確定を二度押しても増えない
CREATE UNIQUE INDEX attendance_records_draft_uq
  ON attendance_records (draft_id) WHERE draft_id IS NOT NULL;

-- 承認待ちの一覧（上長が引く）
CREATE INDEX attendance_records_status_idx
  ON attendance_records (status, user_id, id DESC);

-- 月次の集計（誰の何月分か）
CREATE INDEX attendance_records_user_date_idx
  ON attendance_records (user_id, work_date);

-- 3) 承認済みの記録を、本人も機械も書き換えられないようにする。
--    Phase 3 と同じ考え方。DELETE 時に NEW を返すと削除が黙って抑止されるため OLD を返す（J224）。
CREATE OR REPLACE FUNCTION attendance_records_freeze_approved()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION '承認済みの勤怠記録は変更できません (id=%, approved_by=%)', OLD.id, OLD.approved_by;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER attendance_records_freeze
  BEFORE UPDATE OR DELETE ON attendance_records
  FOR EACH ROW EXECUTE FUNCTION attendance_records_freeze_approved();

-- 4) 動作確認用（POが実行してよい。DDLではない）
--    部下と上長の関係を1組作る例:
--      INSERT INTO users (display_name, role) VALUES ('承認 太郎', 'manager');
--      UPDATE users SET manager_id = (SELECT id FROM users WHERE display_name = '承認 太郎')
--       WHERE display_name = 'テスト太郎';

-- ロールバック用
-- DROP TRIGGER IF EXISTS attendance_records_freeze ON attendance_records;
-- DROP FUNCTION IF EXISTS attendance_records_freeze_approved();
-- DROP TABLE IF EXISTS attendance_records;
-- DROP INDEX IF EXISTS users_manager_idx;
-- ALTER TABLE users DROP CONSTRAINT IF EXISTS users_manager_not_self;
-- ALTER TABLE users DROP COLUMN IF EXISTS manager_id;
