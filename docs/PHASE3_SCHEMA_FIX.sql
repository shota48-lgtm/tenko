-- tenko Phase 3 の修正: トリガー関数の戻り値
--
-- 症状: 未確定（pending）の下書きを DELETE しても、エラーが出ないまま行が残る（rowCount = 0）
-- 原因: BEFORE DELETE のトリガーで RETURN NEW とすると NEW は NULL であり、
--       PostgreSQL は「この行の操作を取り消す」と解釈して削除を黙って抑止する
-- 影響: 確定・却下済みの行が守られる点は意図どおり。未確定の行まで消せなくなっていた
-- 実行先: Neon の tenko プロジェクト（パンくずで tenko を確認してから実行すること）

CREATE OR REPLACE FUNCTION attendance_drafts_freeze_decided()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION '確定または却下済みの下書きは変更できません (id=%, status=%)', OLD.id, OLD.status;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 確認用（実行後に期待される結果）
--   未確定の行の DELETE  -> 1行削除される
--   確定・却下済みの DELETE / UPDATE -> 例外「確定または却下済みの下書きは変更できません」
