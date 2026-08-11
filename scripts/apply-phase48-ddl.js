/* Phase 4.8 の DDL を実行する。docs/PHASE48_SCHEMA.sql の内容と一致させること。
   追加のみ。DROP / TRUNCATE / ALTER COLUMN は含めない。既存の列・制約・トリガーには触れない。
   実行前に対象を表示し、--apply を付けたときだけ実行する（J226）。 */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const APPLY = process.argv.includes("--apply");

const STATEMENTS = [
  `ALTER TABLE rooms ADD COLUMN capacity integer NOT NULL DEFAULT 4`,
  `UPDATE rooms SET capacity = 12 WHERE kind = 'hall'`,
  `ALTER TABLE rooms ADD CONSTRAINT rooms_capacity_range CHECK (capacity BETWEEN 1 AND 100)`,
];

// ロールバックはここに書いてから実行する（実行はしない。控えとして表示する）
const ROLLBACK = [
  `ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_capacity_range`,
  `ALTER TABLE rooms DROP COLUMN IF EXISTS capacity`,
];

const FORBIDDEN = /\b(DROP|TRUNCATE|ALTER\s+COLUMN)\b/i;

(async () => {
  console.log("実行しようとしている文: " + STATEMENTS.length + " 件");
  STATEMENTS.forEach((s, i) => {
    if (FORBIDDEN.test(s)) throw new Error("禁止された操作が含まれている: " + s.slice(0, 60));
    console.log("  " + (i + 1) + ") " + s.replace(/\s+/g, " "));
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
    console.log("OK: " + s.replace(/\s+/g, " ").slice(0, 70));
  }
  const { rows } = await db.query("SELECT id, name, kind, capacity FROM rooms ORDER BY id");
  console.log("\n実行後の rooms:");
  for (const r of rows) console.log(`  id=${r.id} ${r.name} kind=${r.kind} capacity=${r.capacity}`);
  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
