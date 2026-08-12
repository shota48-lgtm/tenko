/* 審査役A（Phase 5 段階4-5）: 見るだけモードに攻撃を送る。
   未認証で開いている4本から、意図しない情報が漏れないことを実際に確かめる。
   実行: node scripts/attack-public-view.js

   見る点:
     - 勤怠の記録が一切見えないこと（読み取りも含む）
     - 実在の利用者の「今日やること」が見えないこと（デモ用の分だけ）
     - 実在の利用者の表示名が見えないこと
     - email / role / manager_id が含まれないこと
     - 書き込みが一切できないこと
     - デモ用の利用者としてログインできないこと */
const fs = require("fs");
const crypto = require("crypto");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const API = process.env.TENKO_API || "http://localhost:3000";

let ok = 0, ng = 0;
const check = (label, cond, detail) => {
  if (cond) { ok++; console.log("  OK   " + label + (detail ? " : " + detail : "")); }
  else { ng++; console.log("  通った " + label + (detail ? " : " + detail : "")); }
};

// Cookie を付けずに叩く（＝村を見ているだけの人）
async function anon(path, opts = {}) {
  const res = await fetch(API + path, {
    method: opts.method ?? "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const real = (await db.query(
    `SELECT id, display_name FROM users WHERE deleted_at IS NULL AND is_demo = false ORDER BY id`)).rows;
  const demoIds = (await db.query(`SELECT id FROM users WHERE is_demo = true`)).rows.map((r) => Number(r.id));
  console.log("実在の利用者: " + real.map((r) => r.id + ":" + r.display_name).join(", "));
  console.log("デモ用: " + demoIds.length + " 人\n");

  console.log("=== 1. 開いている経路の応答に、機微な情報が無いか");
  for (const p of ["/api/rooms", "/api/users", "/api/notes", "/api/demo-presence"]) {
    const r = await anon(p);
    const bad = ["email", "@", "manager_id", "\"role\"", "attendance", "work_date"].filter((w) => r.text.includes(w));
    check(p + " に機微な語が無い", r.status === 200 && bad.length === 0,
          "status=" + r.status + " len=" + r.text.length + (bad.length ? " 検出: " + bad.join(" / ") : ""));
  }

  console.log("=== 2. 実在の利用者が漏れていないか");
  const users = await anon("/api/users");
  const leakedNames = real.filter((u) => users.text.includes(u.display_name));
  check("実在の利用者の表示名が /api/users に出ない", leakedNames.length === 0,
        leakedNames.length ? "漏れた: " + leakedNames.map((u) => u.display_name).join(", ") : "0 件");

  const notes = await anon("/api/notes");
  const noteRows = JSON.parse(notes.text).notes ?? [];
  const foreign = noteRows.filter((n) => !demoIds.includes(Number(n.user_id)));
  check("「今日やること」がデモ用の分だけ", foreign.length === 0,
        "デモ以外が " + foreign.length + " 件（全 " + noteRows.length + " 件）");

  console.log("=== 3. 勤怠は読み取りも含めて全閉か");
  for (const p of [
    "/api/attendance/drafts", "/api/attendance/approvals", "/api/attendance/corrections",
    "/api/attendance/anomalies", "/api/attendance/monthly?year=2026&month=8",
    "/api/attendance/drafts/1", "/api/attendance/approvals/1",
  ]) {
    const r = await anon(p);
    check("未認証で " + p + " が読めない", r.status === 401 || r.status === 405,
          "status=" + r.status + " " + r.text.slice(0, 40));
  }
  // 中身が漏れていないことも見る（本文に勤怠の語が無いこと）
  const drafts = await anon("/api/attendance/drafts");
  check("勤怠の応答に中身が無い", !drafts.text.includes("event_at") && !drafts.text.includes("kind"),
        drafts.text.slice(0, 60));

  console.log("=== 4. 未認証で書き込めないか");
  const writes = [
    ["PUT", "/api/notes", { body: "見るだけの人が書いた" }],
    ["DELETE", "/api/notes", undefined],
    ["POST", "/api/announcements", { body: "見るだけの人が書いた" }],
    ["POST", "/api/rooms/1/messages", { clientMsgId: crypto.randomUUID(), body: "見るだけの人が書いた" }],
    ["POST", "/api/attendance/drafts/1", { action: "confirm" }],
    ["POST", "/api/attendance/approvals/1", { action: "approve" }],
    ["POST", "/api/attendance/corrections", { kind: "arrive", eventAt: new Date().toISOString(), reason: "x" }],
  ];
  const before = (await db.query("SELECT count(*)::int n FROM messages")).rows[0].n;
  for (const [method, path, body] of writes) {
    const r = await anon(path, { method, body });
    check("未認証で " + method + " " + path + " が通らない", r.status === 401,
          "status=" + r.status + " " + r.text.slice(0, 40));
  }
  const after = (await db.query("SELECT count(*)::int n FROM messages")).rows[0].n;
  check("投稿が1件も保存されていない", before === after, "messages " + before + " -> " + after);

  console.log("=== 5. デモ用の利用者としてログインできないか");
  // (a) DB の制約: デモ用にメールアドレスを付けられない
  const demoId = demoIds[0];
  let blocked = false;
  try {
    await db.query("UPDATE users SET email='demo-attack@example.com' WHERE id=$1", [demoId]);
  } catch (e) {
    blocked = true;
    console.log("  OK   デモ用にメールアドレスを付けられない -> 例外: " + e.message.split("\n")[0]);
    ok++;
  }
  if (!blocked) {
    ng++;
    console.log("  通った デモ用にメールアドレスを付けられてしまった（元に戻す）");
    await db.query("UPDATE users SET email=NULL WHERE id=$1", [demoId]);
  }
  // (b) 仮にセッションが作られても、中には入れない
  const token = crypto.randomUUID();
  await db.query(
    `INSERT INTO sessions ("userId", expires, "sessionToken") VALUES ($1, now() + interval '1 hour', $2)`,
    [demoId, token]);
  const meRes = await fetch(API + "/api/me", { headers: { Cookie: "authjs.session-token=" + token } });
  check("デモ用のセッションがあっても中に入れない", meRes.status === 401,
        "status=" + meRes.status + " " + (await meRes.text()).slice(0, 40));
  await db.query(`DELETE FROM sessions WHERE "sessionToken"=$1`, [token]);

  console.log("\n結果: OK " + ok + " 件 / 通ってしまった " + ng + " 件");
  await db.end();
  process.exit(ng === 0 ? 0 : 1);
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
