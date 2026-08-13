/* 審査役A（Phase 5 段階7-B）: assertSameOrigin が本番のプロキシの背後で働くかを実測する。
   **段階4から4段階にわたって「仮説」のまま持ち越されていた項目。ここで決着させる。**
   実行: node scripts/attack-origin.js
     TENKO_API に本番のURLを入れて実行する

   懸念: Origin と Host を比べているため、プロキシが Host を書き換える構成では誤判定しうる。

   見る点:
     1. 正しい Origin を付けた書き込みが通ること（誤って弾いていないか）
     2. **別のオリジンを名乗った書き込みが拒まれること**
     3. Origin を付けない書き込みがどう扱われるか（サーバ同士の通信を止めないため通す設計）
     4. 未ログインなら、Origin が正しくても書けないこと */
const fs = require("fs");
const crypto = require("crypto");
const { Client } = require("pg");

const env = fs.readFileSync(".env.local", "utf8").split(/\r?\n/);
const pick = (k) => {
  const l = env.find((x) => x.startsWith(k + "="));
  return l ? l.slice(k.length + 1).trim().replace(/^["']|["']$/g, "") : "";
};
const API = process.env.TENKO_API || "http://localhost:3000";
const COOKIE_NAME = API.startsWith("https") ? "__Secure-authjs.session-token" : "authjs.session-token";
const db = new Client({ connectionString: pick("DATABASE_URL"), ssl: { rejectUnauthorized: false } });

let ok = 0, ng = 0;
const check = (label, cond, detail) => {
  if (cond) { ok++; console.log("  OK   " + label + (detail ? " : " + detail : "")); }
  else { ng++; console.log("  通った " + label + (detail ? " : " + detail : "")); }
};

(async () => {
  await db.connect();
  const uid = Number((await db.query("SELECT id FROM users WHERE display_name='検証 無関係'")).rows[0].id);
  const token = crypto.randomUUID();
  await db.query(
    `INSERT INTO sessions ("userId", expires, "sessionToken") VALUES ($1, now() + interval '1 hour', $2)`,
    [uid, token]);
  const cookie = COOKIE_NAME + "=" + token;
  console.log("対象: " + API + " / 利用者 " + uid + "（検証 無関係）\n");

  const put = async (origin, withCookie = true) => {
    const headers = { "Content-Type": "application/json" };
    if (withCookie) headers.Cookie = cookie;
    if (origin) headers.Origin = origin;
    const r = await fetch(API + "/api/notes", {
      method: "PUT", headers, body: JSON.stringify({ body: "Origin の確認 " + (origin ?? "なし") }),
    });
    return { status: r.status, text: (await r.text()).slice(0, 80) };
  };

  console.log("=== 1. 正しい Origin（＝本番のURL）");
  const a = await put(API);
  check("正しい Origin なら書ける", a.status === 200, "status=" + a.status + " " + a.text);

  console.log("=== 2. 別のオリジンを名乗る");
  for (const o of ["https://evil.example.com", "http://localhost:3000", "https://tenko-eight.vercel.app.evil.com"]) {
    const r = await put(o);
    check("Origin: " + o + " が拒まれる", r.status === 403, "status=" + r.status + " " + r.text);
  }

  console.log("=== 3. Origin を付けない（サーバ同士の通信・curl など）");
  const c = await put(null);
  console.log("  status=" + c.status + " " + c.text);
  console.log("  ※ 設計どおり通る。ブラウザからの書き込みには必ず Origin が付くため、");
  console.log("    ここを塞ぐとサーバ同士の通信が止まる。**Cookie が要ることが別の担保になっている**");

  console.log("=== 4. 未ログインなら、Origin が正しくても書けないか");
  const d = await put(API, false);
  check("Cookie なしでは書けない", d.status === 401, "status=" + d.status + " " + d.text);

  // 後片付け（この確認で書いた note を消す）
  await db.query("DELETE FROM daily_notes WHERE user_id=$1 AND body LIKE 'Origin の確認%'", [uid]);
  await db.query(`DELETE FROM sessions WHERE "sessionToken"=$1`, [token]);
  console.log("\n確認用のセッションと note を削除した");
  console.log("結果: OK " + ok + " 件 / 通ってしまった " + ng + " 件");
  await db.end();
  process.exit(ng === 0 ? 0 : 1);
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
