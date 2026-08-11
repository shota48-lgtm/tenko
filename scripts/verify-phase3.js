// 作業5 の 1〜6 の検証。attendance_drafts が作られてから実行する。
// 実行: node scripts\verify-phase3.js
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const API = "http://localhost:3000";
const uuid = (n) => "aaaaaaaa-0000-4000-8000-" + String(n).padStart(12, "0");
const log = (s) => console.log(s);

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const exists = (await db.query("SELECT to_regclass('public.attendance_drafts') AS t")).rows[0].t;
  if (!exists) { console.log("attendance_drafts が無い。POのDDL実行待ち。"); process.exit(2); }

  const post = async (cid, body) => {
    const r = await fetch(API + "/api/rooms/1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientMsgId: cid, body }),
    });
    return { status: r.status, json: await r.json() };
  };
  const drafts = async (status) => (await (await fetch(API + "/api/attendance/drafts" + (status ? "?status=" + status : ""))).json()).drafts;

  log("=== 1. 「おはようございます」で出社の下書きが立つか ===");
  const a = await post(uuid(101), "おはようございます");
  log("  POST: status=" + a.status + " draft=" + JSON.stringify(a.json.draft));
  const rows1 = (await db.query("SELECT id, kind, status, rule_id, event_at FROM attendance_drafts WHERE message_id=$1", [a.json.message.id])).rows;
  log("  DB: " + JSON.stringify(rows1));

  log("=== 2. 同じ client_msg_id で再送しても二重に立たないか ===");
  const a2 = await post(uuid(101), "おはようございます");
  log("  再送: status=" + a2.status + " duplicate=" + a2.json.duplicate + " draft=" + JSON.stringify(a2.json.draft));
  const cnt = (await db.query("SELECT count(*)::int n FROM attendance_drafts WHERE message_id=$1", [a.json.message.id])).rows[0].n;
  log("  この発言に紐づく下書きの件数: " + cnt);

  log("=== 3. 「遅れませんでした」で下書きが立たないか ===");
  const b = await post(uuid(102), "遅れませんでした");
  const cntB = (await db.query("SELECT count(*)::int n FROM attendance_drafts WHERE message_id=$1", [b.json.message.id])).rows[0].n;
  log("  draft=" + JSON.stringify(b.json.draft) + " / DBの件数=" + cntB);

  log("=== 4. 確定を押すと状態が変わるか / 時間が経っても自動確定しないか ===");
  const target = rows1[0];
  const before = (await db.query("SELECT status FROM attendance_drafts WHERE id=$1", [target.id])).rows[0].status;
  await new Promise((r) => setTimeout(r, 3000));
  const after3s = (await db.query("SELECT status FROM attendance_drafts WHERE id=$1", [target.id])).rows[0].status;
  log("  押す前=" + before + " / 3秒後=" + after3s + "（変わっていなければ自動確定しない）");
  const conf = await fetch(API + "/api/attendance/drafts/" + target.id, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "confirm" }) });
  log("  確定API: status=" + conf.status + " " + JSON.stringify(await conf.json()));
  log("  DB: " + JSON.stringify((await db.query("SELECT id,status,decided_at,decided_by FROM attendance_drafts WHERE id=$1", [target.id])).rows));

  log("=== 5. 却下した下書きが残るか ===");
  const c = await post(uuid(103), "昼休憩入ります");
  const cid3 = (await db.query("SELECT id FROM attendance_drafts WHERE message_id=$1", [c.json.message.id])).rows[0].id;
  const rej = await fetch(API + "/api/attendance/drafts/" + cid3, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reject" }) });
  log("  却下API: status=" + rej.status);
  log("  DB: " + JSON.stringify((await db.query("SELECT id,kind,status FROM attendance_drafts WHERE id=$1", [cid3])).rows));
  const again = await post(uuid(104), "昼休憩入ります");
  log("  同じ本文を別IDで再投稿したときの draft: " + JSON.stringify(again.json.draft) + "（別の発言なので新しく立つのが正しい）");
  const reproc = (await db.query("SELECT count(*)::int n FROM attendance_drafts WHERE message_id=$1", [c.json.message.id])).rows[0].n;
  log("  却下済みの発言に紐づく下書きの件数: " + reproc + "（1件のまま＝再び立っていない）");

  log("=== 6. 根拠の発言を論理削除しても下書きが残るか ===");
  await db.query("UPDATE messages SET deleted_at = now() WHERE id = $1", [c.json.message.id]);
  const kept = (await db.query("SELECT id,kind,status,source_body FROM attendance_drafts WHERE message_id=$1", [c.json.message.id])).rows;
  log("  削除後の下書き: " + JSON.stringify(kept));
  const listed = (await drafts()).filter((d) => Number(d.message_id) === Number(c.json.message.id));
  log("  API から見た該当下書き: " + JSON.stringify(listed.map((d) => ({ id: d.id, status: d.status, source_deleted: d.source_deleted, source_body: d.source_body }))));
  await db.query("UPDATE messages SET deleted_at = NULL WHERE id = $1", [c.json.message.id]);

  log("=== 補足: 確定済みの下書きを機械が書き換えられないか ===");
  try {
    await db.query("UPDATE attendance_drafts SET status='pending' WHERE id=$1", [target.id]);
    log("  書き換えできてしまった（トリガーが効いていない）");
  } catch (e) {
    log("  DBが拒否した: " + e.message);
  }
  const reconf = await fetch(API + "/api/attendance/drafts/" + target.id, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reject" }) });
  log("  確定済みに却下APIを叩く: status=" + reconf.status + "（409 が正しい）");

  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });