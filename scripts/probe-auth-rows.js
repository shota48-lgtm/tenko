/* Phase 5 段階2 の実測: ログインの前後で、認証まわりの行がどう増減したかを見る。
   読み取りのみ。メールアドレスの値は表示しない（有無と件数だけを出す）。
   実行: node scripts/probe-auth-rows.js [ラベル] */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const label = process.argv[2] || "";

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const one = async (sql) => (await db.query(sql)).rows[0];

  const u = await one(`SELECT count(*)::int n, count(email)::int with_email FROM users`);
  const a = await one(`SELECT count(*)::int n FROM accounts`);
  const s = await one(`SELECT count(*)::int n FROM sessions`);
  const v = await one(`SELECT count(*)::int n FROM verification_token`);
  const maxu = await one(`SELECT COALESCE(max(id),0)::int mx FROM users`);

  console.log(
    (label ? "[" + label + "] " : "") +
    "users=" + u.n + "(email入り " + u.with_email + " / 最大id " + maxu.mx + ")" +
    " accounts=" + a.n + " sessions=" + s.n + " verification_token=" + v.n,
  );

  // 誰にどんな役割が付いているか（アドレスの値は出さない）
  const { rows } = await db.query(
    `SELECT id, display_name, role, (email IS NOT NULL) AS has_email, is_demo
       FROM users WHERE email IS NOT NULL OR role <> 'member' ORDER BY id`,
  );
  for (const r of rows) {
    console.log("  id=" + r.id + " " + r.display_name + " role=" + r.role +
                " email=" + (r.has_email ? "あり" : "なし") + " is_demo=" + r.is_demo);
  }
  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
