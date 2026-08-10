// tenko WebSocket サーバー（通知路。Next.js 本体から分離して動かす）
//
// 設計方針（spike/ws-01 の実測にもとづき固定）:
//   - ここでデータを保存しない。チャットの投稿は HTTP + DB を正とする
//   - 勤怠は一切ここを通さない
//   - 在席状態のみ、このサーバー上の揮発メモリで扱う（失っても再接続時に取り直す）
// 切断中にクライアントが送ったメッセージは例外もエラーも出ずに消えるため、
// このサーバーに届いた時点で「保存された」と解釈してはならない。

const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 8080;
const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  console.log("[open] clients=" + wss.clients.size);
  ws.on("message", (data) => {
    // Phase 1 時点では素通しの中継のみ。永続化は行わない
    for (const c of wss.clients) {
      if (c.readyState === 1) c.send(data.toString());
    }
  });
  ws.on("close", () => console.log("[close] clients=" + wss.clients.size));
});

console.log("ws-server listening on port " + PORT);
