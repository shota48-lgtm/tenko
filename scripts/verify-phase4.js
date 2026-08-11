/* 作業5 の 1〜7 の検証。PHASE4_SCHEMA.sql を実行してから使う。
   実行: node scripts\verify-phase4.js
   前提: next dev が起動していること */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const API = "http://localhost:3000";
const log = (s) => console.log(s);
const uuid = (n) => "cccccccc-0000-4000-8000-" + String(n).padStart(12, "0");

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const t = (await db.query("SELECT to_regclass('public.attendance_records') AS t")).rows[0].t;
  const col = (await db.query(
    "SELECT count(*)::int n FROM information_schema.columns WHERE table_name='users' AND column_name='manager_id'")).rows[0].n;
  if (!t || col === 0) {
    log("attendance_records か users.manager_id が無い。POのDDL実行待ち。");
    process.exit(2);
  }

  log("=== 準備: 本人(member)と上長(manager)、無関係な member を用意する ===");
  const ensure = async (name, role) => {
    const r = await db.query("SELECT id FROM users WHERE display_name=$1", [name]);
    if (r.rows.length) return Number(r.rows[0].id);
    const i = await db.query("INSERT INTO users (display_name, role) VALUES ($1,$2) RETURNING id", [name, role]);
    return Number(i.rows[0].id);
  };
  const member = await ensure("検証 部下", "member");
  const manager = await ensure("検証 上長", "manager");
  const other = await ensure("検証 無関係", "member");
  await db.query("UPDATE users SET manager_id=$1 WHERE id=$2", [manager, member]);
  await db.query("UPDATE users SET role='member' WHERE id=$1", [member]);
  log(`  部下=${member} 上長=${manager} 無関係=${other}`);

  const post = async (cid, body, userId) => {
    const before = process.env.TENKO_DEV_USER_ID;
    const r = await fetch(API + "/api/rooms/1/messages", {
      method: "POST", headers: { "Content-Type": "application/json", "x-tenko-user": String(userId) },
      body: JSON.stringify({ clientMsgId: cid, body }),
    });
    return { status: r.status, json: await r.json(), before };
  };

  log("=== 1. 本人が確定した記録が承認待ちの一覧に現れるか ===");
  /* 発言 -> 下書き -> 本人が確定 -> 承認待ち */
  const m1 = await post(uuid(1), "おはようございます", member);
  const msgId = Number(m1.json.message.id);
  await db.query("UPDATE messages SET user_id=$1 WHERE id=$2", [member, msgId]);
  await db.query("UPDATE attendance_drafts SET user_id=$1 WHERE message_id=$2", [member, msgId]);
  const draftId = Number((await db.query("SELECT id FROM attendance_drafts WHERE message_id=$1", [msgId])).rows[0].id);
  const conf = await fetch(API + "/api/attendance/drafts/" + draftId, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "confirm", user: member }),
  });
  const confJson = await conf.json();
  log("  確定: status=" + conf.status + " record=" + JSON.stringify(confJson.record));
  const list = await (await fetch(API + "/api/attendance/approvals?user=" + manager)).json();
  const found = (list.items ?? []).find((x) => Number(x.id) === Number(confJson.record.id));
  log("  上長の承認待ち一覧に現れたか: " + (found ? "はい" : "いいえ"));
  if (found) log("    根拠の発言: 「" + found.source_body + "」 / 本人の確定: " + found.confirmed_at);
  const recordId = Number(confJson.record.id);

  log("=== 2. 未承認として月次に現れるか ===");
  const wd = (await db.query("SELECT work_date::text d FROM attendance_records WHERE id=$1", [recordId])).rows[0].d;
  const [y, mo] = wd.split("-").map(Number);
  const csv1 = await (await fetch(`${API}/api/attendance/monthly?actor=${member}&year=${y}&month=${mo}`)).text();
  log("  CSV(未承認の状態):");
  csv1.trim().split("\n").forEach((l) => log("    " + l));

  log("=== 3. member が他人の記録を承認しようとしたとき ===");
  for (const [who, id] of [["無関係な member", other], ["本人(member)", member]]) {
    const r = await fetch(API + "/api/attendance/approvals/" + recordId, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve", user: id }),
    });
    log("  " + who + " が承認: status=" + r.status + " " + JSON.stringify(await r.json()));
  }
  const st1 = (await db.query("SELECT status FROM attendance_records WHERE id=$1", [recordId])).rows[0].status;
  log("  記録の状態: " + st1 + "（submitted のままなら拒否されている）");
  const listByMember = await fetch(API + "/api/attendance/approvals?user=" + other);
  log("  member が一覧を取得: status=" + listByMember.status);

  log("=== 4. 差し戻し -> 本人が再確定 ===");
  const ret = await fetch(API + "/api/attendance/approvals/" + recordId, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "return", reason: "出社時刻が実際と違います", user: manager }),
  });
  log("  差し戻し: status=" + ret.status + " " + JSON.stringify(await ret.json()));
  const retNoReason = await fetch(API + "/api/attendance/approvals/" + recordId, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "return", reason: "   ", user: manager }),
  });
  log("  理由なしの差し戻し: status=" + retNoReason.status + "（400 が正しい）");
  const re = await fetch(API + "/api/attendance/approvals/" + recordId, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "resubmit", user: member }),
  });
  log("  本人が再確定: status=" + re.status + " " + JSON.stringify(await re.json()));

  log("=== 6. 時間が経っても自動で承認されないか ===");
  const before = (await db.query("SELECT status FROM attendance_records WHERE id=$1", [recordId])).rows[0].status;
  await new Promise((r) => setTimeout(r, 3000));
  const after = (await db.query("SELECT status FROM attendance_records WHERE id=$1", [recordId])).rows[0].status;
  log("  3秒前=" + before + " / 3秒後=" + after + "（変わっていなければ自動承認しない）");

  log("=== 上長が承認する ===");
  const ap = await fetch(API + "/api/attendance/approvals/" + recordId, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve", user: manager }),
  });
  log("  承認: status=" + ap.status + " " + JSON.stringify(await ap.json()));

  log("=== 5. 承認済みを本人が書き換えられるか ===");
  const re2 = await fetch(API + "/api/attendance/approvals/" + recordId, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "resubmit", user: member }),
  });
  log("  本人が再確定を試みる: status=" + re2.status + "（409 が正しい）");
  try {
    await db.query("UPDATE attendance_records SET event_at = now() WHERE id=$1", [recordId]);
    log("  DBを直接UPDATE: 通ってしまった");
  } catch (e) {
    log("  DBを直接UPDATE: 例外 -> " + e.message);
  }
  try {
    const d = await db.query("DELETE FROM attendance_records WHERE id=$1", [recordId]);
    log("  DBを直接DELETE: rowCount=" + d.rowCount + "（0 でも消えていないので要確認）");
  } catch (e) {
    log("  DBを直接DELETE: 例外 -> " + e.message);
  }

  log("=== 7. 月次CSVが実際のデータと一致するか ===");
  const rows = (await db.query(
    `SELECT id, kind, to_char(event_at AT TIME ZONE 'Asia/Tokyo','YYYY-MM-DD HH24:MI') AS t, work_date::text AS d, status
       FROM attendance_records WHERE user_id=$1 ORDER BY id`, [member])).rows;
  log("  DBの記録: " + JSON.stringify(rows));
  const csv2 = await (await fetch(`${API}/api/attendance/monthly?actor=${member}&year=${y}&month=${mo}`)).text();
  log("  CSV(承認後):");
  csv2.trim().split("\n").forEach((l) => log("    " + l));
  const json = await (await fetch(`${API}/api/attendance/monthly?actor=${member}&year=${y}&month=${mo}&format=json`)).json();
  log("  集計: " + JSON.stringify(json.total));

  log("=== 補足: 他人の月次を member が見られるか ===");
  const mo2 = await fetch(`${API}/api/attendance/monthly?actor=${other}&user=${member}&year=${y}&month=${mo}`);
  log("  無関係な member が他人の月次: status=" + mo2.status + "（403 が正しい）");
  const mo3 = await fetch(`${API}/api/attendance/monthly?actor=${manager}&user=${member}&year=${y}&month=${mo}`);
  log("  上長が部下の月次: status=" + mo3.status + "（200 が正しい）");

  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
