/* Phase 4.9 の DDL を実行する。docs/PHASE49_SCHEMA.sql の内容と一致させること。
   追加のみ。DROP / TRUNCATE / ALTER COLUMN は含めない。既存の表・列・制約・トリガーには触れない。
   実行前に対象を表示し、--apply を付けたときだけ実行する（J226）。 */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const APPLY = process.argv.includes("--apply");

const STATEMENTS = [
  `CREATE TABLE announcements (
     id         BIGSERIAL PRIMARY KEY,
     user_id    BIGINT NOT NULL REFERENCES users(id),
     body       TEXT   NOT NULL CHECK (char_length(body) BETWEEN 1 AND 200),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     deleted_at TIMESTAMPTZ
   )`,
  `CREATE INDEX announcements_live_idx ON announcements (created_at DESC) WHERE deleted_at IS NULL`,
  `CREATE TABLE announcement_reads (
     user_id                   BIGINT NOT NULL REFERENCES users(id),
     last_read_announcement_id BIGINT NOT NULL DEFAULT 0,
     updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (user_id)
   )`,
];

// 戻す場合の文。実行はしない（控えとして表示する）
const ROLLBACK = [
  `DROP TABLE IF EXISTS announcement_reads`,
  `DROP TABLE IF EXISTS announcements`,
];

const FORBIDDEN = /\b(DROP|TRUNCATE|ALTER\s+COLUMN)\b/i;

(async () => {
  console.log("実行しようとしている文: " + STATEMENTS.length + " 件");
  STATEMENTS.forEach((s, i) => {
    if (FORBIDDEN.test(s)) throw new Error("禁止された操作が含まれている: " + s.slice(0, 60));
    console.log("  " + (i + 1) + ") " + s.replace(/\s+/g, " ").slice(0, 90));
  });
  console.log("戻す場合の文（今は実行しない）:");
  ROLLBACK.forEach((s) => console.log("  - " + s));

  if (!APPLY) {
    console.log("\n--apply を付けていないため実行しませんでした");
    return;
  }
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  for (const s of STATEMENTS) {
    await db.query(s);
    console.log("OK: " + s.replace(/\s+/g, " ").slice(0, 60));
  }
  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name LIKE 'announcement%' ORDER BY table_name`,
  );
  console.log("\n作られた表: " + rows.map((r) => r.table_name).join(", "));
  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
