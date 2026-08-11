/* 機能5の本筋の確認: 種別が同じ正しい修正申請が、承認されると月次に反映されること。
   併せて、種別違いが弾かれることも確かめる。 */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const API = "http://localhost:3000";
const log = (s) => console.log(s);
const post = async (u, b) => {
  const r = await fetch(API + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const member = Number((await db.query("SELECT id FROM users WHERE display_name='検証 部下'")).rows[0].id);
  const manager = Number((await db.query("SELECT id FROM users WHERE display_name='検証 上長'")).rows[0].id);

  const leave = (await db.query(
    `SELECT id, kind, to_char(event_at AT TIME ZONE 'Asia/Tokyo','YYYY-MM-DD HH24:MI') t, work_date::text d, status
       FROM attendance_records
      WHERE user_id=$1 AND kind='leave' AND corrects_record_id IS NULL ORDER BY id LIMIT 1`, [member])).rows[0];
  log("直す対象（退勤の記録）: " + JSON.stringify(leave));
  const [y, mo] = leave.d.split("-").map(Number);

  const csvBefore = await (await fetch(`${API}/api/attendance/monthly?actor=${member}&year=${y}&month=${mo}`)).text();
  log("");
  log("修正前の月次:");
  csvBefore.trim().split("\n").forEach((l) => log("  " + l));

  log("");
  log("=== 種別違いは弾かれるか ===");
  const wrong = await post("/api/attendance/corrections", {
    user: member, kind: "arrive", eventAt: leave.d + "T19:00:00+09:00",
    reason: "種別違いのテスト", correctsRecordId: leave.id,
  });
  log("  退勤の記録を arrive で直す -> status=" + wrong.status + " 「" + (wrong.j.error ?? "") + "」");

  log("");
  log("=== 正しい修正申請（退勤 -> 退勤の時刻を直す）===");
  const ok = await post("/api/attendance/corrections", {
    user: member, kind: "leave", eventAt: leave.d + "T19:15:00+09:00",
    reason: "退勤を押し忘れ、実際は19:15でした", correctsRecordId: leave.id,
  });
  log("  申請 -> status=" + ok.status + " " + JSON.stringify(ok.j.correction));
  const cid = Number(ok.j.correction.id);

  log("");
  log("=== 承認前の月次（元の記録がまだ生きているか）===");
  const csvMid = await (await fetch(`${API}/api/attendance/monthly?actor=${member}&year=${y}&month=${mo}`)).text();
  csvMid.trim().split("\n").filter((l) => l.startsWith(leave.d) || l.startsWith("# 注意")).forEach((l) => log("  " + l));

  log("");
  log("=== 上長が承認 ===");
  const ap = await post("/api/attendance/approvals/" + cid, { action: "approve", user: manager });
  log("  status=" + ap.status + " " + JSON.stringify(ap.j.record));

  log("");
  log("=== 承認後の月次（差し替わっているか）===");
  const csvAfter = await (await fetch(`${API}/api/attendance/monthly?actor=${member}&year=${y}&month=${mo}`)).text();
  csvAfter.trim().split("\n").forEach((l) => log("  " + l));

  log("");
  log("=== 元の記録は消えていないか（履歴として残る）===");
  const rows = (await db.query(
    `SELECT id, kind, to_char(event_at AT TIME ZONE 'Asia/Tokyo','HH24:MI') t, status, corrects_record_id, correction_reason
       FROM attendance_records WHERE user_id=$1 ORDER BY id`, [member])).rows;
  rows.forEach((r) => log("  " + JSON.stringify(r)));

  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
