/* 破壊試験（回帰）: DB側の凍結が効いていることを確かめる。
   認証とは独立した保証で、Phase 3・4 で入れたトリガーが生きているかを見る。
   実行: node scripts/verify-freeze.js
     - 承認済みの勤怠記録は変更・削除できない
     - 確定・却下済みの下書きは変更・削除できない
   いずれも「例外が出ること」が期待される結果。読み取りと失敗する更新しかしない */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");

let ng = 0;
async function mustFail(db, label, sql, params) {
  try {
    const r = await db.query(sql, params);
    console.log("  通った " + label + "（rowCount=" + r.rowCount + "）");
    ng++;
  } catch (e) {
    console.log("  OK   " + label + " -> 例外: " + e.message.split("\n")[0]);
  }
}

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const rec = (await db.query(
    "SELECT id FROM attendance_records WHERE status='approved' ORDER BY id LIMIT 1")).rows[0];
  const draft = (await db.query(
    "SELECT id FROM attendance_drafts WHERE status <> 'pending' ORDER BY id LIMIT 1")).rows[0];

  console.log("=== 承認済みの勤怠記録（id=" + (rec ? rec.id : "なし") + "）");
  if (rec) {
    // 1件ずつ別のトランザクションで試す。失敗しても他に影響しない
    await mustFail(db, "UPDATE で時刻を書き換える", "UPDATE attendance_records SET event_at = now() WHERE id=$1", [rec.id]);
    await mustFail(db, "UPDATE で状態を戻す", "UPDATE attendance_records SET status='submitted' WHERE id=$1", [rec.id]);
    await mustFail(db, "DELETE で消す", "DELETE FROM attendance_records WHERE id=$1", [rec.id]);
  } else { console.log("  (skip) 承認済みの記録が無い"); }

  console.log("=== 確定・却下済みの下書き（id=" + (draft ? draft.id : "なし") + "）");
  if (draft) {
    await mustFail(db, "UPDATE で状態を戻す", "UPDATE attendance_drafts SET status='pending' WHERE id=$1", [draft.id]);
    await mustFail(db, "UPDATE で本文を書き換える", "UPDATE attendance_drafts SET matched_text='書き換え' WHERE id=$1", [draft.id]);
    await mustFail(db, "DELETE で消す", "DELETE FROM attendance_drafts WHERE id=$1", [draft.id]);
  } else { console.log("  (skip) 確定・却下済みの下書きが無い"); }

  // 行が残っていることを確かめる（DELETE が黙って無視されていないか。J224）
  if (rec) {
    const n = (await db.query("SELECT count(*)::int n FROM attendance_records WHERE id=$1", [rec.id])).rows[0].n;
    console.log("=== 記録 id=" + rec.id + " は残っているか: " + (n === 1 ? "残っている" : "消えている（異常）"));
    if (n !== 1) ng++;
  }
  if (draft) {
    const n = (await db.query("SELECT count(*)::int n FROM attendance_drafts WHERE id=$1", [draft.id])).rows[0].n;
    console.log("=== 下書き id=" + draft.id + " は残っているか: " + (n === 1 ? "残っている" : "消えている（異常）"));
    if (n !== 1) ng++;
  }

  console.log("\n通ってしまった: " + ng + " 件");
  await db.end();
  process.exit(ng === 0 ? 0 : 1);
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
