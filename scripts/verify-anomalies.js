/* 機能4の確認: 3種類の異常が実際に検出されるか。
   検証用のデータを入れて測り、最後に入れた分だけ消す（--keep で残せる）。 */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const API = "http://localhost:3000";
const KEEP = process.argv.includes("--keep");
const log = (s) => console.log(s);

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const member = Number((await db.query("SELECT id FROM users WHERE display_name='検証 部下'")).rows[0].id);
  const manager = Number((await db.query("SELECT id FROM users WHERE display_name='検証 上長'")).rows[0].id);
  const other = Number((await db.query("SELECT id FROM users WHERE display_name='検証 無関係'")).rows[0].id);

  const made = [];
  const add = async (kind, iso, status = "approved") => {
    const r = await db.query(
      `INSERT INTO attendance_records (user_id, kind, event_at, work_date, status, confirmed_at, approved_at, approved_by)
       VALUES ($1,$2,$3::timestamptz,($3::timestamptz AT TIME ZONE 'Asia/Tokyo')::date,$4,now(),
               CASE WHEN $4='approved' THEN now() ELSE NULL END,
               CASE WHEN $4='approved' THEN $5::bigint ELSE NULL END)
       RETURNING id`, [member, kind, iso, status, manager]);
    made.push(Number(r.rows[0].id));
    return Number(r.rows[0].id);
  };

  log("=== 検証用のデータを入れる ===");
  // 1) 退勤のない日（2日前）
  await add("arrive", "2026-08-10T09:05:00+09:00");
  // 2) 勤務が長い日（3日前。9:00 -> 23:30 = 14.5時間）
  await add("arrive", "2026-08-09T09:00:00+09:00");
  await add("leave", "2026-08-09T23:30:00+09:00");
  log("  入れた記録: " + JSON.stringify(made));

  // 3) 出社の記録がないのに発言がある日（4日前）
  const msg = await db.query(
    `INSERT INTO messages (room_id, user_id, client_msg_id, body, created_at)
     VALUES (1, $1, gen_random_uuid(), '出社の記録がない日の発言', '2026-08-08T10:00:00+09:00')
     RETURNING id`, [member]);
  const msgId = Number(msg.rows[0].id);
  log("  入れた発言: id=" + msgId);

  log("");
  log("=== 本人から見た異常 ===");
  const r1 = await (await fetch(`${API}/api/attendance/anomalies?user=${member}`)).json();
  log("  閾値: " + JSON.stringify(r1.thresholds));
  for (const a of r1.anomalies) log(`  ${a.workDate} ${a.displayName}: [${a.kind}] ${a.detail}`);

  log("");
  log("=== 担当上長から見た異常（部下の分が見える）===");
  const r2 = await (await fetch(`${API}/api/attendance/anomalies?user=${manager}`)).json();
  log("  見える範囲=" + JSON.stringify(r2.scope) + " 件数=" + r2.anomalies.length);
  for (const a of r2.anomalies) log(`  ${a.workDate} ${a.displayName}: [${a.kind}] ${a.detail}`);

  log("");
  log("=== 無関係な member から見た異常（他人の分は出ない）===");
  const r3 = await (await fetch(`${API}/api/attendance/anomalies?user=${other}`)).json();
  log("  見える範囲=" + JSON.stringify(r3.scope) + " 件数=" + r3.anomalies.length +
    " 出た利用者=" + JSON.stringify([...new Set(r3.anomalies.map((a) => a.userId))]));

  log("");
  log("=== 今日の分が「退勤がない」に含まれないか（まだ勤務中の可能性）===");
  const todayId = await add("arrive", new Date().toISOString());
  const r4 = await (await fetch(`${API}/api/attendance/anomalies?user=${member}`)).json();
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const todays = r4.anomalies.filter((a) => a.workDate === today && a.kind === "no_leave");
  log("  今日(" + today + ")の no_leave: " + todays.length + " 件（0 なら今日は除外できている）");

  if (!KEEP) {
    log("");
    log("=== 後片付け ===");
    for (const id of made) {
      try { await db.query("DELETE FROM attendance_records WHERE id=$1", [id]); }
      catch (e) { log("  id=" + id + " は消せない: " + e.message.slice(0, 40)); }
    }
    await db.query("DELETE FROM messages WHERE id=$1", [msgId]);
    const left = (await db.query("SELECT count(*)::int n FROM attendance_records WHERE id = ANY($1::bigint[])", [made])).rows[0].n;
    log("  残った検証用の記録: " + left + " 件（承認済みはトリガーで消せないため残る）");
  }

  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
