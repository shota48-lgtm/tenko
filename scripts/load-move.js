/* 6-2 の実測: 50人が同時に動いたときの通信量を測る。
   50本の接続がそれぞれ 100ms 間隔で座標を送り、
   見張りの1本が受け取った presence.list の件数とバイト数を数える。
   実行: node scripts\load-move.js [人数] [秒] */
const WebSocket = require("ws");
const N = Number(process.argv[2] || 50);
const SEC = Number(process.argv[3] || 10);
const geo = require("../ws-server/geometry");

const open = () => new Promise((res) => {
  const ws = new WebSocket("ws://localhost:8080");
  ws.on("open", () => res(ws));
});

(async () => {
  const watcher = await open();
  let frames = 0;
  let bytes = 0;
  watcher.on("message", (d) => {
    const t = d.toString();
    if (t.startsWith('{"type":"presence.list"')) { frames++; bytes += t.length; }
  });

  const movers = [];
  for (let i = 0; i < N; i++) {
    const ws = await open();
    ws.send(JSON.stringify({
      type: "presence.set",
      user: { id: 5000 + i, name: "負荷" + i, colorIndex: (i % 4) + 1 },
      state: "idle", talk: "ok",
    }));
    movers.push(ws);
  }
  console.log(N + " 本つないだ。" + SEC + " 秒間、全員が 100ms ごとに動く");

  await new Promise((r) => setTimeout(r, 1000));
  frames = 0; bytes = 0;
  const start = Date.now();
  let sent = 0;
  const timers = movers.map((ws, i) => setInterval(() => {
    const t = (Date.now() - start) / 1000;
    const x = 40 + ((i * 37) % 500) + Math.round(30 * Math.sin(t + i));
    const y = 40 + ((i * 53) % 300) + Math.round(30 * Math.cos(t + i));
    const at = geo.clamp(x, y);
    ws.send(JSON.stringify({ type: "presence.move", x: at.x, y: at.y }));
    sent++;
  }, 100));

  await new Promise((r) => setTimeout(r, SEC * 1000));
  timers.forEach(clearInterval);
  await new Promise((r) => setTimeout(r, 300));

  console.log("");
  console.log("送った移動: " + sent + " 件（" + Math.round(sent / SEC) + " 件/秒）");
  console.log("受け取った在席一覧: " + frames + " 回（" + Math.round(frames / SEC) + " 回/秒）");
  console.log("受け取った量: " + Math.round(bytes / 1024) + " KB（1本あたり " + Math.round(bytes / SEC / 1024) + " KB/秒）");
  console.log("1回あたりの大きさ: " + Math.round(bytes / Math.max(frames, 1)) + " バイト");
  console.log("→ 配信は 50ms にまとめているため、送った件数が増えても配信回数は毎秒20回で頭打ちになる");

  watcher.close();
  movers.forEach((w) => w.close());
  process.exit(0);
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
