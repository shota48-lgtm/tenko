/* 既存の users の1行に、.env.local の TENKO_ADMIN_EMAILS の先頭のアドレスを紐づける。
   ログインできるのは users に登録された人だけなので、最初の1人はこの経路で作る。
   アドレスの値は表示しない（有無だけを出す）。
   実行: node scripts/link-user-email.js <userId>
   戻す: node scripts/link-user-email.js <userId> --unlink */
const fs = require("fs");
const { Client } = require("pg");
const env = fs.readFileSync(".env.local", "utf8").split(/\r?\n/);
const pick = (k) => {
  const l = env.find((x) => x.startsWith(k + "="));
  return l ? l.slice(k.length + 1).trim().replace(/^["']|["']$/g, "") : "";
};
const url = pick("DATABASE_URL");
const email = pick("TENKO_ADMIN_EMAILS").split(",")[0].trim();
const userId = Number(process.argv[2]);
const UNLINK = process.argv.includes("--unlink");

(async () => {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("userId を指定すること");
  if (!UNLINK && email.length === 0) throw new Error("TENKO_ADMIN_EMAILS が空");

  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const before = await db.query(
    `SELECT id, display_name, role, (email IS NOT NULL) AS has_email, is_demo
       FROM users WHERE id = $1`, [userId]);
  if (before.rows.length === 0) throw new Error("その利用者はいない: " + userId);
  const b = before.rows[0];
  console.log("変更前: id=" + b.id + " " + b.display_name + " role=" + b.role +
              " email=" + (b.has_email ? "あり" : "なし") + " is_demo=" + b.is_demo);
  if (b.is_demo) throw new Error("デモ用の利用者にはアドレスを紐づけられない（DB側の制約でも弾かれる）");

  const r = await db.query(
    `UPDATE users SET email = $2 WHERE id = $1
     RETURNING id, display_name, role, (email IS NOT NULL) AS has_email`,
    [userId, UNLINK ? null : email],
  );
  const a = r.rows[0];
  console.log("変更後: id=" + a.id + " " + a.display_name + " role=" + a.role +
              " email=" + (a.has_email ? "あり" : "なし"));
  console.log("※ role はここでは変えない。admin への昇格はログイン時に signIn が行う");
  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
