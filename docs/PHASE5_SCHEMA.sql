-- tenko Phase 5: 認証（Google + Auth.js v5 / DBセッション）
-- 実行先: Neon の tenko プロジェクト
-- 設計: docs/PHASE5_AUTH_DESIGN.md 2節
--
-- 方針:
--   追加のみ。DROP / TRUNCATE / ALTER COLUMN は含めない。
--   既存の表・列・制約・トリガー（attendance_drafts_freeze / attendance_records_freeze）には触れない。
--   権限（role / manager_id）は既存の users が持ち続ける。認証の提供元には持たせない。
--
-- 実行記録: scripts/apply-phase5-ddl.js --apply で実行した（記録は docs/PHASE5_LOG.md）

-- 1) 既存の users に、Auth.js のアダプタが要求する4列を足す。
--    @auth/pg-adapter@1.11.3 の実装が使うのは name / email / "emailVerified" / image のみ。
--    列名の大文字はアダプタのSQLが二重引用符付きで書いているため、そのとおりに作る
ALTER TABLE users ADD COLUMN name TEXT;
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN "emailVerified" TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN image TEXT;

-- 同じアドレスの人が2行できないようにする。
-- NULL は重複を許すので、メールアドレスを持たないデモ用の利用者は影響を受けない
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;

-- 2) デモ用の印。接続が無くても村にいる人（ログインは絶対にできない）
ALTER TABLE users ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT false;

-- デモ用の利用者はメールアドレスを持てない = Google のアドレスと一致しようがない。
-- 「ログインできない」を、アプリの分岐だけでなくDB側でも担保する
ALTER TABLE users ADD CONSTRAINT users_demo_has_no_email
  CHECK (is_demo = false OR email IS NULL);

-- 3) Auth.js のテーブル。列名は大文字小文字を含むため必ず二重引用符付きで作る
CREATE TABLE accounts (
  id                  BIGSERIAL PRIMARY KEY,
  "userId"            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                VARCHAR(255) NOT NULL,
  provider            VARCHAR(255) NOT NULL,
  "providerAccountId" VARCHAR(255) NOT NULL,
  refresh_token       TEXT,
  access_token        TEXT,
  expires_at          BIGINT,
  id_token            TEXT,
  scope               TEXT,
  session_state       TEXT,
  token_type          TEXT
);
CREATE UNIQUE INDEX accounts_provider_uq ON accounts (provider, "providerAccountId");
CREATE INDEX accounts_user_idx ON accounts ("userId");

CREATE TABLE sessions (
  id             BIGSERIAL PRIMARY KEY,
  "userId"       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires        TIMESTAMPTZ NOT NULL,
  "sessionToken" VARCHAR(255) NOT NULL
);
CREATE UNIQUE INDEX sessions_token_uq ON sessions ("sessionToken");
CREATE INDEX sessions_user_idx ON sessions ("userId");

-- メールリンク認証は使わないが、アダプタの実装が参照するため作っておく
CREATE TABLE verification_token (
  identifier TEXT NOT NULL,
  expires    TIMESTAMPTZ NOT NULL,
  token      TEXT NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- 4) デモ用の利用者の見え方。接続が無くても村に出すために持つ。
--    生きている人の在席は今までどおり ws-server の揮発メモリだけで持つ（方針は変えない）。
--    行があるデモ利用者だけが村に出る。is_demo だが行が無い人は「一覧には出るが村にいない」
CREATE TABLE demo_presence (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'idle'
              CHECK (state IN ('idle','away','talking','resting')),
  talk        TEXT NOT NULL DEFAULT 'ok' CHECK (talk IN ('ok','later','focus')),
  room_id     BIGINT REFERENCES rooms(id),
  x           INTEGER NOT NULL,
  y           INTEGER NOT NULL,
  color_index INTEGER NOT NULL DEFAULT 1
);

-- ============================================================
-- ロールバック用（実行しない。戻す必要が出た場合にのみ、上から順に実行する）
--
-- 注意: DROP COLUMN email は登録済みのアドレスを失う。
--       戻す前に SELECT id, email FROM users WHERE email IS NOT NULL を控えること。
-- ============================================================
-- DROP TABLE IF EXISTS demo_presence;
-- DROP TABLE IF EXISTS verification_token;
-- DROP TABLE IF EXISTS sessions;
-- DROP TABLE IF EXISTS accounts;
-- ALTER TABLE users DROP CONSTRAINT IF EXISTS users_demo_has_no_email;
-- ALTER TABLE users DROP COLUMN IF EXISTS is_demo;
-- DROP INDEX IF EXISTS users_email_uq;
-- ALTER TABLE users DROP COLUMN IF EXISTS image;
-- ALTER TABLE users DROP COLUMN IF EXISTS "emailVerified";
-- ALTER TABLE users DROP COLUMN IF EXISTS email;
-- ALTER TABLE users DROP COLUMN IF EXISTS name;

-- ============================================================
-- 設計書から落とした文（実行しない）
--
--   ALTER TABLE users ALTER COLUMN display_name SET DEFAULT '(未登録)';
--
-- 理由: 既存の列の既定値を変える操作であり、今回の実行条件
--       「既存テーブルの既存の列と制約を変更しないこと」に反する。
--       この文は「アダプタが createUser を呼んだときに 500 にならない保険」だったが、
--       未登録者は signIn コールバックで先に落ちるため、createUser には到達しない
--       （@auth/core の callback ルートの実装で順序を確認済み）。
--       保険が無くても設計は成立するため、落とす方を採った。
-- ============================================================
