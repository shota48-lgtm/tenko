/* Phase 5 作業0 の DDL: デモ用の「今日やること」を日付から切り離す。
   追加のみ。DROP / TRUNCATE / ALTER COLUMN は含めない。
   実行前に対象を表示し、--apply を付けたときだけ実行する（J226）。

   なぜ:
     デモ用の吹き出しは daily_notes（日付ごと）に入っていた。
     日付が変わると20人ぶんの吹き出しが全部消え、村が静かになる。
     **デモ用の利用者は「今日」を持たない存在**なので、日付を持たない列に移す。 */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const APPLY = process.argv.includes("--apply");

const STATEMENTS = [
  // 日付を持たない「今日やること」。デモ用の利用者だけが使う
  `ALTER TABLE demo_presence ADD COLUMN note TEXT`,
];

// 戻す場合の文（実行はしない。控えとして表示する）
const ROLLBACK = [
  `ALTER TABLE demo_presence DROP COLUMN IF EXISTS note`,
];

const FORBIDDEN = /\b(DROP|TRUNCATE|ALTER\s+COLUMN)\b/i;
const EXPECT_TABLES = ["attendance_drafts", "attendance_records", "demo_presence", "messages", "users"];

(async () => {
  console.log("実行しようとしている文: " + STATEMENTS.length + " 件");
  STATEMENTS.forEach((s, i) => {
    if (FORBIDDEN.test(s)) throw new Error("禁止された操作が含まれている: " + s.slice(0, 60));
    console.log("  " + (i + 1) + ") " + s);
  });
  console.log("戻す場合の文（今は実行しない）:");
  ROLLBACK.forEach((s) => console.log("  - " + s));

  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const { rows: dbrows } = await db.query("SELECT current_database() AS db");
  const { rows: trows } = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name = ANY($1) ORDER BY table_name`, [EXPECT_TABLES]);
  const found = trows.map((r) => r.table_name);
  console.log("\n接続先の database: " + dbrows[0].db);
  console.log("tenko の表として見つかったもの: " + found.join(", "));
  const missing = EXPECT_TABLES.filter((t) => !found.includes(t));
  if (missing.length > 0) { await db.end(); throw new Error("tenko の DB ではない可能性がある: " + missing.join(", ")); }

  const trigSql = `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`;
  const before = (await db.query(trigSql)).rows.map((r) => r.tgname);
  console.log("実行前のトリガー: " + before.join(", "));

  if (!APPLY) { console.log("\n--apply を付けていないため実行しませんでした"); await db.end(); return; }

  for (const s of STATEMENTS) { await db.query(s); console.log("OK: " + s); }

  // 段階4-5 で daily_notes に入れたデモ用の内容を、新しい列へ写す（内容は流用する）
  const moved = await db.query(
    `UPDATE demo_presence d
        SET note = n.body
       FROM daily_notes n
       JOIN users u ON u.id = n.user_id
      WHERE n.user_id = d.user_id AND u.is_demo = true
        AND n.note_date = (now() AT TIME ZONE 'Asia/Tokyo')::date`);
  console.log("daily_notes から写した件数: " + moved.rowCount);

  const after = (await db.query(trigSql)).rows.map((r) => r.tgname);
  console.log("実行後のトリガー: " + after.join(", "));
  console.log("トリガーは変わっていないか: " + (before.join(",") === after.join(",") ? "はい" : "いいえ（要確認）"));
  const { rows: cols } = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='demo_presence' ORDER BY ordinal_position`);
  console.log("demo_presence の列: " + cols.map((c) => c.column_name).join(", "));
  const { rows: n } = await db.query("SELECT count(*)::int c FROM demo_presence WHERE note IS NOT NULL");
  console.log("note が入っている行: " + n[0].c);
  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
