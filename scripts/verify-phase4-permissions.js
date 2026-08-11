/* 承認の権限を、役割と関係の組み合わせで網羅して確かめる。
   特に「役割は manager だが、その人の上長ではない」経路を確認する。
   実行: node scripts\verify-phase4-permissions.js （next dev の起動が必要） */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const API = "http://localhost:3000";
const log = (s) => console.log(s);
const uuid = (n) => "dddddddd-0000-4000-8000-" + String(n).padStart(12, "0");

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const ensure = async (name, role) => {
    const r = await db.query("SELECT id FROM users WHERE display_name=$1", [name]);
    if (r.rows.length) {
      await db.query("UPDATE users SET role=$2 WHERE id=$1", [r.rows[0].id, role]);
      return Number(r.rows[0].id);
    }
    const i = await db.query("INSERT INTO users (display_name, role) VALUES ($1,$2) RETURNING id", [name, role]);
    return Number(i.rows[0].id);
  };

  const member = await ensure("検証 部下", "member");
  const manager = await ensure("検証 上長", "manager");
  const other = await ensure("検証 無関係", "member");
  const otherMgr = await ensure("検証 別上長", "manager");
  const admin = await ensure("検証 管理者", "admin");
  await db.query("UPDATE users SET manager_id=$1 WHERE id=$2", [manager, member]);
  log(`部下=${member} 上長=${manager} 無関係member=${other} 別上長=${otherMgr} 管理者=${admin}`);
  log("");

  /* 承認待ちの記録を1件作る */
  const mk = async (n, body) => {
    const r = await fetch(API + "/api/rooms/1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientMsgId: uuid(n), body }),
    });
    const j = await r.json();
    const msgId = Number(j.message.id);
    await db.query("UPDATE messages SET user_id=$1 WHERE id=$2", [member, msgId]);
    await db.query("UPDATE attendance_drafts SET user_id=$1 WHERE message_id=$2", [member, msgId]);
    const d = (await db.query("SELECT id FROM attendance_drafts WHERE message_id=$1", [msgId])).rows[0];
    const c = await fetch(API + "/api/attendance/drafts/" + d.id, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "confirm", user: member }),
    });
    const cj = await c.json();
    return Number(cj.record.id);
  };

  const recId = await mk(1, "出社しました");
  log("承認待ちの記録 id=" + recId + " (対象は部下 id=" + member + ")");
  log("");

  const tryApprove = async (label, actorId) => {
    const r = await fetch(API + "/api/attendance/approvals/" + recId, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve", user: actorId }),
    });
    const j = await r.json().catch(() => ({}));
    const st = (await db.query("SELECT status FROM attendance_records WHERE id=$1", [recId])).rows[0].status;
    log("  " + label.padEnd(28) + " -> status=" + r.status + " 記録=" + st + " " + (j.error ? "「" + j.error + "」" : ""));
    return r.status;
  };

  log("=== 承認を試みる（記録は部下のもの）===");
  await tryApprove("本人(member)", member);
  await tryApprove("無関係な member", other);
  await tryApprove("別の上長(manager・担当外)", otherMgr);
  await tryApprove("担当の上長(manager)", manager);
  log("");

  log("=== 一覧の見え方 ===");
  for (const [label, id] of [["無関係な member", other], ["別の上長", otherMgr], ["担当の上長", manager], ["管理者(admin)", admin]]) {
    const r = await fetch(API + "/api/attendance/approvals?user=" + id);
    const j = await r.json().catch(() => ({}));
    const n = Array.isArray(j.items) ? j.items.length : "-";
    log("  " + label.padEnd(20) + " -> status=" + r.status + " 件数=" + n);
  }
  log("");

  log("=== admin は担当外でも承認できるか（別の記録で確認）===");
  const recId2 = await mk(2, "お疲れ様でした");
  const r2 = await fetch(API + "/api/attendance/approvals/" + recId2, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve", user: admin }),
  });
  const st2 = (await db.query("SELECT status, approved_by FROM attendance_records WHERE id=$1", [recId2])).rows[0];
  log("  管理者が承認 -> status=" + r2.status + " 記録=" + JSON.stringify(st2));
  log("");

  log("=== 差し戻しも同じ権限で守られているか（記録3で確認）===");
  const recId3 = await mk(3, "昼休憩入ります");
  for (const [label, id] of [["無関係な member", other], ["別の上長", otherMgr]]) {
    const r = await fetch(API + "/api/attendance/approvals/" + recId3, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "return", reason: "テスト", user: id }),
    });
    const j = await r.json().catch(() => ({}));
    const st = (await db.query("SELECT status FROM attendance_records WHERE id=$1", [recId3])).rows[0].status;
    log("  " + label.padEnd(20) + " が差し戻し -> status=" + r.status + " 記録=" + st + " " + (j.error ? "「" + j.error + "」" : ""));
  }

  log("");
  log("=== 他人の記録を本人として再提出できるか（なりすまし）===");
  const r4 = await fetch(API + "/api/attendance/approvals/" + recId3, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "resubmit", user: other }),
  });
  log("  無関係な member が再提出 -> status=" + r4.status + " " + JSON.stringify(await r4.json()));

  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
