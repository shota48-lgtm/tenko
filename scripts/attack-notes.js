/* 審査役A: 「今日やること」への攻撃を実際に送る。
   コードを読んで安全と判断するのではなく、送って確かめる。
   実行: node scripts\attack-notes.js （next dev の起動が必要） */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const API = "http://localhost:3000";

const ctrl = (n) => String.fromCharCode(n);
const CASES = [
  { label: "HTMLタグ", body: "<script>alert(1)</script>" },
  { label: "img onerror", body: '<img src=x onerror="alert(1)">' },
  { label: "閉じタグ混入", body: "</div><b>太字</b>" },
  { label: "改行の混入", body: "1行目" + ctrl(10) + "2行目" + ctrl(13) + "3行目" },
  { label: "タブ・ヌル文字", body: "a" + ctrl(9) + "b" + ctrl(0) + "c" },
  { label: "双方向制御(RLO)", body: "abc" + String.fromCodePoint(0x202e) + "gnp.exe" },
  { label: "ゼロ幅スペース", body: "a" + String.fromCodePoint(0x200b) + "b" },
  { label: "空文字", body: "" },
  { label: "空白のみ", body: "   " },
  { label: "絵文字", body: "設計レビュー 🙂🎌👨‍👩‍👧‍👦" },
  { label: "80文字ちょうど", body: "あ".repeat(80) },
  { label: "81文字", body: "あ".repeat(81) },
  { label: "10万文字", body: "あ".repeat(100000) },
  { label: "SQLらしき文字列", body: "'); DROP TABLE daily_notes; --" },
  { label: "文字列でない(数値)", body: 12345 },
  { label: "文字列でない(オブジェクト)", body: { a: 1 } },
];

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const me = 1;

  console.log("=== 入力の検証（サーバー側）===");
  for (const c of CASES) {
    const r = await fetch(API + "/api/notes", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: c.body, user: me }),
    });
    const j = await r.json().catch(() => ({}));
    const stored = j.note ? j.note.body : null;
    const shown = stored === null ? "(保存されず)" : JSON.stringify(stored).slice(0, 70);
    console.log(`  ${c.label.padEnd(22)} status=${r.status} 保存後=${shown}` + (j.error ? ` 「${j.error}」` : ""));
  }

  console.log("");
  console.log("=== DBに実際に入っている値（制御文字が残っていないか）===");
  const rows = (await db.query(
    `SELECT body, char_length(body) AS len FROM daily_notes WHERE user_id=$1`, [me])).rows;
  for (const r of rows) {
    const codes = Array.from(r.body).map((ch) => ch.codePointAt(0));
    const bad = codes.filter((c) => c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || c === 0xfeff);
    console.log("  値=" + JSON.stringify(r.body).slice(0, 70) + " 長さ=" + r.len + " 危険な文字=" + (bad.length ? JSON.stringify(bad) : "なし"));
  }

  console.log("");
  console.log("=== 他人の分を書き換えられるか（S4）===");
  const others = (await db.query("SELECT id FROM users WHERE id <> $1 ORDER BY id LIMIT 2", [me])).rows;
  for (const o of others) {
    const before = (await db.query("SELECT body FROM daily_notes WHERE user_id=$1", [o.id])).rows[0];
    const r = await fetch(API + "/api/notes", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "他人になりすまして書き込んだ", user: o.id }),
    });
    const after = (await db.query("SELECT body FROM daily_notes WHERE user_id=$1", [o.id])).rows[0];
    console.log(`  user=${o.id} に書き込み -> status=${r.status} 変化=${JSON.stringify(before?.body ?? null)} -> ${JSON.stringify(after?.body ?? null)}`);
  }
  console.log("  ※ 認証が未実装のため、user を指定すればなりすませる。これは既知の状態（S6）。報告に記載する");

  console.log("");
  console.log("=== 存在しない利用者・不正なIDを指定したら ===");
  for (const u of [999999, -1, 0, "1; DROP TABLE users", null]) {
    const r = await fetch(API + "/api/notes", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "テスト", user: u }),
    });
    const j = await r.json().catch(() => ({}));
    console.log(`  user=${JSON.stringify(u)} -> status=${r.status} ${j.error ? "「" + j.error + "」" : ""}`);
  }

  console.log("");
  console.log("=== SQLインジェクションが成立していないか（テーブルが残っているか）===");
  const t = (await db.query("SELECT to_regclass('public.daily_notes') AS t")).rows[0].t;
  const users = (await db.query("SELECT count(*)::int n FROM users")).rows[0].n;
  console.log("  daily_notes: " + (t ? "健在" : "消えている") + " / users: " + users + " 件");

  console.log("");
  console.log("=== 応答の Content-Type（HTMLとして解釈されないか）===");
  const rr = await fetch(API + "/api/notes");
  console.log("  GET /api/notes -> " + rr.headers.get("content-type"));
  const body = await rr.text();
  console.log("  本文にタグがそのまま含まれるか: " + (body.includes("<script>") ? "含まれる(JSONの値として)" : "含まれない"));

  console.log("");
  console.log("=== 日付をクライアントから指定できるか ===");
  const r2 = await fetch(API + "/api/notes", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: "日付を偽装したい", user: me, note_date: "2020-01-01", date: "2020-01-01" }),
  });
  console.log("  note_date を送る -> status=" + r2.status);
  const d = (await db.query("SELECT note_date::text d FROM daily_notes WHERE user_id=$1", [me])).rows;
  const today = (await db.query("SELECT (now() AT TIME ZONE 'Asia/Tokyo')::date::text d")).rows[0].d;
  console.log("  DBの note_date=" + JSON.stringify(d.map((x) => x.d)) + " / サーバーの今日=" + today);

  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
