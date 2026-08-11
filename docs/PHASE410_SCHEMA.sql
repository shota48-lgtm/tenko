-- tenko Phase 4.10 の追加DDL
--
-- 方針（Phase 4.5 と同じ条件）:
--   - 追加のみ。既存の列・制約・トリガーには触れない
--   - ロールバックSQLを先に書く（このファイルの末尾）
--   - DROP / TRUNCATE / ALTER COLUMN は書かない
--
-- 追加するもの: rooms.deco（屋根の印。部屋の性格を見た目で分けるための種別）
--
-- なぜ列にするか:
--   Phase 4.9 では部屋名に含まれる語（「開発」「営業」など）から印を決めていた。
--   この形では、部屋名を「開発」から「開発チーム」に変えただけで印が変わる／変わらないが
--   予測できない。見た目を決める値は、名前とは別に明示的に持つ。
--
-- 取りうる値（CHECK で固定する）:
--   dev     開発
--   sales   営業
--   meeting 会議
--   rest    休憩
--   support サポート
--   office  事務
--   hall    共有の広間
--   other   その他（既定値）

-- 1) 列の追加。既定値つきなので既存の7件は 'other' で埋まる（壊れない）
ALTER TABLE rooms ADD COLUMN deco text NOT NULL DEFAULT 'other';

-- 2) 取りうる値を固定する
ALTER TABLE rooms ADD CONSTRAINT rooms_deco_values
  CHECK (deco IN ('dev', 'sales', 'meeting', 'rest', 'support', 'office', 'hall', 'other'));

-- 3) 既存の7件に、名前から一度だけ割り当てる。
--    これ以降は列の値が正であり、名前を変えても印は変わらない
UPDATE rooms SET deco = CASE
  WHEN kind = 'hall'        THEN 'hall'
  WHEN name LIKE '%開発%'    THEN 'dev'
  WHEN name LIKE '%営業%'    THEN 'sales'
  WHEN name LIKE '%会議%'    THEN 'meeting'
  WHEN name LIKE '%休憩%'    THEN 'rest'
  WHEN name LIKE '%サポート%' THEN 'support'
  WHEN name LIKE '%オフィス%' THEN 'office'
  ELSE 'other'
END;

-- 確認用
-- SELECT id, name, kind, capacity, deco FROM rooms ORDER BY id;


-- ============================================================
-- ロールバック（この変更を戻す場合。実行前にこちらを用意しておく）
-- ============================================================
-- ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_deco_values;
-- ALTER TABLE rooms DROP COLUMN IF EXISTS deco;
--
-- 追加した列と制約を落とすだけで元に戻る。既存の列・制約・トリガーには触れていない。
