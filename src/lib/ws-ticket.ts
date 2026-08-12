// WebSocket の入場券。発行はここ、検証は ws-server 側（ws-server/ticket.js）。
//
// なぜ券が要るか（設計書6節）:
//   ブラウザの WebSocket は独自のヘッダを付けられず、別ドメインの ws-server には
//   Cookie も届かない。そこで、同一オリジンで取れる短命の券を作って持たせる。
//
// **符号化は base64url。パディング（=）を付けないこと。**
//   Sec-WebSocket-Protocol の値は RFC 6455 のトークンで、= + / は使えない。
//   = が1文字でも入ると、ブラウザは new WebSocket の時点で SyntaxError を投げ、
//   サーバには何も届かない（spike/ws-auth-01 で実測）。サーバ側では救えない。
//   Buffer.toString("base64url") がこの形になる。
import crypto from "crypto";

export const TICKET_TTL_SEC = 60;

function secret(): string {
  const s = process.env.TENKO_WS_TICKET_SECRET;
  if (!s || s.length === 0) {
    throw new Error("TENKO_WS_TICKET_SECRET が設定されていません");
  }
  return s;
}

function sign(body: string): string {
  return crypto.createHmac("sha256", secret()).update(body).digest("base64url");
}

/**
 * 入場券を作る。中身は userId . sessionId . exp . nonce。
 * sessionId は「どのセッションで入ったか」で、ws-server が定期確認に使う。
 * nonce は使い捨てを担保するための1回限りの値。
 */
export function issueTicket(userId: number, sessionId: string): string {
  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SEC;
  const nonce = crypto.randomUUID();
  const payload = [userId, sessionId, exp, nonce].join(".");
  const body = Buffer.from(payload, "utf8").toString("base64url");
  return body + "." + sign(body);
}
