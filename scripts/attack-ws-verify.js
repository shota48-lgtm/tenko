/* 審査役A（Phase 5 段階6）: 無効化の定期確認と、券まわりの残りを実測する。
   実行: node scripts\attack-ws-verify.js （next dev の起動が必要。ws-server はこの中で起動する）

   見る点:
     1. 期限切れの券で繋げないこと（close 4003）
     2. セッションを無効にすると、接続中でも切られること（close 4001）
     3. **確認が10回続けて失敗すると、認証済みの接続が切られること**（close 4001）
     4. /api/ws-verify が共有秘密なしでは答えないこと
     5. TENKO_PUBLIC_VIEW=0 のとき、券の無い接続が拒まれること（close 4004）

   3 と 5 は、確認用に別のポートで ws-server を起動して試す
   （既定の60秒間隔では10回の失敗に10分かかるため、間隔を短くして起動する）。 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { Client } = require("pg");
const WebSocket = require("ws");

const env = fs.readFileSync(".env.local", "utf8").split(/\r?\n/);
const pick = (k) => {
  const l = env.find((x) => x.startsWith(k + "="));
  return l ? l.slice(k.length + 1).trim().replace(/^["']|["']$/g, "") : "";
};
const url = pick("DATABASE_URL");
const SECRET = pick("TENKO_WS_TICKET_SECRET");
const INTERNAL = pick("TENKO_WS_INTERNAL_TOKEN");
const API = process.env.TENKO_API || "http://localhost:3000";
const WS = process.env.TENKO_WS || "ws://localhost:8080";
// 本番に向けるときは 1 にする。
// **公開中のサーバーに対して「10回失敗させて全員を切る」試験を行わないため。**
// 確認用の ws-server を手元で起こす節（2・3・5・6）を飛ばし、
// 外から見える範囲（期限切れの券・共有秘密なしの ws-verify）だけを試す
const SKIP_LOCAL = process.env.TENKO_SKIP_LOCAL === "1";
// セッションのCookieの名前は、本番（https）では __Secure- が付く（Auth.js の既定）。
// **手元の名前のまま本番に送ると、認証されずに 401 が返る。**
// それを「拒否された＝守られている」と読むと、試験が壊れたことに気づけない（段階7-B で実際に起きた）
const COOKIE_NAME = API.startsWith("https") ? "__Secure-authjs.session-token" : "authjs.session-token";
const log = (s) => console.log(s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let ok = 0, ng = 0;
const check = (label, cond, detail) => {
  if (cond) { ok++; log("  OK   " + label + (detail ? " : " + detail : "")); }
  else { ng++; log("  通った " + label + (detail ? " : " + detail : "")); }
};

const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const madeTokens = [];
const children = [];

async function session(userId) {
  const t = crypto.randomUUID();
  await db.query(
    `INSERT INTO sessions ("userId", expires, "sessionToken") VALUES ($1, now() + interval '1 hour', $2)`,
    [userId, t]);
  madeTokens.push(t);
  return { cookie: COOKIE_NAME + "=" + t, token: t };
}

async function ticketFor(cookie) {
  const r = await fetch(API + "/api/ws-ticket", { method: "POST", headers: { Cookie: cookie } });
  if (!r.ok) return null;
  return (await r.json()).ticket;
}

// 期限切れの券を、発行側と同じ形で自分で作る（本番の発行口は期限切れを出さないため）
function expiredTicket(userId, sessionId) {
  const exp = Math.floor(Date.now() / 1000) - 10;
  const payload = [userId, sessionId, exp, crypto.randomUUID()].join(".");
  const body = Buffer.from(payload, "utf8").toString("base64url");
  const mac = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return body + "." + mac;
}

// 本番（遠いサーバー）では往復に時間がかかるため長めに待つ（段階7-B）
const SETTLE_MS = Number(process.env.TENKO_SETTLE_MS) || (WS.startsWith("wss") ? 3000 : 600);
function connect(wsUrl, protocols) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, protocols);
    const state = { ws, list: [], opened: false, code: null, reason: "", closed: false, msgs: [] };
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(state); } };
    ws.on("open", () => { state.opened = true; setTimeout(done, SETTLE_MS); });
    ws.on("message", (d) => {
      try {
        const m = JSON.parse(d.toString());
        state.msgs.push(m.type);
        if (m.type === "presence.list") state.list = m.users;
      } catch { /* 無視 */ }
    });
    ws.on("close", (c, r) => { state.code = c; state.reason = r.toString(); state.closed = true; done(); });
    ws.on("error", () => { });
  });
}
// 接続が閉じるのを待つ（既に閉じていれば即座に返る）
function waitClose(state, ms) {
  return new Promise((resolve) => {
    if (state.closed) return resolve(state);
    const t = setTimeout(() => resolve(state), ms);
    state.ws.on("close", (c, r) => {
      state.code = c; state.reason = r.toString(); state.closed = true;
      clearTimeout(t); resolve(state);
    });
  });
}

// 確認用の ws-server を別ポートで起動する
function startWs(port, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["index.js"], {
      cwd: path.join(process.cwd(), "ws-server"),
      env: { ...process.env, PORT: String(port), TENKO_API: API, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const lines = [];
    child.stdout.on("data", (d) => { for (const l of d.toString().split("\n")) if (l.trim()) lines.push(l.trim()); });
    child.stderr.on("data", (d) => { for (const l of d.toString().split("\n")) if (l.trim()) lines.push(l.trim()); });
    setTimeout(() => resolve({ child, lines }), 1500);
  });
}

(async () => {
  await db.connect();
  const userId = Number((await db.query("SELECT id FROM users WHERE display_name='検証 部下'")).rows[0].id);
  log("確認に使う利用者: " + userId + "（検証 部下）\n");

  log("=== 1. 期限切れの券で繋げるか ===");
  const s1 = await session(userId);
  const sid = (await db.query(`SELECT id FROM sessions WHERE "sessionToken"=$1`, [s1.token])).rows[0].id;
  const dead = expiredTicket(userId, String(sid));
  const c1 = await connect(WS, ["tenko.v1", "ticket." + dead]);
  // **close code だけを見てはいけない（段階7-B で実測）。**
  // 手元では close(4003) が届くが、本番（Render）では届かない。
  // 断りの知らせ（auth.rejected）は本番でも届くので、どちらかがあれば断られたとみなす
  check("期限切れの券で繋げない",
    (c1.msgs ?? []).includes("auth.rejected") || c1.code === 4003,
    "closed=" + c1.closed + " code=" + c1.code + " 受け取った知らせ=" + ((c1.msgs ?? []).join(",") || "なし"));

  log("");
  if (SKIP_LOCAL) log("（本番向けのため、節2・3・5・6は飛ばす。手元で ws-server を起こす試験のため）");
  if (!SKIP_LOCAL) {
  log("=== 2. 接続中にセッションを無効にすると切られるか ===");
  // 確認の間隔を短くした ws-server を、別のポートで起動する
  const a = await startWs(8091, { TENKO_WS_VERIFY_INTERVAL_MS: "800" });
  const s2 = await session(userId);
  const t2 = await ticketFor(s2.cookie);
  const c2 = await connect("ws://localhost:8091", ["tenko.v1", "ticket." + t2]);
  check("正しい券で繋がる（対照）", c2.opened && !c2.closed, "opened=" + c2.opened);
  await db.query(`DELETE FROM sessions WHERE "sessionToken"=$1`, [s2.token]);   // 無効化
  log("  セッションを消した。次の確認で切られるはず");
  await waitClose(c2, 4000);
  check("無効になったセッションの接続が切られる", c2.closed && c2.code === 4001,
    "code=" + c2.code + " reason=" + c2.reason);
  check("切る前に auth.expired を送っている", (c2.msgs ?? []).includes("auth.expired"),
    "受け取った種別: " + (c2.msgs ?? []).join(", "));
  a.child.kill();

  log("");
  log("=== 3. 確認が10回続けて失敗すると切られるか ===");
  // アプリが落ちている状態を作る（届かないポートを API に指定する）
  const b = await startWs(8092, { TENKO_WS_VERIFY_INTERVAL_MS: "300", TENKO_API: "http://127.0.0.1:59999" });
  const s3 = await session(userId);
  const t3 = await ticketFor(s3.cookie);
  const c3 = await connect("ws://localhost:8092", ["tenko.v1", "ticket." + t3]);
  check("確認が失敗していても、はじめは繋がったまま", c3.opened && !c3.closed, "opened=" + c3.opened);
  await waitClose(c3, 8000);
  check("連続10回の失敗で切られる", c3.closed && c3.code === 4001,
    "code=" + c3.code + " reason=" + c3.reason);
  const warn = b.lines.filter((l) => l.includes("連続5回以上")).length;
  const cut = b.lines.filter((l) => l.includes("連続10回")).length;
  log("  ws-server のログ（抜粋）:");
  for (const l of b.lines.filter((l) => l.includes("[verify]")).slice(-4)) log("    " + l);
  check("5回で警告、10回で切断のログが出ている", warn > 0 && cut > 0,
    "警告 " + warn + " 回 / 切断 " + cut + " 回");
  // 切られたあと、券が正しくても見るだけ扱いになること
  const s4 = await session(userId);
  const t4 = await ticketFor(s4.cookie);
  const c4 = await connect("ws://localhost:8092", ["tenko.v1", "ticket." + t4]);
  check("確認ができない間は、券が正しくても村に載らない",
    c4.opened && !c4.closed && !(c4.list ?? []).some((u) => Number(u.id) === userId && u.connections > 0),
    "村の人数=" + (c4.list ?? []).length);
  c4.ws.close();
  b.child.kill();

  log("");
  }
  log("=== 4. /api/ws-verify は共有秘密なしで答えるか ===");
  const r1 = await fetch(API + "/api/ws-verify", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionIds: [1] }) });
  check("共有秘密なしでは 401", r1.status === 401, "status=" + r1.status);
  const r2 = await fetch(API + "/api/ws-verify", {
    // ヘッダの値は ASCII でなければならない（日本語を入れると fetch が投げる。実測）
    method: "POST", headers: { "Content-Type": "application/json", "x-tenko-internal": "wrong-token-xxxx" },
    body: JSON.stringify({ sessionIds: [1] }) });
  check("違う共有秘密でも 401", r2.status === 401, "status=" + r2.status);
  const r3 = await fetch(API + "/api/ws-verify", {
    method: "POST", headers: { "Content-Type": "application/json", "x-tenko-internal": INTERNAL },
    body: JSON.stringify({ sessionIds: [999999] }) });
  const j3 = await r3.json();
  check("正しい共有秘密なら答える（対照）", r3.status === 200 && j3.invalid.includes(999999),
    "status=" + r3.status + " " + JSON.stringify(j3));

  log("");
  if (!SKIP_LOCAL) {
  log("=== 5. TENKO_PUBLIC_VIEW=0 のとき、券の無い接続は拒まれるか ===");
  const c = await startWs(8093, { TENKO_PUBLIC_VIEW: "0" });
  const c5 = await connect("ws://localhost:8093", ["tenko.v1"]);
  await waitClose(c5, 2000);
  check("券の無い接続が 4004 で拒まれる", c5.closed && c5.code === 4004,
    "code=" + c5.code + " reason=" + c5.reason);
  const s6 = await session(userId);
  const t6 = await ticketFor(s6.cookie);
  const c6 = await connect("ws://localhost:8093", ["tenko.v1", "ticket." + t6]);
  check("券があれば繋がる（対照）", c6.opened && !c6.closed, "opened=" + c6.opened);
  c6.ws.close();
  c.child.kill();

  log("");
  log("=== 6. 認証済みの接続が0本のとき、確認を投げないか（段階7）===");
  // 届かないポートを API に指定して起動する。**投げていれば必ず失敗のログが出る**。
  // 誰も繋いでいないので、1本も投げないはず
  const d = await startWs(8094, { TENKO_WS_VERIFY_INTERVAL_MS: "200", TENKO_API: "http://127.0.0.1:59999" });
  await wait(2500);   // 200ms 間隔なら10回以上まわる時間
  const tried = d.lines.filter((l) => l.includes("[verify]")).length;
  check("接続が0本の間は1回も投げない", tried === 0, "[verify] のログ " + tried + " 行");
  // 見るだけの接続だけ張っても投げないこと
  const lurk = await connect("ws://localhost:8094", ["tenko.v1"]);
  await wait(1500);
  const tried2 = d.lines.filter((l) => l.includes("[verify]")).length;
  check("見るだけの接続だけでも投げない", tried2 === 0, "[verify] のログ " + tried2 + " 行");
  lurk.ws.close();
  d.child.kill();
  }

  for (const t of madeTokens) await db.query(`DELETE FROM sessions WHERE "sessionToken"=$1`, [t]);
  log("\n確認用のセッションを削除した");
  log("結果: OK " + ok + " 件 / 通ってしまった " + ng + " 件");
  await db.end();
  for (const ch of children) { try { ch.kill(); } catch { } }
  process.exit(ng === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error("ERR: " + e.message);
  try { for (const t of madeTokens) await db.query(`DELETE FROM sessions WHERE "sessionToken"=$1`, [t]); await db.end(); } catch { }
  for (const ch of children) { try { ch.kill(); } catch { } }
  process.exit(1);
});
