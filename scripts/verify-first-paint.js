/* 修正1の検証: `/` を開いた直後の HTML に、建物の情報が含まれているかを確かめる。
   サーバー側で部屋を読んで渡す形にしたので、最初のHTMLに部屋名が入っているはず。
   画面側の fetch を待つ形だと、ここには入らない。
   実行: node scripts\verify-first-paint.js [回数] */
const API = "http://localhost:3000";
const N = Number(process.argv[2] || 5);

(async () => {
  const rooms = (await (await fetch(API + "/api/rooms")).json()).rooms;
  console.log("部屋: " + rooms.map((r) => r.name + "(" + r.deco + ")").join(", "));
  console.log("");

  for (let i = 1; i <= N; i++) {
    const t0 = Date.now();
    const res = await fetch(API + "/?me=1", { cache: "no-store" });
    const html = await res.text();
    const ms = Date.now() - t0;
    // 最初のHTMLに部屋名がいくつ含まれているか
    const hit = rooms.filter((r) => html.includes(r.name)).length;
    console.log(
      `${i} 回目: status=${res.status} ${ms}ms / 最初のHTMLに含まれる部屋 ${hit}/${rooms.length}` +
      (hit === rooms.length ? " OK" : " 不足"),
    );
  }
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
