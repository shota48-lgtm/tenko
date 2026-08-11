// tenko WebSocket サーバー（通知路。Next.js 本体から分離して動かす）
//
// 設計方針（spike/ws-01 の実測にもとづき固定。崩さないこと）:
//   - ここでデータを保存しない。チャットの投稿は HTTP + DB を正とする
//   - 勤怠は一切ここを通さない
//   - 在席状態のみ、将来このサーバー上の揮発メモリで扱う（失っても再接続時に取り直す）
//
// 「WS 経由で保存しない」を運用ではなく構造で担保するため、
// 配信できるのは token を持つ通知役（Next.js の API ルート）だけとし、
// 画面側のクライアントは受信専用にする。画面から送られてきたものは捨てる。

const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 8080;
const NOTIFY_TOKEN = process.env.WS_NOTIFY_TOKEN || "dev-notify-token";

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", "http://localhost");
  const isNotifier =
    url.searchParams.get("role") === "notifier" &&
    url.searchParams.get("token") === NOTIFY_TOKEN;
  ws.isNotifier = isNotifier;

  console.log(
    "[open] " + (isNotifier ? "notifier" : "viewer") + " clients=" + wss.clients.size,
  );

  ws.on("message", (data) => {
    if (!ws.isNotifier) {
      // 画面側からの送信は保存も配信もしない。投稿は HTTP を通ること
      console.log("[drop] viewer からの送信を破棄した");
      return;
    }
    const text = data.toString();
    console.log("[notify] " + text.slice(0, 120));
    for (const c of wss.clients) {
      if (c !== ws && !c.isNotifier && c.readyState === 1) c.send(text);
    }
  });

  ws.on("close", () => console.log("[close] clients=" + wss.clients.size));
});

console.log("ws-server listening on port " + PORT);