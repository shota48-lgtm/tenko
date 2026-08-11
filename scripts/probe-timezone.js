/* 事前確定事項の実測: work_date が実際にどのタイムゾーンで決まっているか。
   方針を決める前に、既存の実装が何をしているかを測る。 */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const s = (await db.query("SHOW timezone")).rows[0];
  console.log("DBサーバーの timezone 設定: " + JSON.stringify(s));
  console.log("DBの現在時刻: " + JSON.stringify((await db.query("SELECT now() AS utc, now() AT TIME ZONE 'Asia/Tokyo' AS jst")).rows[0]));
  console.log("Node の現在時刻: " + new Date().toISOString() + " / ローカル表記 " + new Date().toString().slice(0, 33));

  console.log("");
  console.log("--- 境界の実測: 日本時間の 00:30 と 23:30 が、どの work_date になるか ---");
  const cases = [
    ["2026-08-12T00:30:00+09:00", "日本時間 8/12 00:30（UTCでは 8/11）"],
    ["2026-08-12T23:30:00+09:00", "日本時間 8/12 23:30（UTCでは 8/12 14:30）"],
    ["2026-08-13T08:59:00+09:00", "日本時間 8/13 08:59"],
  ];
  for (const [iso, label] of cases) {
    const r = await db.query(
      `SELECT $1::timestamptz AS ts,
              ($1::timestamptz AT TIME ZONE 'Asia/Tokyo')::date AS jst_date,
              ($1::timestamptz)::date AS db_default_date`,
      [iso]);
    console.log("  " + label);
    console.log("    JST基準の日付 = " + String(r.rows[0].jst_date).slice(0, 10) + " / DB既定の日付 = " + String(r.rows[0].db_default_date).slice(0, 10));
  }

  console.log("");
  console.log("--- 既存の attendance_records の実際の値 ---");
  const rows = (await db.query(
    `SELECT id, work_date::text AS work_date,
            to_char(event_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS jst,
            to_char(event_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS utc
       FROM attendance_records ORDER BY id`)).rows;
  for (const r of rows) console.log("  id=" + r.id + " work_date=" + r.work_date + " JST=" + r.jst + " UTC=" + r.utc);

  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
