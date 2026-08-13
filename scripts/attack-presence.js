/* 審査役A: 在席状態への攻撃を実際に送る。
   Phase 5 段階6 で、入場券が入った形に更新した。**S6（他人の在席の偽装）が塞がったことを確かめる。**
   実行: node scripts\attack-presence.js （next dev と ws-server の起動が必要）

   見る点:
     1. 他人になりすまして在席を変えられないこと（S6。段階6の完了条件）
     2. 券なしでは村に載れないこと
     3. 見るだけの接続を何本張っても村の人数が増えないこと
     4. 期限切れ・使い回し・署名を書き換えた券で繋げないこと
     5. 許可されていない種別が捨てられること
     6. HTTP 側に在席を変える口が無いこと
     7. 他人の「今日やること」を書き換えられないこと */
const fs = require("fs");
const crypto = require("crypto");
const { Client } = require("pg");
const WebSocket = require("ws");

const env = fs.readFileSync(".env.local", "utf8").split(/\r?\n/);
const pick = (k) => {
  const l = env.find((x) => x.startsWith(k + "="));
  return l ? l.slice(k.length + 1).trim().replace(/^["']|["']$/g, "") : "";
};
const url = pick("DATABASE_URL");
const API = process.env.TENKO_API || "http://localhost:3000";
const WS = process.env.TENKO_WS || "ws://localhost:8080";
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

// 確認用のセッションを作る（Auth.js のアダプタが作るのと同じ形）。値は表示しない
async function session(userId) {
  const t = crypto.randomUUID();
  await db.query(
    `INSERT INTO sessions ("userId", expires, "sessionToken") VALUES ($1, now() + interval '1 hour', $2)`,
    [userId, t]);
  madeTokens.push(t);
  return COOKIE_NAME + "=" + t;
}

// 本物の経路で券を取る
async function ticketFor(cookie) {
  const r = await fetch(API + "/api/ws-ticket", { method: "POST", headers: { Cookie: cookie } });
  if (!r.ok) return null;
  return (await r.json()).ticket;
}

// 繋ぐ。閉じられた場合は code を返す。
//
// **開いた直後に閉じられる場合がある。** 不正な券はハンドシェイクでは断らず、
// いったん受け入れてから close(4003) する形にしてあるため（設計書6節）。
// open だけを見て「繋がった」と判定すると、断られたことを見落とす。
// 開いたあと少し待ち、閉じられなければ「繋がったまま」と判定する
// 開いたあと、閉じられるかを待つ時間。
// **本番（遠いサーバー）では往復に時間がかかる。** 手元の 500ms のままだと、
// 断りの close が届く前に「繋がったまま」と判定してしまう（段階7-B で実際に起きた）。
// 遠い相手のときは長めに待つ
const SETTLE_MS = Number(process.env.TENKO_SETTLE_MS) || (WS.startsWith("wss") ? 3000 : 500);

// 「断られた」と判定する条件。
//
// **close code だけを見てはいけない（段階7-B で実測）。**
//   手元では close(4003) が届く。**本番（Render）では届かない**
//   （断られた接続が readyState=1 のまま残り、close が発生しない）。
//   close code だけを見ると、本番では「断られていない」と読めてしまう。
//   一方、断りの知らせ（auth.rejected）は本番でも届く。
//
// したがって「知らせが来た **か** 4003 で閉じられた」を断りとみなす。
// **どちらも無い場合だけを「通ってしまった」とする。**
const rejected = (s) => (s.msgs ?? []).includes("auth.rejected") || s.code === 4003;
const detailOf = (s) =>
  "opened=" + s.opened + " closed=" + s.closed + " code=" + s.code
  + " 受け取った知らせ=" + ((s.msgs ?? []).join(",") || "なし");
function connect(protocols) {
  return new Promise((resolve) => {
    const ws = protocols ? new WebSocket(WS, protocols) : new WebSocket(WS);
    const state = { ws, list: [], opened: false, code: null, reason: "", msgs: [] };
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(state); } };
    ws.on("open", () => { state.opened = true; setTimeout(done, SETTLE_MS); });
    ws.on("message", (d) => {
      try {
        const m = JSON.parse(d.toString());
        if (m.type === "presence.list") state.list = m.users;
        if (m.type === "auth.rejected" || m.type === "auth.expired") state.authMsg = m;
        state.msgs = state.msgs || [];
        state.msgs.push(m.type);
      } catch { /* 無視 */ }
    });
    ws.on("close", (c, r) => { state.code = c; state.reason = r.toString(); state.closed = true; done(); });
    ws.on("error", () => { /* close が続けて来る */ });
  });
}

(async () => {
  await db.connect();

  const victimId = Number((await db.query("SELECT id FROM users WHERE display_name='検証 部下'")).rows[0].id);
  const attackerId = Number((await db.query("SELECT id FROM users WHERE display_name='検証 無関係'")).rows[0].id);
  log(`被害者=${victimId}（検証 部下） 攻撃者=${attackerId}（検証 無関係）`);

  const victimCookie = await session(victimId);
  const attackerCookie = await session(attackerId);

  // 被害者が正しく村に入る
  const vTicket = await ticketFor(victimCookie);
  const victim = await connect(["tenko.v1", "ticket." + vTicket]);
  victim.ws.send(JSON.stringify({ type: "presence.set", user: { id: victimId }, state: "idle", talk: "ok" }));
  await wait(500);
  const before = victim.list.find((u) => Number(u.id) === victimId);
  log("被害者の状態（攻撃前）: " + JSON.stringify(before));
  log("");

  log("=== 1. 他人になりすまして在席を変える（S6。段階6の完了条件）===");
  const aTicket = await ticketFor(attackerCookie);
  const bad = await connect(["tenko.v1", "ticket." + aTicket]);
  bad.ws.send(JSON.stringify({
    type: "presence.set",
    user: { id: victimId, name: "乗っ取り", colorIndex: 3 },
    state: "away", talk: "focus",
  }));
  await wait(600);
  victim.ws.send(JSON.stringify({ type: "presence.sync" }));
  await wait(400);
  const after = victim.list.find((u) => Number(u.id) === victimId);
  const asAttacker = victim.list.find((u) => Number(u.id) === attackerId);
  log("  被害者の状態（攻撃後）: " + JSON.stringify(after));
  log("  攻撃者として村に出たもの: " + JSON.stringify(asAttacker));
  check("他人の在席を変えられない",
    after && after.state === "idle" && after.talk === "ok",
    "state=" + after?.state + " talk=" + after?.talk + "（攻撃前と同じなら守られている）");
  check("名乗ったIDではなく、券の利用者として村に出る",
    asAttacker != null && Number(asAttacker.id) === attackerId,
    "攻撃者 id=" + asAttacker?.id + " state=" + asAttacker?.state);

  log("");
  log("=== 2. 券なしで村に載れるか ===");
  const noTicket = await connect(["tenko.v1"]);
  noTicket.ws.send(JSON.stringify({
    type: "presence.set", user: { id: victimId, name: "券なし" }, state: "away", talk: "focus",
  }));
  await wait(600);
  victim.ws.send(JSON.stringify({ type: "presence.sync" }));
  await wait(400);
  const after2 = victim.list.find((u) => Number(u.id) === victimId);
  check("券なしの接続は在席を申告できない",
    after2 && after2.state === "idle", "被害者 state=" + after2?.state);
  check("券なしの接続は村に現れない",
    !victim.list.some((u) => u.connections === 0 && Number(u.id) === victimId && u.state === "away"),
    "村の人数=" + victim.list.length);

  log("");
  log("=== 3. 見るだけの接続を何本張っても村の人数が増えないか ===");
  const nBefore = victim.list.length;
  const lurkers = [];
  for (let i = 0; i < 5; i++) lurkers.push(await connect(["tenko.v1"]));
  await wait(500);
  victim.ws.send(JSON.stringify({ type: "presence.sync" }));
  await wait(400);
  check("見るだけを5本足しても人数が変わらない",
    victim.list.length === nBefore, nBefore + " -> " + victim.list.length);
  for (const l of lurkers) l.ws.close();

  log("");
  log("=== 4. 不正な券で繋げるか ===");
  // 期限切れ: 券の中身を作り直せないため、使い回しと署名の改ざんで確かめる
  const reused = await connect(["tenko.v1", "ticket." + aTicket]);
  check("同じ券を使い回して繋げない", rejected(reused),
    detailOf(reused));

  const fresh = await ticketFor(attackerCookie);
  const tampered = fresh.slice(0, -1) + (fresh.slice(-1) === "A" ? "B" : "A");
  const t1 = await connect(["tenko.v1", "ticket." + tampered]);
  check("署名を書き換えた券で繋げない", rejected(t1), detailOf(t1));

  // 中身（利用者ID）を書き換える。署名が合わなくなる
  const body = fresh.slice(0, fresh.lastIndexOf("."));
  const decoded = Buffer.from(body, "base64url").toString("utf8").split(".");
  decoded[0] = String(victimId);
  const forgedBody = Buffer.from(decoded.join("."), "utf8").toString("base64url");
  const forged = forgedBody + "." + fresh.slice(fresh.lastIndexOf(".") + 1);
  const t2 = await connect(["tenko.v1", "ticket." + forged]);
  check("券の利用者IDを書き換えて繋げない", rejected(t2), detailOf(t2));

  log("");
  log("=== 5. 許可されていない種別は捨てられるか ===");
  const msgBefore = (await db.query("SELECT count(*)::int n FROM messages")).rows[0].n;
  for (const t of ["message.created", "call.offer", "admin.grant", "presence.setx"]) {
    bad.ws.send(JSON.stringify({ type: t, message: { id: 1, room_id: 1, body: "偽" }, to: 1 }));
  }
  await wait(600);
  const msgAfter = (await db.query("SELECT count(*)::int n FROM messages")).rows[0].n;
  check("WS経由で投稿を保存できない", msgBefore === msgAfter, "messages " + msgBefore + " -> " + msgAfter);

  log("");
  log("=== 6. HTTP 側に在席を変える口があるか ===");
  for (const path of ["/api/presence", "/api/attendance/presence"]) {
    const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    check("POST " + path + " の口が無い", r.status === 404, "status=" + r.status);
  }

  log("");
  log("=== 7. 他人の「今日やること」を書き換えられるか ===");
  const noteBefore = (await db.query("SELECT body FROM daily_notes WHERE user_id=$1", [victimId])).rows[0];
  const r7 = await fetch(API + "/api/notes", {
    method: "PUT", headers: { "Content-Type": "application/json", Cookie: attackerCookie },
    body: JSON.stringify({ body: "他人になりすまして書いた", user: victimId }),
  });
  const noteAfter = (await db.query("SELECT body FROM daily_notes WHERE user_id=$1", [victimId])).rows[0];
  check("他人の note を書き換えられない",
    JSON.stringify(noteBefore) === JSON.stringify(noteAfter),
    "status=" + r7.status + " / " + JSON.stringify(noteBefore?.body) + " -> " + JSON.stringify(noteAfter?.body));

  victim.ws.close();
  bad.ws.close();
  noTicket.ws.close();
  for (const t of madeTokens) await db.query(`DELETE FROM sessions WHERE "sessionToken"=$1`, [t]);
  // 攻撃者が書いてしまった note を消す（この確認で作られたもの）
  await db.query("DELETE FROM daily_notes WHERE user_id=$1 AND body='他人になりすまして書いた'", [attackerId]);
  log("\n確認用のセッションを削除した");
  log("結果: OK " + ok + " 件 / 通ってしまった " + ng + " 件");
  await db.end();
  process.exit(ng === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error("ERR: " + e.message);
  try { for (const t of madeTokens) await db.query(`DELETE FROM sessions WHERE "sessionToken"=$1`, [t]); await db.end(); } catch { }
  process.exit(1);
});
