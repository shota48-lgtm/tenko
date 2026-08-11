/* 審査役A（Phase 4.7）: 在席状態への攻撃を実際に送る。
   - 他人の状態を変更できないか
   - 画面に出る名前が、リクエストの値から取られていないか
   - 許可されていない種別が捨てられるか
   実行: node scripts\attack-presence.js */
const fs = require("fs");
const { Client } = require("pg");
const WebSocket = require("ws");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const API = "http://localhost:3000";
const log = (s) => console.log(s);

const open = () => new Promise((resolve) => {
  const ws = new WebSocket("ws://localhost:8080");
  ws.on("open", () => resolve(ws));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const victim = Number((await db.query("SELECT id FROM users WHERE display_name='群衆01'")).rows[0].id);
  const attacker = Number((await db.query("SELECT id FROM users WHERE display_name='検証 無関係'")).rows[0].id);
  log(`被害者=${victim}（群衆01・在席で接続中） 攻撃者=${attacker}`);

  const watcher = await open();
  let list = [];
  watcher.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === "presence.list") list = m.users;
  });
  await wait(400);
  const before = list.find((u) => Number(u.id) === victim);
  log("攻撃前の被害者の状態: " + JSON.stringify(before));

  log("");
  log("=== 1. 他人になりすまして状態を変える（WS） ===");
  const bad = await open();
  bad.send(JSON.stringify({
    type: "presence.set",
    user: { id: victim, name: "乗っ取り", colorIndex: 1 },
    state: "away", talk: "focus",
  }));
  await wait(600);
  watcher.send(JSON.stringify({ type: "presence.sync" }));
  await wait(400);
  const after = list.find((u) => Number(u.id) === victim);
  log("攻撃後の被害者の状態: " + JSON.stringify(after));
  log("→ 認証が無いため WS では防げない。これは既知の状態（S6）。画面の名前は DB を正にしてある");

  log("");
  log("=== 2. 画面に出る名前が、申告した名前になっていないか ===");
  const u = await (await fetch(API + "/api/users")).json();
  const dbName = u.users.find((x) => x.id === victim)?.displayName;
  log("  DBの表示名: " + JSON.stringify(dbName));
  log("  在席の配信に含まれる名前: " + JSON.stringify(after ? after.name : null) + "（undefined なら配られていない）");
  log("  → Phase 4.9 で名前を配信から外した。騙れる名前が他人の画面に届く経路が構造的に無い");

  log("");
  log("=== 3. 許可されていない種別は捨てられるか ===");
  const msgBefore = (await db.query("SELECT count(*)::int n FROM messages")).rows[0].n;
  for (const t of ["message.created", "call.offer", "admin.grant", "presence.setx"]) {
    bad.send(JSON.stringify({ type: t, message: { id: 1, room_id: 1, body: "偽" }, to: 1 }));
  }
  await wait(600);
  const msgAfter = (await db.query("SELECT count(*)::int n FROM messages")).rows[0].n;
  log("  messages: " + msgBefore + " -> " + msgAfter + "（増えていなければ保存されていない）");
  log("  ※ 受け取り側の判定は許可リスト。presence.setx のような紛らわしい種別も弾く");

  log("");
  log("=== 4. HTTP 側で他人の在席を変える口があるか ===");
  for (const path of ["/api/presence", "/api/attendance/presence"]) {
    const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    log("  POST " + path + " -> " + r.status + "（404 なら口が無い）");
  }

  log("");
  log("=== 5. 他人の「今日やること」を書き換えられるか ===");
  const noteBefore = (await db.query("SELECT body FROM daily_notes WHERE user_id=$1", [victim])).rows[0];
  const r5 = await fetch(API + "/api/notes", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: "他人になりすまして書いた", user: victim }),
  });
  const noteAfter = (await db.query("SELECT body FROM daily_notes WHERE user_id=$1", [victim])).rows[0];
  log("  status=" + r5.status + " / " + JSON.stringify(noteBefore?.body) + " -> " + JSON.stringify(noteAfter?.body));
  log("  → TENKO_TRUST_USER_PARAM=0 にすれば塞がる（Phase 4.5 で実測済み）");
  // 元に戻す
  if (noteBefore) await db.query("UPDATE daily_notes SET body=$2 WHERE user_id=$1", [victim, noteBefore.body]);

  watcher.close();
  bad.close();
  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
