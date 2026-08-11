/* 審査役A（Phase 4.9）: お知らせ（噴水）への攻撃を実際に送る。
   - member / manager が書けないこと
   - 消せるのが admin だけであること
   - 入力の検証がサーバー側で効くこと
   - 他人の未読・下書きを取れないこと（/api/village）
   実行: node scripts\attack-phase49.js */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const API = "http://localhost:3000";
const log = (s) => console.log(s);

const post = (body) => fetch(API + "/api/announcements", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const idOf = async (name) => Number((await db.query("SELECT id FROM users WHERE display_name=$1", [name])).rows[0].id);
  const member = await idOf("検証 部下");
  const manager = await idOf("検証 上長");
  const admin = await idOf("検証 管理者");
  log(`member=${member} manager=${manager} admin=${admin}`);

  log("");
  log("=== 1. お知らせを書けるのは admin だけか ===");
  for (const [name, id] of [["member", member], ["manager", manager], ["admin", admin]]) {
    const r = await post({ body: name + " が書いたお知らせ", user: id });
    const j = await r.json().catch(() => ({}));
    log(`  ${name.padEnd(8)} -> status=${r.status} ${j.error ? "「" + j.error + "」" : "（書けた）"}`);
  }
  const { rows: after } = await db.query("SELECT user_id FROM announcements WHERE deleted_at IS NULL");
  log("  DBに残ったお知らせの書き手: " + JSON.stringify(after.map((r) => Number(r.user_id))));
  log("  → admin 以外の id が混ざっていなければ守られている");

  log("");
  log("=== 2. 入力の検証（サーバー側）===");
  const cases = [
    ["HTMLタグ", "<script>alert(1)</script>"],
    ["改行の混入", "1行目\n2行目"],
    ["ゼロ幅スペース", "a​b"],
    ["空文字", ""],
    ["空白のみ", "   "],
    ["200文字ちょうど", "あ".repeat(200)],
    ["201文字", "あ".repeat(201)],
    ["文字列でない", 12345],
    ["SQLらしき文字列", "'); DROP TABLE announcements; --"],
  ];
  for (const [name, body] of cases) {
    const r = await post({ body, user: admin });
    const j = await r.json().catch(() => ({}));
    const saved = j.announcement ? JSON.stringify(j.announcement.body).slice(0, 40) : "(保存されず)";
    log(`  ${name.padEnd(16, "　")} status=${r.status} ${saved} ${j.error ? "「" + j.error + "」" : ""}`);
  }
  const alive = await db.query("SELECT count(*)::int n FROM announcements");
  log("  announcements: 健在（" + alive.rows[0].n + " 行）");

  log("");
  log("=== 3. 消せるのは admin だけか ===");
  const target = Number((await db.query("SELECT id FROM announcements WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1")).rows[0].id);
  for (const [name, id] of [["member", member], ["manager", manager], ["admin", admin]]) {
    const r = await fetch(API + "/api/announcements", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: target, user: id }),
    });
    const j = await r.json().catch(() => ({}));
    log(`  ${name.padEnd(8)} -> status=${r.status} ${j.error ? "「" + j.error + "」" : "削除=" + j.deleted}`);
  }

  log("");
  log("=== 4. 他人の未読・勤怠の下書きを取れるか（/api/village）===");
  const a = await (await fetch(API + "/api/village?user=" + member)).json();
  const b = await (await fetch(API + "/api/village?user=" + manager)).json();
  log("  member の下書き件数=" + a.drafts.length + " / manager の下書き件数=" + b.drafts.length);
  log("  → user を指定すればなりすませる（認証未実装。S6の既知の状態）。");
  log("    返すのは指定された1人分だけで、全員分をまとめて返す口は無い");

  log("");
  log("=== 5. 存在しない利用者 ===");
  for (const bad of [999999, -1, 0, "1; DROP TABLE users"]) {
    const r = await post({ body: "test", user: bad });
    const j = await r.json().catch(() => ({}));
    log(`  user=${JSON.stringify(bad)} -> status=${r.status} ${j.error ? "「" + j.error + "」" : ""}`);
  }

  log("");
  log("=== 6. 応答の Content-Type ===");
  const r6 = await fetch(API + "/api/announcements?user=" + admin);
  log("  GET /api/announcements -> " + r6.headers.get("content-type"));

  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
