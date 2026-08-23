// 通話の中継サーバー（TURN）の合言葉を配る（段階4）。
//
// なぜ経路が要るか:
//   直接つながらない相手とは、中継サーバーを通さないと通話が成立しない（調査では会議の22%）。
//   中継サーバーを使うには合言葉（利用者名と鍵）が要る。
//
// **鍵を画面に埋めない。**
//   METERED_TURN_API_KEY は中継の一覧を引き当てる値で、NEXT_PUBLIC_ を付けて画面に配ると
//   ブラウザの中身を見た人に読まれる。そこでサーバー側でだけ使い、
//   引き当てた**一覧だけ**を画面へ渡す。鍵そのものは画面に出ない。
//
// 誰が叩けるか: ログインしている人だけ。未ログインには合言葉を返さない。
//
// **取れなくても通話を止めない。**
//   環境変数が無い・提供元が応答しない・応答の形が違う、のいずれでも
//   { iceServers: [] } を返す。画面は STUN だけで接続を試みる（段階3と同じ動き）。
//   中継が使えないことと、通話を始められないことは別である。
//
// 提供元の仕様（2026-08-20 に公式の資料で確認）。**一覧の取得だけを行う。**
//   GET https://<METERED_DOMAIN>/api/v1/turn/credentials?apiKey=<資格情報ごとのAPIキー>
//   応答は 200 と配列で、各要素が { urls, username?, credential? }
//   https://www.metered.ca/docs/turn-rest-api/get-credential/
//
//   **資格情報を新規に作成しない。** 作成の経路（POST /api/v1/turn/credential）は
//   秘密の鍵を要し、通話のたびに叩くと 403 で失敗していた。
//   資格情報は提供元の管理画面で1件作成済みで、そのAPIキーが環境変数に入っている。
import { NextResponse } from "next/server";
import { currentActor, unauthorized } from "@/lib/actor";

// 応答を保存して使い回さない。要求のたびに提供元へ取りに行く
export const dynamic = "force-dynamic";

/** 提供元への問い合わせの制限時間。待たせ続けるより、STUN だけで始めるほうがよい */
const TIMEOUT_MS = 5_000;

type IceServer = { urls: string; username?: string; credential?: string };

/** 合言葉が無いことを示す応答。処理を落とさず、画面は STUN だけで続ける */
const none = () => NextResponse.json({ iceServers: [] }, { headers: { "Cache-Control": "no-store" } });

export async function GET() {
  const actor = await currentActor();
  if (!actor) return unauthorized();

  const domain = process.env.METERED_DOMAIN;
  const apiKey = process.env.METERED_TURN_API_KEY;

  // 設定が無いときは「合言葉が無い」と答える。落とさない
  if (!domain || !apiKey) {
    console.warn("[turn] METERED_DOMAIN か METERED_TURN_API_KEY が未設定のため、中継は使わない");
    return none();
  }

  try {
    // 中継サーバーの一覧を取得する。**APIキーは画面へ返さない。**
    const res = await fetch(
      `https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" },
    );
    if (!res.ok) {
      // 本文には鍵が含まれうるため、状態の番号だけを記録する
      console.warn("[turn] 中継サーバーの一覧を取れなかった: status " + res.status);
      return none();
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) {
      console.warn("[turn] 応答が配列ではなかった");
      return none();
    }

    // **必要な項目だけを取り出して組み直す。** 受け取った物をそのまま返さない。
    // 提供元が将来ほかの値（口座の情報など）を足しても、画面へは流れない
    const iceServers: IceServer[] = [];
    for (const s of body as Record<string, unknown>[]) {
      const urls = typeof s?.urls === "string" ? s.urls : null;
      if (!urls) continue;
      const username = typeof s?.username === "string" ? s.username : undefined;
      const credential = typeof s?.credential === "string" ? s.credential : undefined;
      iceServers.push(username && credential ? { urls, username, credential } : { urls });
    }

    return NextResponse.json({ iceServers }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // 時間切れ・通信の失敗。理由だけ残し、合言葉は無いものとして返す
    console.warn("[turn] 合言葉を取りに行けなかった: " + (e instanceof Error ? e.name : "unknown"));
    return none();
  }
}
