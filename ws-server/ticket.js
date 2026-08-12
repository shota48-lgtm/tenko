// 入場券の検証（ws-server 側）。発行は src/lib/ws-ticket.ts。
//
// **符号化は base64url でパディングなし。** 発行側と揃えること。
// Sec-WebSocket-Protocol の値は RFC 6455 のトークンで、= + / は使えない。
// = が入るとブラウザが new WebSocket の時点で例外を投げ、ここには何も届かない
// （spike/ws-auth-01 で実測。サーバ側では救えない）。
const crypto = require("crypto");

const NONCE_TTL_MS = 10 * 60_000;   // 使い回しを拒むために覚えておく時間

function secret() {
  const s = process.env.TENKO_WS_TICKET_SECRET;
  if (!s || s.length === 0) throw new Error("TENKO_WS_TICKET_SECRET が設定されていません");
  return s;
}

// 使った nonce。同じ券で2回入れない
const usedNonces = new Map();   // nonce -> 使った時刻
function sweep() {
  const now = Date.now();
  for (const [k, t] of usedNonces) if (now - t > NONCE_TTL_MS) usedNonces.delete(k);
}

/**
 * 券を検証する。通れば { ok:true, userId, sessionId }。
 * opts.consume === false のときは nonce を消費しない（試験用）。
 */
function verifyTicket(ticket, opts = {}) {
  if (typeof ticket !== "string" || ticket.length === 0) return { ok: false, why: "券が無い" };
  const i = ticket.lastIndexOf(".");
  if (i <= 0) return { ok: false, why: "券の形が違う" };
  const body = ticket.slice(0, i);
  const mac = ticket.slice(i + 1);

  let expect;
  try {
    expect = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  } catch (e) {
    return { ok: false, why: "署名鍵がない: " + e.message };
  }
  // 長さが違うと timingSafeEqual が投げるので先に見る
  if (mac.length !== expect.length) return { ok: false, why: "署名が違う" };
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) {
    return { ok: false, why: "署名が違う" };
  }

  const parts = Buffer.from(body, "base64url").toString("utf8").split(".");
  if (parts.length !== 4) return { ok: false, why: "券の中身の形が違う" };
  const [userIdStr, sessionId, expStr, nonce] = parts;
  const userId = Number(userIdStr);
  const exp = Number(expStr);
  if (!Number.isInteger(userId) || userId <= 0) return { ok: false, why: "利用者IDが読めない" };
  if (!Number.isFinite(exp)) return { ok: false, why: "期限が読めない" };
  if (exp < Math.floor(Date.now() / 1000)) return { ok: false, why: "券の期限切れ" };

  if (opts.consume !== false) {
    sweep();
    if (usedNonces.has(nonce)) return { ok: false, why: "券の使い回し" };
    usedNonces.set(nonce, Date.now());
  }
  return { ok: true, userId, sessionId, exp, nonce };
}

module.exports = { verifyTicket, usedNonces, NONCE_TTL_MS };
