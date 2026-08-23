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

/**
 * 通話が今どうなっているか（段階5）。**画面に出す文言はこれだけで決まる。**
 *
 * ここに置く理由:
 *   接続の状態（RTCPeerConnectionState）を持っているのはこのファイルである。
 *   画面側で判定を組むと、状態の出どころと判定が離れ、実体と表示がずれても気づけない。
 *
 *   connecting : つないでいる最中（new / connecting）
 *   connected  : つながった
 *   failed     : **一度も connected にならずに** failed になった
 *   lost       : connected になった後に disconnected か failed になった
 */
export type VoicePhase = "connecting" | "connected" | "failed" | "lost";

/**
 * 接続の状態が変わったときの、次の段階を返す。
 *
 * 「繋がらなかった」と「切れた」は、同じ failed から分かれる。
 * 分けるのは **一度でも connected になったか** だけなので、それを引数で受け取る。
 * 判定を1つの関数に閉じてあるので、外から同じ入力を与えれば同じ答えが確かめられる。
 *
 * 何も変えるべきでないときは prev をそのまま返す（closed など）。
 */
export function nextVoicePhase(
  prev: VoicePhase,
  state: RTCPeerConnectionState,
  everConnected: boolean,
): VoicePhase {
  if (state === "connected") return "connected";
  if (state === "new" || state === "connecting") return "connecting";
  if (state === "failed") return everConnected ? "lost" : "failed";
  // 繋がる前の disconnected は途中の状態。まだ「切れた」とは言えない
  if (state === "disconnected") return everConnected ? "lost" : prev;
  return prev;
}

/** 段階ごとに画面へ出す文言。**文言を書くのはここ1か所だけにする。** */
export function voiceStatusText(phase: VoicePhase): string {
  if (phase === "connected") return "つながりました";
  if (phase === "failed") return "相手とつながりませんでした";
  if (phase === "lost") return "通話が切れました";
  return "つないでいます";
}

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
  /**
   * マイクが使えているか（段階5）。
   *
   * **偽でも通話は成立する。** 相手の声は聞こえ、こちらの声だけが届かない。
   * 偽になるのは、マイクの取得が拒否された場合と、取れた音声トラックが0本の場合。
   * この2つを分けない理由は、利用者から見ればどちらも「声が届かない」であり、
   * 対処（許可し直して入り直す）も同じだからである。
   */
  micAvailable(): boolean;
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

  // 音声だけ。映像は取らない（取ると許可の求め方が変わり、通信量も跳ね上がる）。
  //
  // **許可が下りなくても通話は始める（段階5）。**
  //   以前はここで例外が出て、通話そのものが始まらなかった。
  //   だが「自分の声が届かない」ことと「相手の声も聞こえない」ことは別である。
  //   マイクを断った人にも、相手の声は聞こえてよい（聞くだけの参加ができる）。
  //   声が届いていないことは画面に出す（micAvailable を見て画面側が出す）。
  let local: MediaStream;
  try {
    local = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    // 断られた・マイクが無い・別のアプリが掴んでいる。**通話は続ける**
    console.warn("[voice] マイクを取れなかった（相手の声は聞こえるが、こちらの声は届かない）", e);
    local = new MediaStream();
  }

  // STUN は必ず入れる。中継の設定は、あれば後ろに足す。
  // **STUN_URLS の値は変えない**（段階3で確かめた、無料・無登録のもの）
  const iceServers: RTCIceServer[] = [{ urls: STUN_URLS }, ...(opts.iceServers ?? [])];
  console.log("[voice] 中継サーバーの設定: " + ((opts.iceServers?.length ?? 0) > 0 ? "あり" : "無し（STUNのみ）"));

  const pc = new RTCPeerConnection({ iceServers });
  for (const track of local.getTracks()) pc.addTrack(track, local);
  // 送るものが1つも無い場合、そのままでは音声の枠が作られず、相手の声も受け取れない。
  // 受け取る専用の枠を明示して作る
  if (local.getAudioTracks().length === 0) {
    pc.addTransceiver("audio", { direction: "recvonly" });
  }

  // ── ここから、切り分けのための記録（段階5の調査） ────────────────────────
  //
  // 音が歪むのは実マイクと実スピーカーを通したときだけで、手元では再現しない。
  // そこで「どの経路で繋がったか」「どれだけ落ちて・揺れて・埋められたか」を
  // 記録に出し、POが実機で読めるようにする。**画面には出さない**（出し方は段階5で決める）。
  //
  // **候補が集まったことを根拠にしない。** 実際に使われている組を統計から引く。
  // 候補はいくつも集まるが、使われるのはそのうち1組だけである。

  /** 実際に使われている候補の組を、統計から1つ引く。無ければ null */
  const selectedPair = (s: RTCStatsReport) => {
    const byId = new Map<string, RTCStats>();
    s.forEach((r) => byId.set(r.id, r));

    // transport が指している組が正。ここに無い場合だけ、succeeded かつ nominated を拾う
    let pair: (RTCStats & Record<string, unknown>) | null = null;
    s.forEach((r) => {
      const t = r as RTCStats & { selectedCandidatePairId?: string };
      if (r.type === "transport" && t.selectedCandidatePairId) {
        pair = (byId.get(t.selectedCandidatePairId) as typeof pair) ?? pair;
      }
    });
    if (!pair) {
      s.forEach((r) => {
        const c = r as RTCStats & { selected?: boolean; nominated?: boolean; state?: string };
        if (r.type === "candidate-pair" && (c.selected || (c.nominated && c.state === "succeeded"))) {
          pair = r as typeof pair;
        }
      });
    }
    if (!pair) return null;

    const p = pair as RTCStats & { localCandidateId?: string; remoteCandidateId?: string; currentRoundTripTime?: number };
    const lc = p.localCandidateId ? (byId.get(p.localCandidateId) as { candidateType?: string } | undefined) : undefined;
    const rc = p.remoteCandidateId ? (byId.get(p.remoteCandidateId) as { candidateType?: string } | undefined) : undefined;
    return {
      localType: lc?.candidateType ?? "不明",
      remoteType: rc?.candidateType ?? "不明",
      rtt: typeof p.currentRoundTripTime === "number" ? p.currentRoundTripTime : null,
    };
  };

  let routeLogged = false;
  /** 最後に読めた品質の1行。閉じるときに出す（閉じた後は統計を読めないため先に貯めておく） */
  let lastQuality: string | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;

  const ms = (sec: number | null | undefined) =>
    typeof sec === "number" ? (sec * 1000).toFixed(1) + "ms" : "不明";
  const pct = (n: number, d: number) => (d > 0 ? ((n / d) * 100).toFixed(2) + "%" : "—");

  const readStats = async () => {
    if (closed) return;
    let s: RTCStatsReport;
    try { s = await pc.getStats(); } catch { return; }

    // 経路は繋がった直後に1回だけ出す。毎秒出すと記録が埋まる
    const sel = selectedPair(s);
    if (!routeLogged && sel) {
      routeLogged = true;
      console.log("[voice] 経路: " + sel.localType + " / " + sel.remoteType);
    }

    // 品質は貯め続け、閉じるときに最後の1行を出す
    let packetsSent = 0, packetsReceived = 0, packetsLost = 0;
    let jitter: number | null = null, concealed = 0, samples = 0;
    s.forEach((r) => {
      const a = r as RTCStats & Record<string, number | string | undefined>;
      if (r.type === "outbound-rtp" && a.kind === "audio") {
        packetsSent = Number(a.packetsSent ?? 0);
      }
      if (r.type === "inbound-rtp" && a.kind === "audio") {
        packetsReceived = Number(a.packetsReceived ?? 0);
        packetsLost = Number(a.packetsLost ?? 0);
        jitter = typeof a.jitter === "number" ? a.jitter : jitter;
        concealed = Number(a.concealedSamples ?? 0);
        samples = Number(a.totalSamplesReceived ?? 0);
      }
    });
    // 届くはずだった数 = 受け取った数 + 失われた数
    const expected = packetsReceived + packetsLost;
    lastQuality =
      "[voice] 品質: 受信で失われた小包 " + packetsLost + "/" + expected + "（" + pct(packetsLost, expected) + "）" +
      " / 送った小包 " + packetsSent +
      " / 揺らぎ " + ms(jitter) +
      " / 往復 " + ms(sel?.rtt) +
      " / 埋めた標本 " + concealed + "（" + pct(concealed, samples) + "）";
  };

  // 2秒ごとに読む。閉じる直前の値を持っておくため
  poller = setInterval(() => { void readStats(); }, 2_000);
  // ── 記録のための追加はここまで ───────────────────────────────────────

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
    // 繋がった時点で経路を出す。2秒の間隔を待たずに読む
    if (pc.connectionState === "connected") void readStats();
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
      // **品質の記録を、閉じる前に出す。** 閉じた後は統計を読めない。
      // closed を立てる前に出すのは、readStats が closed を見て何もしなくなるため
      if (lastQuality) console.log(lastQuality);
      else console.log("[voice] 品質: 記録なし（繋がる前に終わった）");
      if (poller !== null) { clearInterval(poller); poller = null; }

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
    micAvailable() {
      // 取れた音声トラックが0本なら使えていない。
      // 取得が拒否された場合も、上で空の MediaStream にしてあるので0本になる
      return local.getAudioTracks().length > 0;
    },
  };
}
