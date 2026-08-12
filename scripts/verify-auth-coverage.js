/* 認証の抜けを、人の注意力ではなく機械で見つける（Phase 5 段階3）。
   実行: node scripts/verify-auth-coverage.js
   落ちる条件（いずれか1つでも該当したら exit 1）:

     1. src/ に SELECT * / RETURNING * がある
        アダプタが users を select * で引く以上、users に機微な列を足すと漏れる。
        アプリ側は必ず列を明示する

     2. API の経路が currentActor() も allowPublic の印も持っていない
        新しい経路を足したとき、どちらも書かなければここで落ちる

     3. 書き込み（POST/PUT/DELETE/PATCH）の経路が currentActor() を呼んでいない

     4. 画面やAPIが、リクエストから利用者IDを取っている
        （requestedUserId / TENKO_DEV_USER_ID / ?me= / ?user= の読み取り）

   このスクリプトは scripts/ に置き、src/ からは参照しない。 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(process.cwd(), "src");
const API = path.join(SRC, "app", "api");

// 未認証で開放してよい経路。**ここに書かれていないものは閉じているのが既定**。
// 開けるときは、この一覧に足す判断を明示的に行う（設計書4節）
const PUBLIC_ROUTES = [
  "app/api/rooms/route.ts",            // 建物の一覧。村を描くのに要る
  "app/api/users/route.ts",            // 表示名だけ。未ログインにはデモ用の分だけ
  "app/api/notes/route.ts",            // 吹き出し。未ログインにはデモ用の分だけ
  "app/api/demo-presence/route.ts",    // デモ用の利用者の位置。ws-server が引く
  "app/api/auth/[...nextauth]/route.ts", // Auth.js の入口。ここが閉じたらログインできない
];
// 見るだけモードの切り替え（TENKO_PUBLIC_VIEW）を通さなければならない経路。
// Auth.js の入口だけは例外（ここを止めるとログインできなくなる）
const MUST_GUARD = PUBLIC_ROUTES.filter((p) => !p.includes("[...nextauth]"));

const problems = [];
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
  }
})(SRC);

const rel = (p) => path.relative(SRC, p).split(path.sep).join("/");

/* 1) SELECT * の全数検索 */
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((l, i) => {
    if (/\b(select|SELECT)\s+([a-zA-Z_]+\.)?\*/.test(l) || /\b(returning|RETURNING)\s+\*/.test(l)) {
      problems.push("SELECT * がある: src/" + rel(f) + ":" + (i + 1) + "  " + l.trim());
    }
  });
}

/* 2) 3) API の経路 */
const routeFiles = files.filter((f) => rel(f).startsWith("app/api/") && path.basename(f) === "route.ts");
for (const f of routeFiles) {
  const r = rel(f);
  const text = fs.readFileSync(f, "utf8");
  const isPublic = PUBLIC_ROUTES.includes(r);
  const hasActor = /currentActor\s*\(/.test(text);

  if (!isPublic && !hasActor) {
    problems.push("認証も開放の宣言も無い経路: src/" + r);
  }
  // 開放している経路は、見るだけモードの切り替えを必ず通す。
  // 通っていないと TENKO_PUBLIC_VIEW=0 で止まらない経路が残る
  if (MUST_GUARD.includes(r) && !/allowPublic\s*\(/.test(text)) {
    problems.push("開放しているのに allowPublic() を通っていない: src/" + r);
  }
  // 書き込みの経路は、開放されていても currentActor が要る
  const writes = [...text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(POST|PUT|DELETE|PATCH)\b/g)]
    .map((m) => m[1]);
  if (writes.length > 0 && !hasActor) {
    problems.push("書き込みなのに currentActor() が無い: src/" + r + "（" + writes.join("/") + "）");
  }
  // 書き込みの経路は Origin も確かめる（CSRFの2層目）
  if (writes.length > 0 && !/assertSameOrigin\s*\(/.test(text)) {
    problems.push("書き込みなのに assertSameOrigin() が無い: src/" + r + "（" + writes.join("/") + "）");
  }
}

/* 4) リクエストから利用者IDを取っていないか */
const FORBIDDEN = [
  [/requestedUserId/, "requestedUserId は段階3で廃止した"],
  [/TENKO_DEV_USER_ID/, "TENKO_DEV_USER_ID は段階3で廃止した"],
  [/TENKO_TRUST_USER_PARAM/, "TENKO_TRUST_USER_PARAM は段階3で廃止した"],
  [/searchParams\.get\(\s*["']me["']\s*\)/, "URL の ?me= から利用者を決めている"],
  [/searchParams\.get\(\s*["']actor["']\s*\)/, "URL の ?actor= から利用者を決めている"],
  [/\bdevUser\s*\(/, "devUser() は段階3で削除した"],
];
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((l, i) => {
    // コメント行は対象外（「廃止した」と書いた説明で落ちないように）
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;
    for (const [re, why] of FORBIDDEN) {
      if (re.test(l)) problems.push(why + ": src/" + rel(f) + ":" + (i + 1) + "  " + l.trim());
    }
  });
}

console.log("調べたファイル: " + files.length + " 件（うち API の経路 " + routeFiles.length + " 件）");
console.log("未認証で開放している経路（既定は閉じている）:");
for (const p of PUBLIC_ROUTES) console.log("  - src/" + p);
console.log("");

for (const f of routeFiles) {
  const r = rel(f);
  const text = fs.readFileSync(f, "utf8");
  const mark = PUBLIC_ROUTES.includes(r) ? "開放" : (/currentActor\s*\(/.test(text) ? "認証" : "不明");
  console.log("  [" + mark + "] src/" + r);
}
console.log("");

if (problems.length === 0) {
  console.log("問題なし");
  process.exit(0);
}
console.log("問題 " + problems.length + " 件:");
for (const p of problems) console.log("  - " + p);
process.exit(1);
