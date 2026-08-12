/* Phase 5 の DDL を実行する。docs/PHASE5_SCHEMA.sql の内容と一致させること。
   追加のみ。DROP / TRUNCATE / ALTER COLUMN は含めない。既存の表・列・制約・トリガーには触れない。
   実行前に対象を表示し、--apply を付けたときだけ実行する（J226）。
   接続先が tenko の DB であることを、実行前に必ず確かめる。 */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const APPLY = process.argv.includes("--apply");

const STATEMENTS = [
  `ALTER TABLE users ADD COLUMN name TEXT`,
  `ALTER TABLE users ADD COLUMN email TEXT`,
  `ALTER TABLE users ADD COLUMN "emailVerified" TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN image TEXT`,
  `CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL`,
  `ALTER TABLE users ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE users ADD CONSTRAINT users_demo_has_no_email
     CHECK (is_demo = false OR email IS NULL)`,
  `CREATE TABLE accounts (
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
   )`,
  `CREATE UNIQUE INDEX accounts_provider_uq ON accounts (provider, "providerAccountId")`,
  `CREATE INDEX accounts_user_idx ON accounts ("userId")`,
  `CREATE TABLE sessions (
     id             BIGSERIAL PRIMARY KEY,
     "userId"       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires        TIMESTAMPTZ NOT NULL,
     "sessionToken" VARCHAR(255) NOT NULL
   )`,
  `CREATE UNIQUE INDEX sessions_token_uq ON sessions ("sessionToken")`,
  `CREATE INDEX sessions_user_idx ON sessions ("userId")`,
  `CREATE TABLE verification_token (
     identifier TEXT NOT NULL,
     expires    TIMESTAMPTZ NOT NULL,
     token      TEXT NOT NULL,
     PRIMARY KEY (identifier, token)
   )`,
  `CREATE TABLE demo_presence (
     user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     state       TEXT NOT NULL DEFAULT 'idle'
                 CHECK (state IN ('idle','away','talking','resting')),
     talk        TEXT NOT NULL DEFAULT 'ok' CHECK (talk IN ('ok','later','focus')),
     room_id     BIGINT REFERENCES rooms(id),
     x           INTEGER NOT NULL,
     y           INTEGER NOT NULL,
     color_index INTEGER NOT NULL DEFAULT 1
   )`,
];

// 戻す場合の文。実行はしない（控えとして表示する）
const ROLLBACK = [
  `DROP TABLE IF EXISTS demo_presence`,
  `DROP TABLE IF EXISTS verification_token`,
  `DROP TABLE IF EXISTS sessions`,
  `DROP TABLE IF EXISTS accounts`,
  `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_demo_has_no_email`,
  `ALTER TABLE users DROP COLUMN IF EXISTS is_demo`,
  `DROP INDEX IF EXISTS users_email_uq`,
  `ALTER TABLE users DROP COLUMN IF EXISTS image`,
  `ALTER TABLE users DROP COLUMN IF EXISTS "emailVerified"`,
  `ALTER TABLE users DROP COLUMN IF EXISTS email`,
  `ALTER TABLE users DROP COLUMN IF EXISTS name`,
];

const FORBIDDEN = /\b(DROP|TRUNCATE|ALTER\s+COLUMN)\b/i;

// 実行前に、接続先が tenko の DB であることを確かめる。
// 隣のプロジェクトの DB に当ててしまう事故を、実行の前段で止める
const EXPECT_TABLES = ["attendance_drafts", "attendance_records", "messages", "rooms", "users"];

(async () => {
  console.log("実行しようとしている文: " + STATEMENTS.length + " 件");
  STATEMENTS.forEach((s, i) => {
    if (FORBIDDEN.test(s)) throw new Error("禁止された操作が含まれている: " + s.slice(0, 60));
    console.log("  " + (i + 1) + ") " + s.replace(/\s+/g, " ").slice(0, 100));
  });
  console.log("戻す場合の文（今は実行しない）:");
  ROLLBACK.forEach((s) => console.log("  - " + s));

  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  // 接続先の確認
  const { rows: dbrows } = await db.query("SELECT current_database() AS db");
  const { rows: trows } = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name = ANY($1) ORDER BY table_name`,
    [EXPECT_TABLES],
  );
  const found = trows.map((r) => r.table_name);
  console.log("\n接続先の database: " + dbrows[0].db);
  console.log("tenko の表として見つかったもの: " + found.join(", "));
  const missing = EXPECT_TABLES.filter((t) => !found.includes(t));
  if (missing.length > 0) {
    await db.end();
    throw new Error("tenko の DB ではない可能性がある（見つからない表: " + missing.join(", ") + "）");
  }

  // 既存のトリガーが変わっていないことを、実行の前後で見比べる
  const trigSql = `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`;
  const before = (await db.query(trigSql)).rows.map((r) => r.tgname);
  console.log("実行前のトリガー: " + before.join(", "));

  if (!APPLY) {
    console.log("\n--apply を付けていないため実行しませんでした");
    await db.end();
    return;
  }

  for (const s of STATEMENTS) {
    await db.query(s);
    console.log("OK: " + s.replace(/\s+/g, " ").slice(0, 70));
  }

  const after = (await db.query(trigSql)).rows.map((r) => r.tgname);
  console.log("\n実行後のトリガー: " + after.join(", "));
  console.log("トリガーは変わっていないか: " + (before.join(",") === after.join(",") ? "はい" : "いいえ（要確認）"));

  const { rows: cols } = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='users' ORDER BY ordinal_position`,
  );
  console.log("users の列: " + cols.map((c) => c.column_name).join(", "));
  const { rows: tabs } = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`,
  );
  console.log("表の一覧: " + tabs.map((t) => t.table_name).join(", "));
  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
