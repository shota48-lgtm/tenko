// WebSocket サーバーへの通知。
//
// 重要（設計方針・崩さないこと）:
//   ここは「保存が済んだ後に知らせるだけ」の経路である。
//   通知が失敗しても、保存済みの事実は変わらないため、呼び出し元に例外を伝播させない。
//   通知を落としても、クライアントは再接続時に after=<id> の差分取得で追いつける。
import WebSocket from "ws";

const WS_URL = process.env.WS_NOTIFY_URL ?? "ws://localhost:8080";
const WS_TOKEN = process.env.WS_NOTIFY_TOKEN ?? "dev-notify-token";

export type NotifyResult = { delivered: boolean; error?: string };

export function notifyNewMessage(payload: unknown): Promise<NotifyResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: NotifyResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(`${WS_URL}/?role=notifier&token=${encodeURIComponent(WS_TOKEN)}`);
    } catch (e) {
      done({ delivered: false, error: String(e) });
      return;
    }

    const timer = setTimeout(() => {
      try { ws.terminate(); } catch {}
      done({ delivered: false, error: "timeout" });
    }, 1500);

    ws.on("open", () => {
      ws.send(JSON.stringify(payload), (err) => {
        clearTimeout(timer);
        done(err ? { delivered: false, error: err.message } : { delivered: true });
        ws.close();
      });
    });

    ws.on("error", (err: Error) => {
      clearTimeout(timer);
      // 接続拒否のとき ws は message が空の AggregateError を渡してくる（実測）。
      // 通知が落ちた理由が報告に残らなくなるため、name とコードで補う
      const code = (err as Error & { code?: string }).code;
      done({ delivered: false, error: err.message || code || err.name || "不明なエラー" });
    });
  });
}
