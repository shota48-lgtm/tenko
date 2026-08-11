// WebSocket で流れるメッセージの型。
//
// 現状の全種別をここに集約する。文字列リテラルを各所に散らさないための場所であり、
// 「今どんな種別が流れているか」を1か所で見られるようにするのが目的。
//
// 種別の名前は「名前空間.動作」の形にする（presence.set など）。
// 名前空間で分けておくと、後から別の用途（通話のシグナリングなど）を足しても、
// 既存の通知と混ざらず、受け入れ側の判定も名前空間単位で書ける。
//
// ws-server は素の Node.js（JS）のため、この型定義を直接は参照できない。
// 種別の一覧は ws-server/index.js の VIEWER_ALLOWED と対応させること。

export type TalkStatus = "ok" | "later" | "focus";
export type PresenceState = "idle" | "away" | "talking" | "resting";

// ---- 画面 -> サーバー ----

/** 自分の在席状態を申告する。state:"off" は村から消える */
export type PresenceSet = {
  type: "presence.set";
  user: { id: number; name: string; colorIndex: number };
  state: PresenceState | "off";
  roomId?: number | null;
  talk?: TalkStatus;
};

/** 今の在席一覧をもう一度送ってほしい（再接続の直後に使う） */
export type PresenceSync = { type: "presence.sync" };

export type ClientToServer = PresenceSet | PresenceSync;

// ---- サーバー -> 画面 ----

/** 在席の全体。差分ではなく毎回すべてを配る（切断中の変更を取りこぼしても追いつけるため） */
export type PresenceList = {
  type: "presence.list";
  users: Array<{
    id: number;
    name: string;
    colorIndex: number;
    state: PresenceState;
    roomId: number | null;
    talk?: TalkStatus;
    connections?: number;
  }>;
};

/** 投稿が保存されたことの通知。保存は HTTP + DB が正で、これは知らせるだけ */
export type MessageCreated = {
  type: "message.created";
  message: { id: number | string; room_id: number | string; body: string; user_id: number | string };
};

export type ServerToClient = PresenceList | MessageCreated;

// ---- 送り手の役割 ----
//
// notifier: Next.js の API ルート。token を持つ接続だけが名乗れる。配信できるのはこの役だけ
// viewer  : 画面。送れるのは下の VIEWER_ALLOWED にある種別だけで、それ以外は捨てられる
export const VIEWER_ALLOWED: ReadonlyArray<ClientToServer["type"]> = ["presence.set", "presence.sync"];

// ---- 将来 音声通話を足すときにここへ追加する ----
//
// 実装しない。何をどこに足せばよいかだけを残す。
//
// 1) 種別を3つ足す（P2Pメッシュのシグナリング。6人程度までなら SFU は不要）
//      call.offer     { type, to: userId, sdp }
//      call.answer    { type, to: userId, sdp }
//      call.candidate { type, to: userId, candidate }
//    いずれも「特定の相手に届ける」必要があるため、宛先 to を持つ。
//
// 2) ws-server に「宛先つきの転送」を足す。
//    今の broadcast は全員に配るため、シグナリングには使えない。
//    presence の Map は ws -> 利用者 の向きなので、利用者ID -> ws の索引を1つ足すことになる。
//
// 3) VIEWER_ALLOWED に call.* を加える。
//    受け入れの判定は名前空間単位（"call." で始まるか）で書けるようにしてあるため、
//    ws-server 側の変更は許可リストへの追加だけで済む。
//
// 4) メディアは Vercel も Railway も通らない（P2P）。TURN が要る場合のみ外部（Cloudflare 等）を使う。
//    シグナリングは TCP なので、今の WebSocket サーバーにそのまま相乗りできる。
