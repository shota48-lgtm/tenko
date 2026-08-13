/* 審査役A（Phase 5 段階3）: 認証を入れた各経路に、実際に攻撃を送る。
   コードを読んで安全と判断するのではなく、送って確かめる。
   実行: node scripts/attack-phase5-auth.js [経路名の一部]
     例: node scripts/attack-phase5-auth.js me      → /api/me だけ試す
         node scripts/attack-phase5-auth.js         → 全部試す

   3つの観点で送る:
     未認証     : Cookie なしで叩く
     なりすまし : 他人のIDを ?user= や body に添えて叩く（無視されるべき）
     権限       : 権限のない役割のセッションで叩く

   セッションは DB に直接作る（Auth.js のアダプタが作るのと同じ形）。
   トークンの値は表示しない。終わったら作った分だけ消す。 */
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
const only = process.argv[2] || "";

const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const made = [];   // 後片付けのため、作ったトークンを覚えておく
const who = {};    // 役割 -> { id, cookie }

let ok = 0, ng = 0;

async function ensureUser(name, role) {
  const r = await db.query("SELECT id FROM users WHERE display_name=$1 AND deleted_at IS NULL", [name]);
  if (r.rows.length) {
    await db.query("UPDATE users SET role=$2 WHERE id=$1", [r.rows[0].id, role]);
    return Number(r.rows[0].id);
  }
  const i = await db.query("INSERT INTO users (display_name, role) VALUES ($1,$2) RETURNING id", [name, role]);
  return Number(i.rows[0].id);
}

async function session(userId) {
  const token = crypto.randomUUID();
  await db.query(
    `INSERT INTO sessions ("userId", expires, "sessionToken") VALUES ($1, now() + interval '1 hour', $2)`,
    [userId, token],
  );
  made.push(token);
  return COOKIE_NAME + "=" + token;
}

async function req(path, opts = {}) {
  const { method = "GET", body, as = null } = opts;
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (as) headers["Cookie"] = who[as].cookie;
  const res = await fetch(API + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* CSV など */ }
  return { status: res.status, text, json };
}

// 期待どおりかを判定して1行出す
function check(label, cond, detail) {
  if (cond) { ok++; console.log("  OK   " + label + (detail ? " : " + detail : "")); }
  else { ng++; console.log("  通った " + label + (detail ? " : " + detail : "")); }
}

const CASES = [];
const test = (name, fn) => CASES.push({ name, fn });

/* ---------------- /api/me ---------------- */
test("/api/me", async () => {
  const a = await req("/api/me");
  check("未認証で 401", a.status === 401, a.status + " " + a.text.slice(0, 60));

  const b = await req("/api/me?user=2", { as: "admin" });
  check("なりすまし（?user=2）が無視される", b.json?.me?.id === who.admin.id,
        "返ってきた id=" + b.json?.me?.id + "（自分は " + who.admin.id + "）");

  const c = await req("/api/me", { as: "member" });
  check("member でも自分の情報は取れる", c.status === 200 && c.json?.me?.id === who.member.id,
        "id=" + c.json?.me?.id + " role=" + c.json?.me?.role);
});

/* ---------------- /api/village ---------------- */
test("/api/village", async () => {
  const a = await req("/api/village");
  check("未認証で 401", a.status === 401, a.status + " " + a.text.slice(0, 60));

  const b = await req("/api/village?user=" + who.member.id, { as: "admin" });
  const c = await req("/api/village", { as: "admin" });
  check("なりすまし（?user=他人）が無視される", b.text === c.text,
        "他人を指定した応答と、自分の応答が同一か: " + (b.text === c.text));
});

/* ---------------- /api/notes ---------------- */
test("/api/notes", async () => {
  const a = await req("/api/notes?mine=1");
  check("未認証で自分の note を読めない（401）", a.status === 401, a.status + " " + a.text.slice(0, 60));

  // 旧来の ?user= は読まれない。指定しても他人の分は返らない
  const o = await req("/api/notes?user=" + who.admin.id + "&mine=1", { as: "member" });
  check("なりすまし（?user=admin&mine=1）で他人の note が返らない",
        o.status === 200 && (o.json?.note == null || Number(o.json.note.user_id) === who.member.id),
        "返ってきた user_id=" + (o.json?.note?.user_id ?? "なし"));

  const p = await req("/api/notes", { method: "PUT", body: { body: "攻撃で書いた" } });
  check("未認証で PUT できない（401）", p.status === 401, p.status + " " + p.text.slice(0, 60));

  const d = await req("/api/notes", { method: "DELETE" });
  check("未認証で DELETE できない（401）", d.status === 401, d.status + " " + d.text.slice(0, 60));

  // なりすまし: member のセッションで、他人（admin）の note を書き換えようとする
  const before = await db.query("SELECT body FROM daily_notes WHERE user_id=$1", [who.admin.id]);
  await req("/api/notes", { method: "PUT", as: "member", body: { body: "他人のふりで書いた", user: who.admin.id } });
  const after = await db.query("SELECT body FROM daily_notes WHERE user_id=$1", [who.admin.id]);
  check("なりすましで他人の note を書き換えられない",
        JSON.stringify(before.rows) === JSON.stringify(after.rows),
        "admin の note は変わっていないか: " + (JSON.stringify(before.rows) === JSON.stringify(after.rows)));

  const g = await req("/api/notes");
  check("全員分の一覧は未認証でも読める（段階4で絞る）", g.status === 200, g.status + " len=" + g.text.length);
});

/* ---------------- /api/announcements ---------------- */
test("/api/announcements", async () => {
  const a = await req("/api/announcements");
  check("未認証で 401", a.status === 401, a.status + " " + a.text.slice(0, 60));

  const p = await req("/api/announcements", { method: "POST", body: { body: "未認証で書いた" } });
  check("未認証で POST できない（401）", p.status === 401, p.status + " " + p.text.slice(0, 60));

  const m = await req("/api/announcements", { method: "POST", as: "member", body: { body: "member が書いた" } });
  check("member が書けない（403）", m.status === 403, m.status + " " + m.text.slice(0, 60));

  const g = await req("/api/announcements", { method: "POST", as: "manager", body: { body: "manager が書いた" } });
  check("manager が書けない（403）", g.status === 403, g.status + " " + g.text.slice(0, 60));

  // なりすまし: member のセッションで admin の id を添える
  const s = await req("/api/announcements", { method: "POST", as: "member",
                                              body: { body: "admin のふりで書いた", user: who.admin.id } });
  check("なりすまし（body.user=admin）でも書けない（403）", s.status === 403, s.status + " " + s.text.slice(0, 60));

  const bad = await req("/api/announcements", { method: "POST", as: "admin",
                                                body: { body: "別サイトから" }, });
  check("admin なら書ける（対照）", bad.status === 201, bad.status);
  if (bad.json?.announcement?.id) {
    await db.query("DELETE FROM announcements WHERE id=$1", [bad.json.announcement.id]);
  }
});

/* ---------------- /api/rooms/[roomId]/messages ---------------- */
test("/api/rooms/1/messages", async () => {
  const uuid = () => crypto.randomUUID();

  const a = await req("/api/rooms/1/messages?after=0&limit=3");
  check("未認証で読めない（401）", a.status === 401, a.status + " " + a.text.slice(0, 60));

  const before = (await db.query("SELECT count(*)::int n FROM messages")).rows[0].n;
  const p = await req("/api/rooms/1/messages", { method: "POST", body: { clientMsgId: uuid(), body: "未認証の投稿" } });
  const mid = (await db.query("SELECT count(*)::int n FROM messages")).rows[0].n;
  check("未認証で投稿できない（401 かつ保存されない）", p.status === 401 && mid === before,
        p.status + " / messages " + before + " -> " + mid);

  // なりすまし: member のセッションで、admin の id を添えて投稿する
  const cid = uuid();
  const s = await req("/api/rooms/1/messages", { method: "POST", as: "member",
                                                 body: { clientMsgId: cid, body: "他人のふりで投稿", user: who.admin.id, userId: who.admin.id } });
  const row = (await db.query("SELECT user_id FROM messages WHERE client_msg_id=$1", [cid])).rows[0];
  check("なりすましても、発言の持ち主はセッションの人になる",
        row != null && Number(row.user_id) === who.member.id,
        "保存された user_id=" + (row ? row.user_id : "なし") + "（セッションは " + who.member.id + "）");
  if (row) {
    await db.query("DELETE FROM attendance_drafts WHERE message_id IN (SELECT id FROM messages WHERE client_msg_id=$1)", [cid]);
    await db.query("DELETE FROM messages WHERE client_msg_id=$1", [cid]);
  }
});

/* ---------------- /api/attendance/drafts ---------------- */
test("/api/attendance/drafts", async () => {
  const a = await req("/api/attendance/drafts");
  check("未認証で 401", a.status === 401, a.status + " " + a.text.slice(0, 60));

  const b = await req("/api/attendance/drafts?user=" + who.admin.id, { as: "member" });
  const c = await req("/api/attendance/drafts", { as: "member" });
  check("なりすまし（?user=他人）が無視される", b.text === c.text, "同一か: " + (b.text === c.text));

  const own = b.json?.drafts ?? [];
  const foreign = own.filter((d) => Number(d.user_id) !== who.member.id);
  check("他人の下書きが混ざらない", foreign.length === 0, "混ざった件数=" + foreign.length);
});

/* ---------------- /api/attendance/drafts/[id] ---------------- */
test("/api/attendance/drafts/[id]", async () => {
  // 他人（admin）の未確定の下書きを1件用意して、member が触れるかを見る
  const d = (await db.query(
    `SELECT id FROM attendance_drafts WHERE user_id=$1 AND status='pending' ORDER BY id DESC LIMIT 1`,
    [who.admin.id])).rows[0];
  if (!d) { console.log("  (skip) admin の未確定の下書きが無いため、なりすましの確認は省略"); }

  const a = await req("/api/attendance/drafts/1", { method: "POST", body: { action: "confirm" } });
  check("未認証で確定できない（401）", a.status === 401, a.status + " " + a.text.slice(0, 60));

  if (d) {
    const s = await req("/api/attendance/drafts/" + d.id, { method: "POST", as: "member",
                                                            body: { action: "confirm", user: who.admin.id } });
    const still = (await db.query("SELECT status FROM attendance_drafts WHERE id=$1", [d.id])).rows[0];
    check("他人の下書きを確定できない", still.status === "pending",
          "status=" + still.status + " / 応答 " + s.status + " " + s.text.slice(0, 50));
  }
});

/* ---------------- /api/attendance/approvals ---------------- */
test("/api/attendance/approvals", async () => {
  const a = await req("/api/attendance/approvals");
  check("未認証で 401", a.status === 401, a.status + " " + a.text.slice(0, 60));

  const m = await req("/api/attendance/approvals", { as: "member" });
  check("member は一覧を見られない（403）", m.status === 403, m.status + " " + m.text.slice(0, 60));

  const s = await req("/api/attendance/approvals?user=" + who.admin.id, { as: "member" });
  check("なりすまし（?user=admin）でも見られない（403）", s.status === 403, s.status + " " + s.text.slice(0, 60));
});

/* ---------------- /api/attendance/approvals/[id] ---------------- */
test("/api/attendance/approvals/[id]", async () => {
  // 部下（member）の承認待ちの記録を1件用意する
  let rec = (await db.query(
    `SELECT id, user_id, status FROM attendance_records WHERE user_id=$1 AND status='submitted' ORDER BY id DESC LIMIT 1`,
    [who.member.id])).rows[0];
  if (!rec) {
    const ins = await db.query(
      `INSERT INTO attendance_records (user_id, kind, event_at, work_date, status, confirmed_at)
       VALUES ($1,'arrive', now(), (now() AT TIME ZONE 'Asia/Tokyo')::date, 'submitted', now())
       RETURNING id, user_id, status`, [who.member.id]);
    rec = ins.rows[0];
  }
  const statusOf = async () =>
    (await db.query("SELECT status FROM attendance_records WHERE id=$1", [rec.id])).rows[0].status;

  const a = await req("/api/attendance/approvals/" + rec.id, { method: "POST", body: { action: "approve" } });
  check("未認証で承認できない（401）", a.status === 401 && (await statusOf()) === "submitted", a.status);

  const b = await req("/api/attendance/approvals/" + rec.id, { method: "POST", as: "member", body: { action: "approve" } });
  check("本人（member）が自分の記録を承認できない", b.status === 403 && (await statusOf()) === "submitted",
        b.status + " " + b.text.slice(0, 50));

  const c = await req("/api/attendance/approvals/" + rec.id, { method: "POST", as: "other", body: { action: "approve" } });
  check("無関係な member が承認できない", c.status === 403 && (await statusOf()) === "submitted",
        c.status + " " + c.text.slice(0, 50));

  const d = await req("/api/attendance/approvals/" + rec.id, { method: "POST", as: "otherManager", body: { action: "approve" } });
  check("別の上長が承認できない", d.status === 403 && (await statusOf()) === "submitted",
        d.status + " " + d.text.slice(0, 50));

  const e = await req("/api/attendance/approvals/" + rec.id, { method: "POST", as: "manager", body: { action: "approve" } });
  check("担当の上長だけが承認できる（対照）", e.status === 200 && (await statusOf()) === "approved",
        e.status + " status=" + (await statusOf()));
});

/* ---------------- /api/attendance/corrections ---------------- */
test("/api/attendance/corrections", async () => {
  const a = await req("/api/attendance/corrections");
  check("未認証で 401", a.status === 401, a.status + " " + a.text.slice(0, 60));

  const p = await req("/api/attendance/corrections", { method: "POST", body: { recordId: 1, reason: "未認証", eventAt: new Date().toISOString() } });
  check("未認証で申請できない（401）", p.status === 401, p.status + " " + p.text.slice(0, 60));

  const b = await req("/api/attendance/corrections?user=" + who.admin.id, { as: "member" });
  const c = await req("/api/attendance/corrections", { as: "member" });
  check("なりすまし（?user=admin）が無視される", b.text === c.text, "同一か: " + (b.text === c.text));
});

/* ---------------- /api/attendance/anomalies ---------------- */
test("/api/attendance/anomalies", async () => {
  const a = await req("/api/attendance/anomalies");
  check("未認証で 401", a.status === 401, a.status + " " + a.text.slice(0, 60));

  const b = await req("/api/attendance/anomalies?user=" + who.admin.id, { as: "other" });
  check("なりすまし（?user=admin）が無視される", (b.json?.actor?.id ?? null) === who.other.id,
        "actor.id=" + b.json?.actor?.id + "（自分は " + who.other.id + "）");

  const c = await req("/api/attendance/anomalies?target=" + who.member.id, { as: "other" });
  check("無関係な member が他人を指定して取れない（403）", c.status === 403, c.status + " " + c.text.slice(0, 60));
});

/* ---------------- /api/attendance/monthly ---------------- */
test("/api/attendance/monthly", async () => {
  const a = await req("/api/attendance/monthly?year=2026&month=8");
  check("未認証で 401", a.status === 401, a.status + " " + a.text.slice(0, 60));

  const b = await req("/api/attendance/monthly?year=2026&month=8&actor=" + who.admin.id + "&user=" + who.member.id, { as: "other" });
  check("無関係な member が他人の月次を取れない（403）", b.status === 403, b.status + " " + b.text.slice(0, 60));

  const c = await req("/api/attendance/monthly?year=2026&month=8", { as: "member" });
  check("自分の月次は取れる（対照）", c.status === 200, c.status + " len=" + c.text.length);
});

/* ---------------- 読み取り専用（段階4まで開放） ---------------- */
test("読み取り専用の経路", async () => {
  const r = await req("/api/rooms");
  check("/api/rooms は未認証でも読める（村を描くため）", r.status === 200, r.status);
  const u = await req("/api/users");
  check("/api/users は未認証でも読める（名前だけ）", u.status === 200, u.status);
  check("/api/users に email が含まれない", !u.text.includes("email") && !u.text.includes("@"), "len=" + u.text.length);
});

(async () => {
  await db.connect();
  const memberId = await ensureUser("検証 部下", "member");
  const managerId = await ensureUser("検証 上長", "manager");
  const otherId = await ensureUser("検証 無関係", "member");
  const otherMgrId = await ensureUser("検証 別上長", "manager");
  await db.query("UPDATE users SET manager_id=$1 WHERE id=$2", [managerId, memberId]);

  const adminRow = (await db.query("SELECT id FROM users WHERE role='admin' AND email IS NOT NULL ORDER BY id LIMIT 1")).rows[0]
                ?? (await db.query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0];
  const adminId = Number(adminRow.id);

  who.admin = { id: adminId, cookie: await session(adminId) };
  who.member = { id: memberId, cookie: await session(memberId) };
  who.manager = { id: managerId, cookie: await session(managerId) };
  who.other = { id: otherId, cookie: await session(otherId) };
  who.otherManager = { id: otherMgrId, cookie: await session(otherMgrId) };

  console.log("admin=" + adminId + " member=" + memberId + " manager=" + managerId +
              " 無関係=" + otherId + " 別上長=" + otherMgrId);
  console.log("（確認用のセッションを5件作った。終わったら消す）\n");

  for (const c of CASES) {
    if (only && !c.name.includes(only)) continue;
    console.log("=== " + c.name);
    try { await c.fn(); } catch (e) { ng++; console.log("  ERR  " + e.message); }
  }

  // 後片付け。作った分だけ消す
  for (const t of made) await db.query(`DELETE FROM sessions WHERE "sessionToken"=$1`, [t]);
  const left = (await db.query("SELECT count(*)::int n FROM sessions")).rows[0].n;
  console.log("\n作った確認用のセッションを削除した。残っているセッション: " + left + " 件");
  console.log("結果: OK " + ok + " 件 / 通ってしまった " + ng + " 件");
  await db.end();
  process.exit(ng === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error("ERR: " + e.message);
  try { for (const t of made) await db.query(`DELETE FROM sessions WHERE "sessionToken"=$1`, [t]); await db.end(); } catch { }
  process.exit(1);
});
