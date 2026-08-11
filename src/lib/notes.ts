// 「今日やること」。
//
// 設計方針（崩さないこと）:
//   - 履歴を残さない。1人1日1行を上書きする。履歴を持つとタスク管理ツールの領域に入る
//   - 日付はサーバーが決める。クライアントから受け取らない（時計をずらせば任意の日として振る舞えるため）
//   - 他人が書いた文字列が自分の画面に出る唯一の経路。入力の検証はサーバー側で行う
import { pool } from "@/lib/db";

export const NOTE_MAX = 80;
export const TENKO_TZ = process.env.TENKO_TZ ?? "Asia/Tokyo";

export type Note = { user_id: number; body: string; updated_at: string };

export type SanitizeResult =
  | { ok: true; body: string }
  | { ok: false; reason: string };

// 除く文字の判定。正規表現に制御文字を直接書くと、ソース上で見えず事故になるため
// コードポイントで判定する。
//   0x00-0x1F, 0x7F-0x9F : C0 / C1 制御。改行・タブもここに含まれる
//   0x200B-0x200F        : ゼロ幅・方向指示
//   0x202A-0x202E        : 双方向制御。RLO で表示順を偽装できる
//   0x2066-0x2069        : 分離指示
//   0xFEFF               : BOM
function classify(cp: number): "keep" | "space" | "drop" {
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return "space";   // 改行・タブは空白に寄せる
  // 0x200D(ZWJ) は絵文字の合字に必要なので残す。
  // 除くと「👨‍👩‍👧‍👦」が4つの絵文字に割れる（審査役Aの実測で発見）
  if (cp === 0x200d) return "keep";
  if (cp === 0xfe0f || cp === 0xfe0e) return "keep";             // 異体字セレクタ（絵文字の表示指定）
  if (cp >= 0x200b && cp <= 0x200f) return "drop";
  if (cp >= 0x202a && cp <= 0x202e) return "drop";
  if (cp >= 0x2066 && cp <= 0x2069) return "drop";
  if (cp === 0xfeff) return "drop";
  return "keep";
}

// 入力の正規化と検証。
// HTML として解釈させない責務は表示側（React のテキスト / Canvas の fillText）にある。
// ここで < > を取り除くと「1 < 2」のような正当な入力が壊れるため、除去も変換もしない。
// ここで見るのは「制御文字」と「長さ」だけ。
// max は上限の文字数。既定は「今日やること」の80文字。
// お知らせ（200文字）でも同じ検証を使うため、上限だけを外から渡せるようにしてある
export function sanitizeNote(input: unknown, max: number = NOTE_MAX): SanitizeResult {
  if (typeof input !== "string") return { ok: false, reason: "本文は文字列で必要です" };

  // 全角と半角で数え方が変わらないよう NFC に寄せる
  const normalized = input.normalize("NFC");

  let s = "";
  for (const ch of normalized) {
    const kind = classify(ch.codePointAt(0) ?? 0);
    if (kind === "keep") s += ch;
    else if (kind === "space") s += " ";
  }

  // 連続する空白を1つにまとめ、前後を落とす
  s = s.replace(/\s+/g, " ").trim();

  if (s.length === 0) return { ok: false, reason: "本文が空です" };
  // 長さはコードポイント数で数える。絵文字を2文字と数えて弾かないため
  const len = Array.from(s).length;
  if (len > max) return { ok: false, reason: `本文は ${max} 文字までです（${len} 文字）` };

  return { ok: true, body: s };
}

// 今日の分を上書きする。日付はサーバーが決める
export async function upsertTodayNote(userId: number, body: string) {
  const { rows } = await pool.query(
    `INSERT INTO daily_notes (user_id, note_date, body)
     VALUES ($1, (now() AT TIME ZONE $2)::date, $3)
     ON CONFLICT (user_id, note_date)
     DO UPDATE SET body = EXCLUDED.body, updated_at = now()
     RETURNING user_id, body, updated_at, note_date::text AS note_date`,
    [userId, TENKO_TZ, body],
  );
  return rows[0];
}

export async function deleteTodayNote(userId: number) {
  const { rowCount } = await pool.query(
    `DELETE FROM daily_notes WHERE user_id = $1 AND note_date = (now() AT TIME ZONE $2)::date`,
    [userId, TENKO_TZ],
  );
  return rowCount ?? 0;
}

// 村に出す一覧。今日の分だけを返すため、日付が変われば自然に空になる
export async function listTodayNotes(): Promise<Note[]> {
  const { rows } = await pool.query(
    `SELECT n.user_id, n.body, n.updated_at
       FROM daily_notes n
       JOIN users u ON u.id = n.user_id AND u.deleted_at IS NULL
      WHERE n.note_date = (now() AT TIME ZONE $1)::date
      ORDER BY n.user_id`,
    [TENKO_TZ],
  );
  return rows.map((r) => ({ user_id: Number(r.user_id), body: r.body, updated_at: r.updated_at }));
}

export async function getTodayNote(userId: number): Promise<Note | null> {
  const { rows } = await pool.query(
    `SELECT user_id, body, updated_at FROM daily_notes
      WHERE user_id = $1 AND note_date = (now() AT TIME ZONE $2)::date`,
    [userId, TENKO_TZ],
  );
  if (rows.length === 0) return null;
  return { user_id: Number(rows[0].user_id), body: rows[0].body, updated_at: rows[0].updated_at };
}
