// 通話の中継サーバー（TURN）の使い捨ての合言葉を配る（段階4）。
//
// なぜ経路が要るか:
//   直接つながらない相手とは、中継サーバーを通さないと通話が成立しない（調査では会議の22%）。
//   中継サーバーを使うには合言葉（利用者名と鍵）が要る。
//
// **鍵を画面に埋めない。**
//   METERED_SECRET_KEY は提供元の口座そのものを開ける値で、漏れれば誰でも中継を使える。
//   NEXT_PUBLIC_ を付けて画面に配ると、ブラウザの中身を見た人に読まれる。
//   そこでサーバー側でだけ使い、ここで**期限つきの合言葉に引き換えてから**画面へ渡す。
//   引き換えた合言葉は期限が切れる。鍵そのものは画面に出ない。
//
// 誰が叩けるか: ログインしている人だけ。未ログインには合言葉を返さない。
//
// **取れなくても通話を止めない。**
//   環境変数が無い・提供元が応答しない・応答の形が違う、のいずれでも
//   { iceServers: [] } を返す。画面は STUN だけで接続を試みる（段階3と同じ動き）。
//   中継が使えないことと、通話を始められないことは別である。
//
// 提供元の仕様（2026-08-20 に公式の資料で確認）。**2段構えである点に注意。**
//   1) 期限つきの合言葉を作る（秘密の鍵を使う。サーバー側だけ）
//      POST https://<METERED_DOMAIN>/api/v1/turn/credential?secretKey=<秘密の鍵>
//      body { expiryInSeconds, label } → { username, password, expiryInSeconds, label, apiKey }
//      https://www.metered.ca/docs/turnserver-guides/expiring-turn-credentials/
//   2) その apiKey で、中継サーバーの一覧に引き換える
//      GET https://<METERED_DOMAIN>/api/v1/turn/credentials?apiKey=<1で得た apiKey>
//      応答は配列で、各要素が { urls, username?, credential? }
//      https://www.metered.ca/docs/turn-rest-api/get-credential/
//
//   **秘密の鍵と apiKey は、どちらも画面へ返さない。** 画面へ渡すのは 2) の一覧だけで、
//   その中に入っているのは期限つきの利用者名と鍵である。
import { NextResponse } from "next/server";
import { currentActor, unauthorized } from "@/lib/actor";

// 応答を保存して使い回さない。要求のたびに提供元へ取りに行く
export const dynamic = "force-dynamic";

/** 提供元への問い合わせの制限時間。待たせ続けるより、STUN だけで始めるほうがよい */
const TIMEOUT_MS = 5_000;
/** 合言葉の寿命。通話1回に足りればよく、長く持たせる理由がない */
const EXPIRY_SEC = 3600;

type IceServer = { urls: string; username?: string; credential?: string };

/** 合言葉が無いことを示す応答。処理を落とさず、画面は STUN だけで続ける */
const none = () => NextResponse.json({ iceServers: [] }, { headers: { "Cache-Control": "no-store" } });

export async function GET() {
  const actor = await currentActor();
  if (!actor) return unauthorized();

  const domain = process.env.METERED_DOMAIN;
  const key = process.env.METERED_SECRET_KEY;

  // 設定が無いときは「合言葉が無い」と答える。落とさない
  if (!domain || !key) {
    console.warn("[turn] METERED_DOMAIN か METERED_SECRET_KEY が未設定のため、中継は使わない");
    return none();
  }

  try {
    // 1) 期限つきの合言葉を作る。**秘密の鍵を使うのはこの1回だけで、応答にも載せない。**
    //    label は提供元の画面で見分けるための印。利用者IDだけにし、名前やアドレスは入れない
    const made = await fetch(
      `https://${domain}/api/v1/turn/credential?secretKey=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiryInSeconds: EXPIRY_SEC, label: "tenko-" + actor.id }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      },
    );
    if (!made.ok) {
      // 本文には鍵が含まれうるため、状態の番号だけを記録する
      console.warn("[turn] 合言葉を作れなかった: status " + made.status);
      return none();
    }
    const cred: unknown = await made.json();
    const apiKey = typeof (cred as { apiKey?: unknown })?.apiKey === "string"
      ? (cred as { apiKey: string }).apiKey : null;
    if (!apiKey) {
      console.warn("[turn] 作った合言葉に apiKey が無かった");
      return none();
    }

    // 2) その apiKey を、中継サーバーの一覧に引き換える。**apiKey も画面へ返さない。**
    const res = await fetch(
      `https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" },
    );
    if (!res.ok) {
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
