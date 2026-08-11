-- tenko Phase 3: 勤怠イベントの下書き
-- 実行先: Neon の tenko プロジェクト（パンくずで tenko を確認してから実行すること）
-- 実行は PO が SQL Editor で手動で行う。CC は実行しない。

CREATE TABLE attendance_drafts (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  message_id   BIGINT NOT NULL REFERENCES messages(id),   -- 根拠の発言。論理削除でも行は残る
  kind         TEXT   NOT NULL CHECK (kind IN ('arrive', 'leave', 'break', 'late')),
  event_at     TIMESTAMPTZ NOT NULL,                      -- 下書きの時刻
  status       TEXT   NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'confirmed', 'rejected')),
  rule_id      TEXT   NOT NULL,                           -- 当たったルールの識別子。なぜ立ったかの説明に使う
  matched_text TEXT   NOT NULL,                           -- 実際に一致した部分
  source_body  TEXT   NOT NULL,                           -- 立てた時点の発言本文の写し
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at   TIMESTAMPTZ,                               -- 人間が押した時刻
  decided_by   BIGINT REFERENCES users(id),
  CONSTRAINT decided_consistency CHECK (
    (status = 'pending'  AND decided_at IS NULL AND decided_by IS NULL) OR
    (status <> 'pending' AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
  )
);

-- 同じ発言から同じ種別の下書きが二重に立たない。再送・再処理の保険
CREATE UNIQUE INDEX attendance_drafts_message_kind_uq
  ON attendance_drafts (message_id, kind);

-- 「自分の未確定の下書き」を引く経路
CREATE INDEX attendance_drafts_user_status_idx
  ON attendance_drafts (user_id, status, id DESC);

-- 確定・却下した下書きを、機械が後から書き換えられないようにする。
-- 人間が押した結果を上書きしない、という境界をDB側でも担保する。
CREATE OR REPLACE FUNCTION attendance_drafts_freeze_decided()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION '確定または却下済みの下書きは変更できません (id=%, status=%)', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER attendance_drafts_freeze
  BEFORE UPDATE OR DELETE ON attendance_drafts
  FOR EACH ROW EXECUTE FUNCTION attendance_drafts_freeze_decided();

-- ロールバック用
-- DROP TRIGGER IF EXISTS attendance_drafts_freeze ON attendance_drafts;
-- DROP FUNCTION IF EXISTS attendance_drafts_freeze_decided();
-- DROP TABLE IF EXISTS attendance_drafts;
