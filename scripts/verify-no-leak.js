/* Phase 5 段階1 の検証: users に列を足したあと、各APIの応答に
   email / emailVerified / image / is_demo が漏れていないことを実測する。
   コードを直しただけで済ませないための実測（J1: 実体を正とする）。
   実行: node scripts/verify-no-leak.js   （dev サーバが起きていること） */
const BASE = process.env.TENKO_API || "http://localhost:3000";
const USER = process.env.TENKO_DEV_USER_ID || "1";

// 禁止語。応答の本文に現れてはいけない
const FORBIDDEN = ["email", "emailVerified", "\"image\"", "is_demo", "@"];

const PATHS = [
  ["GET", "/api/rooms"],
  ["GET", "/api/users"],
  ["GET", "/api/notes"],
  ["GET", "/api/notes?user=" + USER],
  ["GET", "/api/me?user=" + USER],
  ["GET", "/api/village?user=" + USER],
  ["GET", "/api/announcements?user=" + USER],
  ["GET", "/api/rooms/1/messages?after=0&limit=5"],
  ["GET", "/api/attendance/drafts?user=" + USER],
  ["GET", "/api/attendance/approvals?user=" + USER],
  ["GET", "/api/attendance/corrections?user=" + USER],
  ["GET", "/api/attendance/anomalies?user=" + USER],
  ["GET", "/api/attendance/monthly?actor=" + USER + "&user=" + USER + "&month=2026-08"],
];

(async () => {
  let ng = 0;
  for (const [method, path] of PATHS) {
    let res, text;
    try {
      res = await fetch(BASE + path, { method });
      text = await res.text();
    } catch (e) {
      console.log("ERR  " + path + " : " + e.message);
      ng++;
      continue;
    }
    const hits = FORBIDDEN.filter((w) => text.includes(w));
    const mark = hits.length === 0 ? "OK  " : "漏れ ";
    if (hits.length > 0) ng++;
    console.log(
      mark + res.status + " " + path +
      " len=" + text.length +
      (hits.length ? "  検出: " + hits.join(" / ") : "") +
      "  先頭: " + text.replace(/\s+/g, " ").slice(0, 90),
    );
  }
  console.log("\n漏れ・失敗: " + ng + " 件 / " + PATHS.length + " 経路");
  process.exit(ng === 0 ? 0 : 1);
})();
