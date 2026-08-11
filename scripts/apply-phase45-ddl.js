/* Phase 4.5 の DDL を実行する。docs/PHASE45_SCHEMA.sql の内容と一致させること。
   追加のみ。DROP / TRUNCATE は含めない。既存の列・制約・トリガーには触れない。
   実行前に対象を表示し、--apply を付けたときだけ実行する（J226）。 */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const APPLY = process.argv.includes("--apply");

const STATEMENTS = [
  `CREATE TABLE daily_notes (
     id         BIGSERIAL PRIMARY KEY,
     user_id    BIGINT NOT NULL REFERENCES users(id),
     note_date  DATE   NOT NULL,
     body       TEXT   NOT NULL CHECK (char_length(body) BETWEEN 1 AND 80),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX daily_notes_user_date_uq ON daily_notes (user_id, note_date)`,
  `ALTER TABLE attendance_records ADD COLUMN corrects_record_id BIGINT REFERENCES attendance_records(id)`,
  `ALTER TABLE attendance_records ADD COLUMN correction_reason TEXT`,
  `CREATE INDEX attendance_records_corrects_idx ON attendance_records (corrects_record_id) WHERE corrects_record_id IS NOT NULL`,
];

const FORBIDDEN = /\b(DROP|TRUNCATE|ALTER\s+COLUMN|DROP\s+COLUMN)\b/i;

(async () => {
  console.log("実行しようとしている文: " + STATEMENTS.length + " 件");
  STATEMENTS.forEach((s, i) => {
    if (FORBIDDEN.test(s)) throw new Error("禁止された操作が含まれている: " + s.slice(0, 60));
    console.log("  " + (i + 1) + ") " + s.replace(/\s+/g, " ").slice(0, 110));
  });
  if (!APPLY) {
    console.log("");
    console.log("--apply を付けて実行すると適用する。今回は実行していない。");
    return;
  }

  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  for (const s of STATEMENTS) {
    try {
      await db.query(s);
      console.log("OK: " + s.replace(/\s+/g, " ").slice(0, 70));
    } catch (e) {
      console.log("NG: " + s.replace(/\s+/g, " ").slice(0, 70) + " -> " + e.message);
    }
  }
  const t = (await db.query("SELECT to_regclass('public.daily_notes') AS t")).rows[0].t;
  const cols = (await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='attendance_records' AND column_name IN ('corrects_record_id','correction_reason')
      ORDER BY column_name`)).rows.map((r) => r.column_name);
  console.log("");
  console.log("daily_notes: " + (t ? "あり" : "なし"));
  console.log("attendance_records の追加列: " + JSON.stringify(cols));
  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
