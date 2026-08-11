/* 検証で作った messages を整理する。
   引数 --apply を付けたときだけ削除する。付けなければ対象を並べるだけ。

   残すもの:
     - 下書き(attendance_drafts)から参照されている発言。消すと根拠が失われる
     - 検証用でない発言
   消すもの:
     - 検証スクリプトが使った client_msg_id の発言のうち、どの下書きからも参照されていないもの */
const fs = require("fs");
const { Client } = require("pg");
const line = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const url = line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
const APPLY = process.argv.includes("--apply");

/* 検証で使った client_msg_id は、いずれも同じ文字の並びで始まる作りにしてある */
const TEST_PREFIXES = ["11111111-", "22222222-", "33333333-", "44444444-", "aaaaaaaa-", "bbbbbbbb-"];

(async () => {
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const all = (await db.query(
    `SELECT m.id, m.client_msg_id::text AS cid, m.body, m.deleted_at IS NOT NULL AS deleted,
            (SELECT count(*)::int FROM attendance_drafts d WHERE d.message_id = m.id) AS draft_count
       FROM messages m ORDER BY m.id`)).rows;

  const isTest = (cid) => TEST_PREFIXES.some((p) => cid.startsWith(p));
  const target = all.filter((m) => isTest(m.cid) && m.draft_count === 0);
  const keepReferenced = all.filter((m) => m.draft_count > 0);
  const keepOther = all.filter((m) => !isTest(m.cid) && m.draft_count === 0);

  console.log("messages 全体: " + all.length + " 件");
  console.log("");
  console.log("残す（下書きから参照されている）: " + keepReferenced.length + " 件");
  for (const m of keepReferenced) console.log("  id=" + m.id + " 下書き" + m.draft_count + "件 「" + m.body + "」");
  console.log("");
  console.log("残す（検証用ではない）: " + keepOther.length + " 件");
  for (const m of keepOther) console.log("  id=" + m.id + " 「" + m.body + "」");
  console.log("");
  console.log("消す（検証用・参照なし）: " + target.length + " 件");
  for (const m of target) console.log("  id=" + m.id + " 「" + m.body + "」" + (m.deleted ? "（論理削除済み）" : ""));

  if (!APPLY) {
    console.log("");
    console.log("--apply を付けて実行すると上記を削除する。今回は削除していない。");
    await db.end();
    return;
  }

  const ids = target.map((m) => Number(m.id));
  if (ids.length > 0) {
    const r = await db.query("DELETE FROM messages WHERE id = ANY($1::bigint[])", [ids]);
    console.log("");
    console.log("削除した件数: " + r.rowCount);
  }

  const after = (await db.query("SELECT count(*)::int AS n FROM messages")).rows[0].n;
  const drafts = (await db.query("SELECT id, kind, status, message_id FROM attendance_drafts ORDER BY id")).rows;
  console.log("整理後の messages: " + after + " 件");
  console.log("整理後の attendance_drafts: " + JSON.stringify(drafts));

  /* 既読の位置が、消えた発言の id を指したまま残っていないかを確認する */
  const rs = (await db.query(
    `SELECT r.room_id, r.user_id, r.last_read_message_id,
            (SELECT max(id) FROM messages WHERE room_id = r.room_id) AS max_id
       FROM read_states r`)).rows;
  console.log("既読の位置: " + (rs.length ? JSON.stringify(rs) : "（行なし）"));

  await db.end();
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
