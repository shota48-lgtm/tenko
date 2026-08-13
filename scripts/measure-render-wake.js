/* Phase 5 段階7-B: Render の無料枠が停止している状態からの起動を実測する。
   実行: node scripts/measure-render-wake.js
     TENKO_API / TENKO_WS に本番のURLを入れて実行する

   測り方（順序が大事）:
     1. **先にアプリ（Vercel）だけを叩いて**、村のHTMLにデモ用の人が載っていることを確かめる。
        ここでは Render に一切触れない。**＝ ws-server が寝たまま村が見えるかの確認**
     2. そのあと ws-server に繋ぎ、**起動にかかる実時間**を測る。
        HTTP（/healthz）と WebSocket の両方で測る。どちらでも起きるはずだが、
        「WSの接続でも起きるか」は無料枠の前提そのものなので確かめる価値がある

   **この scripts を動かす前に、15分以上 Render に触れていないこと。**
   触れると停止の時計が戻る（/healthz を叩くだけでも起きてしまう）。 */
const WebSocket = require("ws");
const API = process.env.TENKO_API || "https://tenko-eight.vercel.app";
const WS = process.env.TENKO_WS || "wss://tenko-ws.onrender.com";
const HEALTH = WS.replace(/^wss:/, "https:").replace(/^ws:/, "http:") + "/healthz";
const mode = process.argv[2] === "http" ? "http" : "ws";

(async () => {
  console.log("開始: " + new Date().toTimeString().slice(0, 8));

  // --- 1. Render に触れずに、村が見えるかを確かめる
  console.log("\n=== 1. ws-server に触れずに村のHTMLを取る（＝寝ている間に見えるもの）");
  const t0 = Date.now();
  const html = await (await fetch(API + "/")).text();
  console.log("  取得: " + (Date.now() - t0) + " ms / " + (html.length / 1024).toFixed(1) + " KB");
  // 村に出ている人の数を、HTML に埋め込まれた colorIndex の数で数える
  const people = (html.match(/\\"colorIndex\\":/g) || html.match(/"colorIndex":/g) || []).length;
  const notes = (html.match(/\\"note\\":\\"/g) || []).length;
  console.log("  HTML に載っている人: " + people + " 人");
  console.log("  ※ ws-server が寝ていても、この人数が村に描かれる");

  // --- 2. ws-server を起こす
  console.log("\n=== 2. ws-server を起こす（" + (mode === "http" ? "HTTP /healthz" : "WebSocket の接続") + "）");
  const t1 = Date.now();
  if (mode === "http") {
    const r = await fetch(HEALTH);
    console.log("  起動までの実測: " + ((Date.now() - t1) / 1000).toFixed(1) + " 秒 / 応答: " + (await r.text()));
  } else {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(WS, ["tenko.v1"]);
      const timer = setTimeout(() => { reject(new Error("120秒たっても繋がらない")); }, 120_000);
      ws.on("open", () => {
        clearTimeout(timer);
        console.log("  **起動までの実測: " + ((Date.now() - t1) / 1000).toFixed(1) + " 秒**");
      });
      ws.on("message", (d) => {
        try {
          const m = JSON.parse(d.toString());
          if (m.type === "presence.list") {
            console.log("  最初の presence.list: " + m.users.length + " 人（" + ((Date.now() - t1) / 1000).toFixed(1) + " 秒）");
            ws.close();
            clearTimeout(timer);
            resolve();
          }
        } catch { /* 無視 */ }
      });
      ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
  }
  console.log("\n終了: " + new Date().toTimeString().slice(0, 8));
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
