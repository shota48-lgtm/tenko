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

/**
 * 自分のアバターを動かす（Phase 4.8）。
 * 利用者IDを持たないことが重要。動かせるのは「この接続の人」だけで、
 * サーバーは接続に紐づいた人にしか適用しない。よって他人のアバターは動かせない。
 */
export type PresenceMove = {
  type: "presence.move";
  x: number;
  y: number;
  /** 指を離した1件。これが付いたときだけ、サーバーが人の重なりを避けてずらす */
  final?: boolean;
};

/** 呼びかけ。通話は繋がない（次のフェーズ）。from は送らない（サーバーが接続から決める） */
export type CallInvite = { type: "call.invite"; to: number; knewFocus?: boolean };
export type CallRespond = { type: "call.respond"; to: number; answer: "accept" | "later" | "decline" };

/**
 * 音声通話のシグナリング（段階1）。呼びかけ→承認のあとに使う。
 *
 * 宛先の表し方は call.invite / call.respond と同じ `to: number`（利用者ID）にする。
 * **発信元は書かない。** サーバーが接続から決めるため、書いてもなりすませない
 * （ws-server は msg の利用者IDを読まない）。
 *
 * 中身（sdp / candidate）は**運ぶだけ**で、型でも解釈も検証もしない。
 * 解釈すると、ブラウザの実装が変わるたびにサーバー側を直すことになる。
 * ws-server も同じ方針で、宛先を見て転送するだけ（中身を見ない）。
 */
export type CallOffer = { type: "call.offer"; to: number; sdp: string };
export type CallAnswer = { type: "call.answer"; to: number; sdp: string };
/** 追加の経路の候補。RTCIceCandidate をそのまま載せるため、形は決めない */
export type CallCandidate = { type: "call.candidate"; to: number; candidate: unknown };
/**
 * 通話の終了。
 * 109行以降の設計メモには無い種別で、CANON（段階1）の指示で足した。
 * 終わりを伝える相手が要るため、他の3種と同じく宛先 to を持つ
 */
export type CallHangup = { type: "call.hangup"; to: number };

/**
 * 呼びかけに応答したことを、**自分の他の端末に**知らせる（段階2）。
 *
 * 呼びかけは相手の全端末に届くため、1台で応答しても他の端末には出たままになる。
 * call.respond は呼びかけた側にしか返らないので、これを別に送る。
 *
 * **宛先 to を持たない。** 配る先は「この接続の人の、他の接続」に固定する。
 * 宛先を受け取ると、他人の端末の表示を消せることになるため（ws-server 側も to を読まない）。
 */
export type CallHandled = { type: "call.handled"; answer: "accept" | "later" | "decline" };

export type ClientToServer =
  | PresenceSet | PresenceSync | PresenceMove | CallInvite | CallRespond
  | CallOffer | CallAnswer | CallCandidate | CallHangup | CallHandled;

// ---- サーバー -> 画面 ----

/** 在席の全体。差分ではなく毎回すべてを配る（切断中の変更を取りこぼしても追いつけるため） */
export type PresenceList = {
  type: "presence.list";
  users: Array<{
    id: number;
    // 名前は含めない。画面はDBの表示名で引く（自己申告の名前を他人の画面に出さないため）
    colorIndex: number;
    state: PresenceState;
    roomId: number | null;
    talk?: TalkStatus;
    connections?: number;
    // 村の中の位置（Phase 4.8）。決めるのはサーバー
    x?: number;
    y?: number;
  }>;
  /** 部屋ごとの人数と定員。満員かどうかを画面に出すために配る */
  rooms?: Record<number, { used: number; capacity: number }>;
};

/** 移動や呼びかけを断った理由。押した本人にだけ返す */
export type PresenceDenied = { type: "presence.denied"; reason: string; roomId?: number };
export type CallDenied = { type: "call.denied"; reason: string };
export type CallSent = { type: "call.sent"; to: number };

/**
 * 呼びかけが届いた。from はサーバーが接続から決めるため、なりすませない。
 * 名前は含めない。presence の name は自己申告で騙れるため、画面はDBの表示名で引き直す
 */
export type CallIncoming = {
  type: "call.incoming";
  from: { id: number };
  knewFocus?: boolean;
};
export type CallAnswered = {
  type: "call.answered";
  from: { id: number };
  answer: "accept" | "later" | "decline";
};

/** 投稿が保存されたことの通知。保存は HTTP + DB が正で、これは知らせるだけ */
export type MessageCreated = {
  type: "message.created";
  message: { id: number | string; room_id: number | string; body: string; user_id: number | string };
};

/**
 * シグナリングを相手へ届けたもの（段階1）。
 *
 * 種別の文字列は送るときと同じにし、宛先 `to` の代わりに発信元 `from` が入る。
 * 呼びかけが call.invite → call.incoming と名前を変えるのに対し、こちらは名前を変えない。
 * ブラウザ側の処理（offer を受けたら answer を返す）が、送った種別と受けた種別を
 * 同じ名前で扱えるほうが追いやすいため。
 * from はサーバーが接続から決める。名前は載せない（画面はDBの表示名で引く。既存と同じ）
 */
export type CallOfferRelayed = { type: "call.offer"; from: { id: number }; sdp: string };
export type CallAnswerRelayed = { type: "call.answer"; from: { id: number }; sdp: string };
export type CallCandidateRelayed = { type: "call.candidate"; from: { id: number }; candidate: unknown };
export type CallHangupRelayed = { type: "call.hangup"; from: { id: number } };
/** 自分の別の端末が応答した。受けた端末は呼びかけの表示を閉じる（段階2-D） */
export type CallHandledRelayed = {
  type: "call.handled";
  from: { id: number };
  answer: "accept" | "later" | "decline";
};

export type ServerToClient =
  | PresenceList | MessageCreated
  | PresenceDenied | CallIncoming | CallAnswered | CallDenied | CallSent
  | CallOfferRelayed | CallAnswerRelayed | CallCandidateRelayed | CallHangupRelayed | CallHandledRelayed;

// ---- 送り手の役割 ----
//
// notifier: Next.js の API ルート。token を持つ接続だけが名乗れる。配信できるのはこの役だけ
// viewer  : 画面。送れるのは下の VIEWER_ALLOWED にある種別だけで、それ以外は捨てられる
// ws-server 側は前方一致で見るため、"call." で名前空間ごと許可している
export const VIEWER_ALLOWED: ReadonlyArray<string> = [
  "presence.set", "presence.sync", "presence.move", "call.",
];

// ---- 音声通話の進み具合 ----
//
// 7段階に分けたうちの、どこまでが入っているかを書く。**ここは実装に合わせて直すこと。**
// （段階1まではこの位置に「実装しない」という設計メモがあったが、実装したため書き換えた）
//
// 通話の入り方は「近づくと聞こえる」ではなく「呼びかけ → 相手が承認 → 通話開始」に決めた（POの判断）。
// 近接音声は、常に聞かれているかもしれない状態を作り、心理的安全性を損なうため採用しない。
// call.invite / call.respond（承認のやりとり）は Phase 4.8 で実装済み。
//
// 済 段階1: シグナリングの種別と転送（call.offer / call.answer / call.candidate / call.hangup）
//      型は上に定義済み。ws-server は宛先を見て転送するだけで、中身（sdp）は解釈しない。
//      P2Pメッシュを想定している（6人程度までなら SFU は不要）。
// 済 段階2: 通話の状態と表示（通話中かどうか・相手・切る操作・他の端末の呼びかけを閉じる）
//      開始のきっかけは call.respond の answer==="accept"。
//      **承認した側（callee）が offer を作る**形にすれば、呼びかけた側は待つだけで済む。
//      画面側は role（caller / callee）を持っているので、段階3はそれを見て分岐すればよい。
//      call.handled は段階2で足した（自分の他の端末に応答済みを配る）。
// 未 段階3: 音声そのもの（RTCPeerConnection・マイク・offer/answer の作成）
// 未 段階4: TURN の資格情報を配る経路
// 未 段階5: 繋がらなかったときの扱い
// 未 段階6: 停止と再接続への対応
// 未 段階7: 検証
//
// VIEWER_ALLOWED は "call." で名前空間ごと許可済みのため、種別を足しても変更は不要。
//
// 4) メディアは Vercel も Railway も通らない（P2P）。TURN が要る場合のみ外部（Cloudflare 等）を使う。
//    シグナリングは TCP なので、今の WebSocket サーバーにそのまま相乗りできる。
