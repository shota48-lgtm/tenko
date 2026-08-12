/* 作業0の確認: 日が変わってもデモ用の吹き出しが消えないことを実測する。
   実行: node scripts/verify-demo-note-date.js （next dev の起動が必要）

   やり方: システムの時計は動かさず、**DBの daily_notes.note_date を1日前にずらす**。
   これは「今日が明日になった」のと同じ状態である（今日の分が昨日の分になる）。
   確認したら必ず元に戻す。 */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const API = process.env.TENKO_API || "http://localhost:3000";

const notes = async () => {
  const r = await fetch(API + "/api/notes");   // 未認証（＝見るだけの人が見る一覧）
  const j = await r.json();
  return j.notes ?? [];
};

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const demoIds = (await db.query("SELECT id FROM users WHERE is_demo = true")).rows.map((r) => Number(r.id));
  const before = await notes();
  console.log("いまの吹き出し: " + before.length + " 件（うちデモ用 "
    + before.filter((n) => demoIds.includes(Number(n.user_id))).length + " 件）");

  // 日付をずらすときは2段で動かす。
  // 1文で全行を1日動かすと、途中の行が別の行と同じ (user_id, note_date) になり、
  // 一意制約 daily_notes_user_date_uq に当たる（実際に当たった）。
  // いったん遠い未来へ逃がしてから戻せば、途中で重ならない
  const shift = async (days) => {
    await db.query(`UPDATE daily_notes SET note_date = note_date + INTERVAL '1000 days'`);
    await db.query(`UPDATE daily_notes SET note_date = note_date - INTERVAL '${1000 - days} days'`);
  };

  console.log("\n=== 日が変わった状態を作る（daily_notes.note_date を1日前にずらす）===");
  await shift(-1);
  console.log("ずらした（全行を1日前へ）");

  const after = await notes();
  const demoAfter = after.filter((n) => demoIds.includes(Number(n.user_id)));
  console.log("日が変わったあとの吹き出し: " + after.length + " 件（うちデモ用 " + demoAfter.length + " 件）");
  console.log("  例: " + demoAfter.slice(0, 3).map((n) => n.user_id + ":" + n.body).join(" / "));

  console.log("\n=== 日付を元に戻す ===");
  await shift(1);
  const d = (await db.query(
    `SELECT max(note_date)::text mx, (now() AT TIME ZONE 'Asia/Tokyo')::date::text today FROM daily_notes`)).rows[0];
  console.log("戻した。daily_notes の最新日付=" + d.mx + " / 今日=" + d.today
            + "（一致: " + (d.mx === d.today) + "）");
  const restored = await notes();
  console.log("戻したあとの吹き出し: " + restored.length + " 件");

  const ok = demoAfter.length === before.filter((n) => demoIds.includes(Number(n.user_id))).length
          && demoAfter.length > 0;
  console.log("\n判定: デモ用の吹き出しは日が変わっても " + (ok ? "消えない（OK）" : "消えた（NG）"));
  await db.end();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
