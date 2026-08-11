// tenko WebSocket サーバー（通知路 + 在席状態）
//
// 設計方針（spike/ws-01 の実測にもとづき固定。崩さないこと）:
//   - ここでデータを保存しない。チャットの投稿は HTTP + DB を正とする
//   - 勤怠は一切ここを通さない
//   - 在席状態はこのサーバーの揮発メモリだけで持つ。DBには保存しない
//     （失っても再接続時に取り直せるため。勤怠の記録は Phase 4 で別に実装する）
//
// 「WS 経由で投稿を保存しない」を構造で担保するため、
// 配信できるのは token を持つ通知役（Next.js の API ルート）だけとする。
// 画面側のクライアントが送れるのは presence.* のみで、それ以外は捨てる。

const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 8080;
const NOTIFY_TOKEN = process.env.WS_NOTIFY_TOKEN || "dev-notify-token";

const wss = new WebSocketServer({ port: PORT });
const presence = new Map();   // ws -> { id, name, colorIndex, state, roomId }

function presenceList() {
  return Array.from(presence.values());
}
function broadcast(obj) {
  const text = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (!c.isNotifier && c.readyState === 1) c.send(text);
  }
}
function sendList() {
  // 差分ではなく全体を配る。切断中の変更を取りこぼしても、次の全体で追いつけるため
  broadcast({ type: "presence.list", users: presenceList() });
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", "http://localhost");
  ws.isNotifier =
    url.searchParams.get("role") === "notifier" &&
    url.searchParams.get("token") === NOTIFY_TOKEN;

  console.log("[open] " + (ws.isNotifier ? "notifier" : "viewer") + " clients=" + wss.clients.size);

  // 接続した画面には、まず現在の在席一覧をまとめて送る
  if (!ws.isNotifier) ws.send(JSON.stringify({ type: "presence.list", users: presenceList() }));

  ws.on("message", (data) => {
    const text = data.toString();
    if (ws.isNotifier) {
      console.log("[notify] " + text.slice(0, 120));
      broadcast(JSON.parse(text));
      return;
    }
    // 画面側から受け付けるのは在席の申告だけ。投稿は HTTP を通ること
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg.type !== "string" || msg.type.indexOf("presence.") !== 0) {
      console.log("[drop] viewer からの " + (msg && msg.type) + " を破棄した");
      return;
    }
    if (msg.type === "presence.set") {
      const u = msg.user || {};
      if (msg.state === "off") presence.delete(ws);
      else presence.set(ws, {
        id: Number(u.id) || 0,
        // 名前も他人の画面に出るため、長さを切る。中継しかしないサーバー側でも防ぐ
        name: String(u.name || "名無し").slice(0, 40),
        colorIndex: Number(u.colorIndex) || 1,
        state: ["idle", "away", "talking", "resting"].indexOf(msg.state) >= 0 ? msg.state : "idle",
        roomId: msg.roomId == null ? null : Number(msg.roomId),
        // 話しかけてよいか（機能3）。決められた3つ以外は受け取らない
        talk: ["ok", "later", "focus"].indexOf(msg.talk) >= 0 ? msg.talk : "ok",
      });
      sendList();
    } else if (msg.type === "presence.sync") {
      ws.send(JSON.stringify({ type: "presence.list", users: presenceList() }));
    }
  });

  ws.on("close", () => {
    if (presence.delete(ws)) sendList();
    console.log("[close] clients=" + wss.clients.size);
  });
});

console.log("ws-server listening on port " + PORT);
