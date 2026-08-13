/* 承認の権限を、役割と関係の組み合わせで網羅して確かめる。
   特に「役割は manager だが、その人の上長ではない」経路を確認する。
   実行: node scripts\verify-phase4-permissions.js （next dev の起動が必要）

   Phase 5 段階3 で2点を直した:
     1. 誰として叩くかを **セッション** で渡す（?user= / body.user は読まれなくなったため）
     2. **何度実行しても同じ結果になる**ようにした。
        以前は固定のUUIDで投稿を作ってから messages.user_id を書き換えており、
        2回目の実行で (user_id, client_msg_id) の一意制約に当たって途中で止まっていた。
        UUID を毎回生成し、作った行は最後に片付ける。 */
const fs = require("fs");
const crypto = require("crypto");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const API = process.env.TENKO_API || "http://localhost:3000";
// セッションのCookieの名前は、本番（https）では __Secure- が付く（Auth.js の既定）。
// **手元の名前のまま本番に送ると、認証されずに 401 が返る。**
// それを「拒否された＝守られている」と読むと、試験が壊れたことに気づけない（段階7-B で実際に起きた）
const COOKIE_NAME = API.startsWith("https") ? "__Secure-authjs.session-token" : "authjs.session-token";
const log = (s) => console.log(s);

const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const madeTokens = [];    // 作ったセッション
const madeMsgIds = [];    // 作った投稿（後片付けのため）

// 確認用のセッションを作る。Auth.js のアダプタが作るのと同じ形。値は表示しない
async function session(userId) {
  const token = crypto.randomUUID();
  await db.query(
    `INSERT INTO sessions ("userId", expires, "sessionToken") VALUES ($1, now() + interval '1 hour', $2)`,
    [userId, token],
  );
  madeTokens.push(token);
  return COOKIE_NAME + "=" + token;
}

async function post(path, cookie, body) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

(async () => {
  await db.connect();

  const ensure = async (name, role) => {
    const r = await db.query("SELECT id FROM users WHERE display_name=$1 AND deleted_at IS NULL", [name]);
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

  const cookie = {
    member: await session(member), manager: await session(manager),
    other: await session(other), otherMgr: await session(otherMgr), admin: await session(admin),
  };

  log(`部下=${member} 上長=${manager} 無関係member=${other} 別上長=${otherMgr} 管理者=${admin}`);
  log("（確認用のセッションを5件作った。終わったら消す）");
  log("");

  /* 承認待ちの記録を1件作る。
     部下として発言し、部下として確定する。user_id を後から書き換えない */
  const mk = async (body) => {
    const clientMsgId = crypto.randomUUID();
    const r = await post("/api/rooms/1/messages", cookie.member, { clientMsgId, body });
    const msgId = Number(r.json.message.id);
    madeMsgIds.push(msgId);
    const d = (await db.query("SELECT id FROM attendance_drafts WHERE message_id=$1", [msgId])).rows[0];
    if (!d) throw new Error("下書きが立たなかった（本文: " + body + "）");
    const c = await post("/api/attendance/drafts/" + d.id, cookie.member, { action: "confirm" });
    if (!c.json.record) throw new Error("承認待ちの記録ができなかった: " + JSON.stringify(c.json));
    return Number(c.json.record.id);
  };

  const recId = await mk("出社しました");
  log("承認待ちの記録 id=" + recId + " (対象は部下 id=" + member + ")");
  log("");

  const tryApprove = async (label, as) => {
    const r = await post("/api/attendance/approvals/" + recId, cookie[as], { action: "approve" });
    const st = (await db.query("SELECT status FROM attendance_records WHERE id=$1", [recId])).rows[0].status;
    log("  " + label.padEnd(28) + " -> status=" + r.status + " 記録=" + st + " " + (r.json.error ? "「" + r.json.error + "」" : ""));
  };

  log("=== 承認を試みる（記録は部下のもの）===");
  await tryApprove("本人(member)", "member");
  await tryApprove("無関係な member", "other");
  await tryApprove("別の上長(manager・担当外)", "otherMgr");
  await tryApprove("担当の上長(manager)", "manager");
  log("");

  log("=== 一覧の見え方 ===");
  for (const [label, as] of [["無関係な member", "other"], ["別の上長", "otherMgr"], ["担当の上長", "manager"], ["管理者(admin)", "admin"]]) {
    const r = await fetch(API + "/api/attendance/approvals", { headers: { Cookie: cookie[as] } });
    const j = await r.json().catch(() => ({}));
    const n = Array.isArray(j.items) ? j.items.length : "-";
    log("  " + label.padEnd(20) + " -> status=" + r.status + " 件数=" + n);
  }
  log("");

  log("=== 未認証で一覧を取れるか ===");
  const anon = await fetch(API + "/api/attendance/approvals");
  log("  Cookie なし -> status=" + anon.status + " " + (await anon.text()).slice(0, 40));
  log("");

  log("=== admin は担当外でも承認できるか（別の記録で確認）===");
  const recId2 = await mk("お疲れ様でした");
  const r2 = await post("/api/attendance/approvals/" + recId2, cookie.admin, { action: "approve" });
  const st2 = (await db.query("SELECT status, approved_by FROM attendance_records WHERE id=$1", [recId2])).rows[0];
  log("  管理者が承認 -> status=" + r2.status + " 記録=" + JSON.stringify(st2));
  log("");

  log("=== 差し戻しも同じ権限で守られているか（記録3で確認）===");
  const recId3 = await mk("昼休憩入ります");
  for (const [label, as] of [["無関係な member", "other"], ["別の上長", "otherMgr"]]) {
    const r = await post("/api/attendance/approvals/" + recId3, cookie[as], { action: "return", reason: "確認" });
    const st = (await db.query("SELECT status FROM attendance_records WHERE id=$1", [recId3])).rows[0].status;
    log("  " + label.padEnd(20) + " が差し戻し -> status=" + r.status + " 記録=" + st + " " + (r.json.error ? "「" + r.json.error + "」" : ""));
  }
  log("");

  log("=== 他人の記録を本人として再提出できるか（なりすまし）===");
  const r4 = await post("/api/attendance/approvals/" + recId3, cookie.other, { action: "resubmit" });
  log("  無関係な member が再提出 -> status=" + r4.status + " " + JSON.stringify(r4.json));
  log("");

  /* 後片付け。何度実行しても同じ結果になるように、作ったものを消す。
     承認済みの記録はトリガーで消せないため、先に status を戻してから消す。
     …ではなく、トリガーを迂回しないために「消せないものは残す」方針にする。
     残るのは確認用の勤怠記録で、実害はない（対象は「検証 部下」）*/
  for (const id of madeMsgIds) {
    await db.query("DELETE FROM attendance_records WHERE draft_id IN (SELECT id FROM attendance_drafts WHERE message_id=$1) AND status <> 'approved'", [id]);
  }
  for (const t of madeTokens) await db.query(`DELETE FROM sessions WHERE "sessionToken"=$1`, [t]);
  log("確認用のセッションを削除した（作った投稿と記録は履歴として残す）");

  await db.end();
})().catch(async (e) => {
  console.error("ERR: " + e.message);
  try { for (const t of madeTokens) await db.query(`DELETE FROM sessions WHERE "sessionToken"=$1`, [t]); await db.end(); } catch { }
  process.exit(1);
});
