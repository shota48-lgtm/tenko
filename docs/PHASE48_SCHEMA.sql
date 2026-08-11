-- tenko Phase 4.8 の追加DDL
--
-- 方針（Phase 4.5 と同じ条件）:
--   - 追加のみ。既存の列・制約・トリガーには触れない
--   - ロールバックSQLを先に書く（このファイルの末尾）
--   - DROP / TRUNCATE / ALTER COLUMN は書かない
--
-- 追加するもの: rooms.capacity（建物の定員）
--
-- なぜ列として持つか:
--   定員は運用で変わる。コードに書くと、変えるたびに配信が要る。
--   初期値（house=4 / hall=12）は仮の値であり、後から UPDATE で変えられるようにする。
--
-- ALTER COLUMN を使わずに済ませるため、既定値と NOT NULL は ADD COLUMN に含める。
-- 既存行にはこの時点で 4 が入り、そのあと hall だけ 12 に上げる。

-- 1) 列の追加（既定値つき。既存行は 4 で埋まる）
ALTER TABLE rooms ADD COLUMN capacity integer NOT NULL DEFAULT 4;

-- 2) 共有の建物だけ広くする
UPDATE rooms SET capacity = 12 WHERE kind = 'hall';

-- 3) 0以下や極端な値を弾く
ALTER TABLE rooms ADD CONSTRAINT rooms_capacity_range CHECK (capacity BETWEEN 1 AND 100);

-- 確認用
-- SELECT id, name, kind, capacity FROM rooms ORDER BY id;


-- ============================================================
-- ロールバック（この変更を戻す場合。実行前にこちらを用意しておく）
-- ============================================================
-- ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_capacity_range;
-- ALTER TABLE rooms DROP COLUMN IF EXISTS capacity;
--
-- 追加した列と制約を落とすだけで元に戻る。既存の列・制約・トリガーには触れていないため、
-- 他の機能への波及はない。
