// 作業3-1,2: 保存と通知、および同一 client_msg_id の二重送信
const fs = require("fs");
const { Client } = require("pg");
const WebSocket = require("ws");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const API = "http://localhost:3000/api/rooms/1/messages";
const CID = "11111111-1111-4111-8111-111111111111";
const log = (s) => console.log(s);

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const before = (await db.query("SELECT count(*)::int n FROM messages")).rows[0].n;
  log("開始時の messages 件数: " + before);

  // 別クライアント役（受信専用）
  const viewer = new WebSocket("ws://localhost:8080");
  const received = [];
  viewer.on("message", (d) => { received.push(d.toString()); log("[viewer 受信] " + d.toString().slice(0, 140)); });
  await new Promise((r) => viewer.on("open", r));
  log("viewer 接続完了");

  // 1回目
  const r1 = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientMsgId: CID, body: "1回目の投稿" }) });
  const j1 = await r1.json();
  log("1回目: status=" + r1.status + " duplicate=" + j1.duplicate + " notified=" + j1.notified + " id=" + (j1.message && j1.message.id));

  await new Promise((r) => setTimeout(r, 600));

  // 2回目（同じ client_msg_id で再送）
  const r2 = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientMsgId: CID, body: "1回目の投稿" }) });
  const j2 = await r2.json();
  log("2回目: status=" + r2.status + " duplicate=" + j2.duplicate + " notified=" + j2.notified + " id=" + (j2.message && j2.message.id));

  await new Promise((r) => setTimeout(r, 600));

  const rows = (await db.query("SELECT id, client_msg_id, body FROM messages WHERE client_msg_id = $1", [CID])).rows;
  log("DB 上の該当 client_msg_id の件数: " + rows.length);
  log("DB 上の行: " + JSON.stringify(rows));
  log("viewer が受け取った通知の件数: " + received.length);

  // 画面側から WS に送っても保存・配信されないことの確認
  viewer.send(JSON.stringify({ type: "message.created", message: { id: 999, room_id: 1, body: "WS経由の偽投稿" } }));
  await new Promise((r) => setTimeout(r, 500));
  const after = (await db.query("SELECT count(*)::int n FROM messages")).rows[0].n;
  log("viewer から WS 送信後の messages 件数: " + after + "（増えていなければ WS 経由では保存されない）");

  viewer.close();
  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });