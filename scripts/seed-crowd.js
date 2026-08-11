/* 審査役B用: 20人が同時にいる状態を作る。
   利用者を用意し、今日やることを入れ、WSで在席を申告し続ける（Ctrl+C まで維持）。
   実行: node scripts\seed-crowd.js [人数] */
const fs = require("fs");
const { Client } = require("pg");
const WebSocket = require("ws");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const API = "http://localhost:3000";
const N = Number(process.argv[2] || 20);

const NOTES = [
  "見積もりの作成",
  "設計レビューの準備と、15時からの打ち合わせ",
  "請求書の確認",
  "リリース準備。手順書の見直しまで",
  "採用面談 15時",
  "在庫の棚卸し",
  "第3四半期の売上見込みの資料をまとめて共有する",
  "月次の締め",
  "",
  "問い合わせ対応",
];
const STATES = ["idle", "talking", "away", "resting"];
const TALKS = ["ok", "later", "focus"];

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const users = [];
  for (let i = 1; i <= N; i++) {
    const name = "群衆" + String(i).padStart(2, "0");
    const r = await db.query("SELECT id FROM users WHERE display_name=$1", [name]);
    const id = r.rows.length
      ? Number(r.rows[0].id)
      : Number((await db.query("INSERT INTO users (display_name, role) VALUES ($1,'member') RETURNING id", [name])).rows[0].id);
    users.push({ id, name });
  }
  console.log("用意した利用者: " + users.length + " 人（id " + users[0].id + "〜" + users[users.length - 1].id + "）");

  // 今日やること。APIを通して入れる（検証もサーバー側の経路で行う）
  let wrote = 0;
  for (let i = 0; i < users.length; i++) {
    const body = NOTES[i % NOTES.length];
    if (body === "") continue;
    const res = await fetch(API + "/api/notes", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, user: users[i].id }),
    });
    if (res.ok) wrote++;
  }
  console.log("今日やることを入れた人数: " + wrote + "（残りは未記入のまま）");

  // 建物を埋めるための移動先。Phase 4.8 から、部屋に入るには座標を動かす。
  // 足元（絵の中央下）が建物の枠に入る位置を狙う。geometry.js の buildingAt と同じ考え方
  const geo = require("../ws-server/geometry");
  const rects = geo.buildingRects(
    (await (await fetch(API + "/api/rooms")).json()).rooms,
  );
  const house = rects[0];             // 定員4の部屋
  const hall = rects.find((r) => r.room.kind === "hall") || rects[6];  // 定員12の建物
  // 先頭4人を定員4の部屋へ、次の12人を定員12の建物へ入れて、両方を満員にする
  // 足元を建物の枠の中央に置く。y+PERSON_SIZE-4 が枠の中に入る必要がある
  const inside = (b, i) => ({ x: b.x + ((i % 3) - 1) * 5, y: b.y - 12 + (i % 2) * 3 });
  // plaza を付けると誰も建物に入れない（吹き出しの件数を広場で見比べるとき用）
  const PLAZA_ONLY = process.argv.includes("plaza");
  const target = (i) => {
    if (PLAZA_ONLY) return null;
    if (i < 4) return inside(house, i);
    if (i < 16) return inside(hall, i);
    return null;
  };

  // 在席を申告し続ける
  const sockets = [];
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const ws = new WebSocket("ws://localhost:8080");
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "presence.set",
        user: { id: u.id, name: u.name, colorIndex: (i % 4) + 1 },
        state: STATES[i % STATES.length],
        talk: TALKS[i % TALKS.length],
      }));
      const t = target(i);
      if (t) setTimeout(() => ws.send(JSON.stringify({ type: "presence.move", x: t.x, y: t.y })), 60);
    });
    sockets.push(ws);
    await new Promise((r) => setTimeout(r, 30));
  }
  console.log("在席を申告した接続: " + sockets.length + " 本。Ctrl+C で終了する");
  await db.end();
  setInterval(() => {}, 1 << 30);
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
