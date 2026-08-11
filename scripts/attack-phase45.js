/* 審査役A（機能4・5）+ 破壊試験（回帰）。
   実際に送って確かめる。実行: node scripts\attack-phase45.js */
const fs = require("fs");
const { Client } = require("pg");
const WebSocket = require("ws");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const API = "http://localhost:3000";
const log = (s) => console.log(s);
const jget = async (u) => { const r = await fetch(API + u); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const jpost = async (u, body, method = "POST") => {
  const r = await fetch(API + u, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const id = async (name) => Number((await db.query("SELECT id FROM users WHERE display_name=$1", [name])).rows[0].id);
  const member = await id("検証 部下");
  const manager = await id("検証 上長");
  const other = await id("検証 無関係");
  const otherMgr = await id("検証 別上長");
  const admin = await id("検証 管理者");
  log(`部下=${member} 上長=${manager} 無関係=${other} 別上長=${otherMgr} 管理者=${admin}`);

  log("");
  log("=== 機能4: 勤怠異常。他人の分が混ざらないか（S4）===");
  for (const [label, uid] of [["部下(member)", member], ["無関係(member)", other], ["別上長(manager)", otherMgr], ["担当上長(manager)", manager], ["管理者(admin)", admin]]) {
    const { status, j } = await jget("/api/attendance/anomalies?user=" + uid);
    const scope = (j.scope ?? []).join(",");
    const users = [...new Set((j.anomalies ?? []).map((a) => a.userId))].join(",");
    log(`  ${label.padEnd(18)} status=${status} 見える範囲=[${scope}] 実際に出た利用者=[${users}]`);
  }
  log("  部下の分を、無関係な member が target 指定で取れるか:");
  const t1 = await jget(`/api/attendance/anomalies?user=${other}&target=${member}`);
  log(`    status=${t1.status} ${t1.j.error ? "「" + t1.j.error + "」" : JSON.stringify(t1.j.anomalies)}`);
  const t2 = await jget(`/api/attendance/anomalies?user=${manager}&target=${member}`);
  log(`    担当上長が同じことをした場合: status=${t2.status} 件数=${(t2.j.anomalies ?? []).length}`);

  log("");
  log("=== 機能4: 記録を書き換えていないか（読み取りのみ）===");
  const before = (await db.query("SELECT id, status, event_at FROM attendance_records ORDER BY id")).rows;
  await jget("/api/attendance/anomalies?user=" + admin);
  const after = (await db.query("SELECT id, status, event_at FROM attendance_records ORDER BY id")).rows;
  log("  異常検出の前後で attendance_records が同一か: " + (JSON.stringify(before) === JSON.stringify(after)));

  log("");
  log("=== 機能5: 修正申請 ===");
  const own = (await db.query("SELECT id, kind, status FROM attendance_records WHERE user_id=$1 AND corrects_record_id IS NULL ORDER BY id LIMIT 1", [member])).rows[0];
  log("  対象にする自分の記録: " + JSON.stringify(own));

  const bad = [
    ["理由なし", { user: member, kind: "leave", eventAt: "2026-08-11T18:00:00+09:00", reason: "" }],
    ["kindが不正", { user: member, kind: "vacation", eventAt: "2026-08-11T18:00:00+09:00", reason: "テスト" }],
    ["日時が不正", { user: member, kind: "leave", eventAt: "きのう", reason: "テスト" }],
    ["理由が長すぎる", { user: member, kind: "leave", eventAt: "2026-08-11T18:00:00+09:00", reason: "あ".repeat(201) }],
    ["他人の記録を指す", { user: other, kind: "leave", eventAt: "2026-08-11T18:00:00+09:00", reason: "他人の記録を直したい", correctsRecordId: own.id }],
  ];
  for (const [label, body] of bad) {
    const { status, j } = await jpost("/api/attendance/corrections", body);
    log(`  ${label.padEnd(16)} status=${status} ${j.error ? "「" + j.error + "」" : JSON.stringify(j.correction)}`);
  }

  const ok = await jpost("/api/attendance/corrections", {
    user: member, kind: "leave", eventAt: "2026-08-11T18:30:00+09:00",
    reason: "退勤を押し忘れました", correctsRecordId: own.id,
  });
  log("  正しい申請: status=" + ok.status + " " + JSON.stringify(ok.j.correction));
  const corrId = ok.j.correction ? Number(ok.j.correction.id) : null;

  log("");
  log("=== 機能5: 元の記録が書き換わっていないか ===");
  const orig = (await db.query("SELECT id, status, event_at FROM attendance_records WHERE id=$1", [own.id])).rows[0];
  log("  元の記録: " + JSON.stringify(orig) + "（申請前と同じであること）");

  log("");
  log("=== 機能5: 承認は Phase 4 の仕組みを通るか / 権限は守られるか ===");
  if (corrId) {
    for (const [label, uid] of [["本人(member)", member], ["無関係(member)", other], ["別上長(manager)", otherMgr]]) {
      const { status, j } = await jpost("/api/attendance/approvals/" + corrId, { action: "approve", user: uid });
      log(`  ${label.padEnd(18)} が承認 -> status=${status} ${j.error ? "「" + j.error + "」" : ""}`);
    }
    const okAp = await jpost("/api/attendance/approvals/" + corrId, { action: "approve", user: manager });
    log("  担当上長が承認 -> status=" + okAp.status + " " + JSON.stringify(okAp.j.record));
  }

  log("");
  log("=== 機能5: 月次で二重計上されないか ===");
  const wd = (await db.query("SELECT work_date::text d FROM attendance_records WHERE id=$1", [own.id])).rows[0].d;
  const [y, mo] = wd.split("-").map(Number);
  const csv = await (await fetch(`${API}/api/attendance/monthly?actor=${member}&year=${y}&month=${mo}`)).text();
  csv.trim().split("\n").forEach((l) => log("    " + l));
  const rowsNow = (await db.query(
    `SELECT id, kind, to_char(event_at AT TIME ZONE 'Asia/Tokyo','HH24:MI') t, status, corrects_record_id
       FROM attendance_records WHERE user_id=$1 ORDER BY id`, [member])).rows;
  log("  DBの記録: " + JSON.stringify(rowsNow));

  log("");
  log("=== 破壊試験（回帰）===");
  // 1) WS 経由で投稿を保存できないこと
  const wsc = new WebSocket("ws://localhost:8080");
  await new Promise((r) => wsc.on("open", r));
  const msgBefore = (await db.query("SELECT count(*)::int n FROM messages")).rows[0].n;
  wsc.send(JSON.stringify({ type: "message.created", message: { id: 9999, room_id: 1, body: "WS経由の偽投稿" } }));
  await new Promise((r) => setTimeout(r, 500));
  const msgAfter = (await db.query("SELECT count(*)::int n FROM messages")).rows[0].n;
  log("  WS経由の偽投稿: messages " + msgBefore + " -> " + msgAfter + "（増えていなければ弾かれている）");
  wsc.close();

  // 2) 承認済みの記録が変更できないこと
  const approved = (await db.query("SELECT id FROM attendance_records WHERE status='approved' ORDER BY id LIMIT 1")).rows[0];
  if (approved) {
    try { await db.query("UPDATE attendance_records SET event_at=now() WHERE id=$1", [approved.id]); log("  承認済みの UPDATE: 通ってしまった"); }
    catch (e) { log("  承認済みの UPDATE: 例外 -> " + e.message); }
  }
  // 3) 確定・却下済みの下書きが変更できないこと
  const dec = (await db.query("SELECT id FROM attendance_drafts WHERE status<>'pending' ORDER BY id LIMIT 1")).rows[0];
  if (dec) {
    try { await db.query("UPDATE attendance_drafts SET status='pending' WHERE id=$1", [dec.id]); log("  確定済みの下書きの UPDATE: 通ってしまった"); }
    catch (e) { log("  確定済みの下書きの UPDATE: 例外 -> " + e.message); }
  }
  // 4) 他人の勤怠を承認できないこと（4通り）
  const sub = (await db.query("SELECT id FROM attendance_records WHERE status='submitted' AND user_id=$1 ORDER BY id LIMIT 1", [member])).rows[0];
  if (sub) {
    for (const [label, uid] of [["本人(member)", member], ["無関係(member)", other], ["別上長(manager)", otherMgr], ["担当上長(manager)", manager]]) {
      const { status } = await jpost("/api/attendance/approvals/" + sub.id, { action: "approve", user: uid });
      const st = (await db.query("SELECT status FROM attendance_records WHERE id=$1", [sub.id])).rows[0].status;
      log(`  ${label.padEnd(18)} -> status=${status} 記録=${st}`);
    }
  } else {
    log("  承認待ちの記録が無いため、この回は測れなかった");
  }

  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
