// 作業3-3,4: WS サーバー停止中の投稿が DB に保存されるか / 再接続後に届くか
const fs = require("fs");
const { Client } = require("pg");
const WebSocket = require("ws");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const API = "http://localhost:3000/api/rooms/1/messages";
const t0 = Date.now();
const log = (s) => console.log("+" + ((Date.now() - t0) / 1000).toFixed(2) + "s  " + s);

// 画面と同じ作りの受信専用クライアント（自動再接続つき）
function viewer(name, onReconnect) {
  const v = { state: "初期", ws: null, delay: 1000, received: [] };
  const connect = () => {
    v.ws = new WebSocket("ws://localhost:8080");
    v.ws.on("open", () => { v.delay = 1000; v.state = "接続中"; log(`[${name}] 状態=接続中`); onReconnect && onReconnect(); });
    v.ws.on("message", (d) => { v.received.push(d.toString()); log(`[${name}] 通知受信`); });
    v.ws.on("error", () => {});
    v.ws.on("close", () => {
      if (v.stopped) return;
      v.state = "切断"; log(`[${name}] 状態=切断 → ${v.delay}ms 後に再接続`);
      setTimeout(() => { v.delay = Math.min(v.delay * 2, 3000); v.state = "再接続中"; connect(); }, v.delay);
    });
  };
  connect();
  return v;
}

const post = async (cid, body) => {
  const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientMsgId: cid, body }) });
  const j = await r.json();
  log(`POST "${body}" -> status=${r.status} duplicate=${j.duplicate} notified=${j.notified} notifyError=${j.notifyError || "なし"} id=${j.message && j.message.id}`);
  return j;
};

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  let lastId = 0;
  const v = viewer("タブB", async () => {
    // 再接続のたびに差分取得（画面の実装と同じ）
    const res = await fetch(`${API}?after=${lastId}`);
    const j = await res.json();
    log(`[タブB] 差分取得 after=${lastId} -> ${j.messages.length} 件: ` + j.messages.map((m) => m.body).join(" / "));
    lastId = Number(j.lastId);
  });
  await new Promise((r) => setTimeout(r, 1200));

  log("=== ここで PowerShell 側が ws-server を停止する ===");
  await new Promise((r) => setTimeout(r, 6000));   // 停止を待つ

  // 【最重要】WS が落ちている間の投稿
  const j1 = await post("22222222-2222-4222-8222-222222222222", "WS停止中の投稿1");
  const j2 = await post("33333333-3333-4333-8333-333333333333", "WS停止中の投稿2");

  const inDb = (await db.query(
    "SELECT id, body FROM messages WHERE client_msg_id IN ($1,$2) ORDER BY id",
    ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"])).rows;
  log("DB に入った WS停止中の投稿: " + JSON.stringify(inDb));

  log("=== ここで PowerShell 側が ws-server を再起動する ===");
  await new Promise((r) => setTimeout(r, 16000));  // 再起動と再接続を待つ

  log("タブB の状態: " + v.state + " / 受け取った通知の総数: " + v.received.length);
  log("タブB が最後まで読めた id: " + lastId);
  v.stopped = true; v.ws.close();
  await db.end();
  process.exit(0);
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });