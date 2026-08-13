/* Phase 5 段階7 の実測: 数字を「見積もり」で終わらせないための計測。
   実行: node scripts/measure-phase5.js [対象のURL]
     既定は http://localhost:3000。**本番のURLを渡せば本番で測れる**

   測るもの:
     1. セッション確認の遅延（/api/me。auth() の2クエリ + users の1クエリ）
     2. 未ログインで村を開いてから、最初のHTMLが届くまでの時間
     3. 開いた村のHTMLに、デモ用の人が何人載っているか（ws-server なしで見える人数）
     4. /api/ws-verify と /api/demo-presence の1日あたりの呼び出し回数（設定からの計算） */
const fs = require("fs");
const crypto = require("crypto");
const { Client } = require("pg");

const env = fs.readFileSync(".env.local", "utf8").split(/\r?\n/);
const pick = (k) => {
  const l = env.find((x) => x.startsWith(k + "="));
  return l ? l.slice(k.length + 1).trim().replace(/^["']|["']$/g, "") : "";
};
const url = pick("DATABASE_URL");
const BASE = process.argv[2] || process.env.TENKO_API || "http://localhost:3000";
const N = 20;

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    最小: s[0].toFixed(1),
    中央: s[Math.floor(s.length / 2)].toFixed(1),
    平均: avg.toFixed(1),
    最大: s[s.length - 1].toFixed(1),
  };
}

(async () => {
  console.log("対象: " + BASE + "\n");
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  // 確認用のセッションを作る（終わったら消す）
  const uid = Number((await db.query("SELECT id FROM users WHERE display_name='検証 部下'")).rows[0].id);
  const token = crypto.randomUUID();
  await db.query(
    `INSERT INTO sessions ("userId", expires, "sessionToken") VALUES ($1, now() + interval '1 hour', $2)`,
    [uid, token]);
  const cookie = "authjs.session-token=" + token;

  console.log("=== 1. セッション確認の遅延（/api/me を " + N + " 回）");
  const t1 = [];
  for (let i = 0; i < N; i++) {
    const s = performance.now();
    const r = await fetch(BASE + "/api/me", { headers: { Cookie: cookie } });
    await r.text();
    t1.push(performance.now() - s);
  }
  console.log("  " + JSON.stringify(stats(t1)) + " ミリ秒");
  console.log("  ※ 1回あたり auth() の2クエリ + users の1クエリ = 3クエリ");

  console.log("\n=== 2. 未ログインで村を開いてから、最初のHTMLが届くまで（" + N + " 回）");
  const t2 = [];
  let html = "";
  for (let i = 0; i < N; i++) {
    const s = performance.now();
    const r = await fetch(BASE + "/");
    html = await r.text();
    t2.push(performance.now() - s);
  }
  console.log("  " + JSON.stringify(stats(t2)) + " ミリ秒");
  console.log("  HTMLの大きさ: " + (html.length / 1024).toFixed(1) + " KB");

  console.log("\n=== 3. 最初のHTMLに載っているデモ用の人数（ws-server が寝ていても見える人数）");
  const demo = (await db.query("SELECT count(*)::int n FROM demo_presence")).rows[0].n;
  // HTML に座標が載っているかを、demo_presence の x の値で数える
  const xs = (await db.query("SELECT x, y FROM demo_presence")).rows;
  const found = xs.filter((r) => html.includes('"x":' + r.x) || html.includes("\\\"x\\\":" + r.x)).length;
  console.log("  demo_presence の行: " + demo + " 人");
  console.log("  HTML の中に座標が見つかった人: " + found + " 人");

  console.log("\n=== 4. アプリの呼び出し回数（1日あたり）");
  const interval = 60;   // 秒
  console.log("  /api/demo-presence : " + Math.round(86400 / interval) + " 回（ws-server が起きている間だけ）");
  console.log("  /api/ws-verify     : " + Math.round(86400 / interval) + " 回が上限。**認証済みの接続が0本のときは投げない**");
  console.log("  合計の上限          : " + Math.round(86400 / interval) * 2 + " 回/日");
  console.log("  ※ 無料枠で ws-server が寝ている間は、どちらも0回になる");

  await db.query(`DELETE FROM sessions WHERE "sessionToken"=$1`, [token]);
  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
