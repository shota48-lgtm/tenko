// 音声そのものを繋ぐ処理（段階3）。
//
// ここに置く理由:
//   画面（village-client.tsx）は既に1600行を超えている。接続の手順（offer / answer / 候補）を
//   そこへ直接書くと、村の描画・在席・呼びかけと混ざって追えなくなる。
//   このファイルは **DOM に触れない**。音を鳴らすのは画面側の仕事にしてある
//   （ここが返すのは MediaStream まで）。
//
// 設計方針（崩さないこと）:
//   - **音声は ws-server を通らない。** ブラウザ同士が直接やり取りする（P2P）。
//     ws-server が運ぶのは、繋ぐための情報（sdp と経路の候補）だけ
//   - **中身を作るのも解釈するのもブラウザ。** sdp を自分で組み立てたり書き換えたりしない
//   - どちらが先に接続情報（offer）を作るかは、ws-messages.ts の設計メモに従い
//     「**承認した側（callee）**」に固定する。両方が同時に作ると衝突する
//   - 段階3では STUN だけを使う。TURN は段階4。
//     したがって対称型NAT の内側にいる相手とは繋がらないことがある（調査で22%と実測報告あり）
//
// 段階5（繋がらなかったときの扱い）でここに手を入れる想定:
//   マイクが取れない・ICE が失敗した、を画面へ伝える経路はまだ作っていない。
//   いまは console に出すだけで、画面には出さない（CANON 段階3-C の指示）。

/**
 * STUN サーバー。無料で、登録もカード登録も要らないものを使う。
 *
 * Cloudflare の記述: "Cloudflare's STUN service at `stun.cloudflare.com` is free and unlimited."
 *   https://developers.cloudflare.com/realtime/turn/faq/
 * ポートは同社の一覧より 3478/udp。
 *   https://developers.cloudflare.com/realtime/turn/
 *
 * **TURN はここに書かない（段階4）。** 書くと資格情報を画面に埋めることになる。
 */
export const STUN_URLS = ["stun:stun.cloudflare.com:3478"];

/** 相手へ送る合図。中身は運ぶだけで、ws-server も解釈しない（段階1） */
export type SignalSender = (msg:
  | { type: "call.offer"; to: number; sdp: string }
  | { type: "call.answer"; to: number; sdp: string }
  | { type: "call.candidate"; to: number; candidate: unknown }
) => void;

export type VoiceCall = {
  peerId: number;
  /** 相手からの接続情報を受けた（呼びかけた側で起きる） */
  handleOffer(sdp: string): Promise<void>;
  /** 返事の接続情報を受けた（承認した側で起きる） */
  handleAnswer(sdp: string): Promise<void>;
  /** 追加の経路の候補を受けた */
  addCandidate(candidate: unknown): Promise<void>;
  /**
   * 自分の音声の送信を一時的に止める / 戻す。
   *
   * **止めるのは enabled であって stop ではない。**
   * stop を呼ぶとトラックが終わり、戻すときにマイクを取り直すことになる
   * （許可を求め直す形になり、通話中に断られると復帰できない）。
   * enabled = false の間は無音が送られる。
   * ブラウザのタブのマイクの印は出たままになる（掴んだままであるため。これは仕様）。
   */
  setMuted(muted: boolean): void;
  /** いまミュートしているか */
  isMuted(): boolean;
  /** 通話を終える。**マイクを必ず止める**（止めないとタブの印が残り続ける） */
  close(): void;
  /** いまマイクを掴んでいるか（試験と自己点検のために外から見えるようにしておく） */
  micActive(): boolean;
};

/**
 * 通話を始める。**この関数の中でしかマイクを取らない。**
 * 呼ぶのは、通話の状態が立った瞬間だけ（village-client.tsx）。
 *
 * 許可が下りなければ例外を投げる。段階3では呼んだ側が握りつぶしてログに出す。
 */
export async function startVoice(opts: {
  peerId: number;
  role: "caller" | "callee";
  send: SignalSender;
  onRemoteStream: (stream: MediaStream) => void;
  onState?: (state: RTCPeerConnectionState) => void;
  /**
   * 中継サーバー（TURN）の設定（段階4）。
   * 使い捨ての合言葉つきで /api/turn-credentials から受け取ったものを、そのまま渡す。
   * **渡されなければ段階3と同じく STUN だけで動く。** 中継が使えないことは、
   * 通話を始められないことではない（直接つながる相手とは繋がる）
   */
  iceServers?: RTCIceServer[];
}): Promise<VoiceCall> {
  const { peerId, role, send, onRemoteStream, onState } = opts;

  // 音声だけ。映像は取らない（取ると許可の求め方が変わり、通信量も跳ね上がる）
  const local = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

  // STUN は必ず入れる。中継の設定は、あれば後ろに足す。
  // **STUN_URLS の値は変えない**（段階3で確かめた、無料・無登録のもの）
  const iceServers: RTCIceServer[] = [{ urls: STUN_URLS }, ...(opts.iceServers ?? [])];
  console.log("[voice] 中継サーバーの設定: " + ((opts.iceServers?.length ?? 0) > 0 ? "あり" : "無し（STUNのみ）"));

  const pc = new RTCPeerConnection({ iceServers });
  for (const track of local.getTracks()) pc.addTrack(track, local);

  // 相手の接続情報が入る前に届いた候補は、ここに溜めてから入れる。
  // 先に入れると InvalidStateError になり、その候補は捨てられる（経路が1つ減る）
  const pending: RTCIceCandidateInit[] = [];
  let remoteSet = false;
  let closed = false;

  const drain = async () => {
    while (pending.length > 0) {
      const c = pending.shift()!;
      try { await pc.addIceCandidate(c); } catch (e) { console.warn("[voice] 候補を入れられなかった", e); }
    }
  };

  pc.onicecandidate = (e) => {
    if (closed || !e.candidate) return;
    // toJSON で素の値にしてから送る。クラスのまま JSON にすると中身が落ちる
    send({ type: "call.candidate", to: peerId, candidate: e.candidate.toJSON() });
  };
  pc.ontrack = (e) => {
    if (closed) return;
    const stream = e.streams[0] ?? new MediaStream([e.track]);
    onRemoteStream(stream);
  };
  pc.onconnectionstatechange = () => {
    console.log("[voice] 接続の状態: " + pc.connectionState);
    onState?.(pc.connectionState);
  };

  // **承認した側が先に接続情報を作る**（ws-messages.ts の設計メモ 2 のとおり）。
  // 呼びかけた側は待つだけでよく、両方が同時に作って衝突することも無い
  if (role === "callee") {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: "call.offer", to: peerId, sdp: offer.sdp ?? "" });
  }

  return {
    peerId,
    async handleOffer(sdp: string) {
      if (closed) return;
      await pc.setRemoteDescription({ type: "offer", sdp });
      remoteSet = true;
      await drain();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "call.answer", to: peerId, sdp: answer.sdp ?? "" });
    },
    async handleAnswer(sdp: string) {
      if (closed) return;
      await pc.setRemoteDescription({ type: "answer", sdp });
      remoteSet = true;
      await drain();
    },
    async addCandidate(candidate: unknown) {
      if (closed || !candidate) return;
      const c = candidate as RTCIceCandidateInit;
      if (!remoteSet) { pending.push(c); return; }
      try { await pc.addIceCandidate(c); } catch (e) { console.warn("[voice] 候補を入れられなかった", e); }
    },
    setMuted(muted: boolean) {
      if (closed) return;
      // 画面側からトラックを直接触らせない。ここ1か所で切り替える
      for (const track of local.getAudioTracks()) track.enabled = !muted;
      console.log("[voice] ミュート: " + (muted ? "する" : "解除"));
    },
    isMuted() {
      const tracks = local.getAudioTracks();
      return tracks.length > 0 && tracks.every((t) => !t.enabled);
    },
    close() {
      if (closed) return;
      closed = true;
      // **マイクを先に止める。** 後回しにすると、閉じる途中で失敗したときに掴んだままになる
      for (const track of local.getTracks()) track.stop();
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      try { pc.close(); } catch { /* 既に閉じている */ }
      console.log("[voice] 通話を終えた（マイクを止めた）");
    },
    micActive() {
      return local.getTracks().some((t) => t.readyState === "live");
    },
  };
}
