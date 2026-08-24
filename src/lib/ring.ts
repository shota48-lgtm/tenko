// 呼びかけに気づくための音（段階5の後半）。
//
// ここに置く理由:
//   画面（village-client.tsx）は既に1800行を超えている。音の作り方をそこへ書くと、
//   村の描画・在席・通話と混ざって追えなくなる。
//   このファイルは **DOM に触れない**。鳴らすかどうかを決めるのは画面側の仕事にしてある。
//
// 決めごと（崩さないこと）:
//   - **音源のファイルを持たない。** ブラウザが持つ音の合成（Web Audio）で作る。
//     ファイルを置くと、読み込みの失敗・容量・配信の経路を考えることになる。
//     必要なのは「短い知らせの音」1つだけなので、その手間に見合わない
//   - **外から読み込まない。** 外部の音源に依存すると、繋がらない場所で鳴らなくなる
//   - **1回だけ鳴らす。繰り返さない。** 鳴り続ける音は、席を外している間に周りへ迷惑になる。
//     気づかせるのは呼びかけの表示とタブの見出しの仕事で、音はその入口にすぎない
//   - **控えめにする。** 突然の大きな音は、それ自体が事故になる（会議中・イヤホン）
//
// 鳴らせない場面は普通にある（利用者がまだ画面を触っていない・音を切っている・
// 音の仕組みが無い）。**そのときは何も表示せず、記録にだけ残す。**
// 呼びかけに気づかせることが目的であって、音が鳴らないことは知らせるほどのことではない。

/** 2つの音の高さ（ヘルツ）。低い音から高い音へ上げる。下げると「終わった」音に聞こえる */
const TONES = [880, 1174.66] as const;
/** 1つあたりの長さ（秒） */
const TONE_SEC = 0.16;
/** 音と音の間（秒） */
const GAP_SEC = 0.06;
/** 音の大きさ。0 から 1 で、控えめにする */
const PEAK_GAIN = 0.06;
/** 立ち上がりと立ち下がりにかける時間（秒）。急に切ると「プツッ」と鳴る */
const FADE_SEC = 0.012;

/** 合計の長さ（秒）。1秒以内であることを、この式で保つ */
export const RING_TOTAL_SEC = TONES.length * TONE_SEC + (TONES.length - 1) * GAP_SEC;

/**
 * 呼びかけの音を1回だけ鳴らす。
 *
 * **投げない。** 鳴らせなかった場合も呼んだ側の処理を落とさない。
 * 戻り値は「鳴らそうとできたか」で、実際に耳に届いたかではない
 * （音量が0の端末や、無音に設定された端末では鳴らないが、それはここでは分からない）。
 */
export async function playRing(): Promise<boolean> {
  try {
    // Safari は webkit 付きの名前しか持たない版がある
    const Ctx: typeof AudioContext | undefined =
      typeof window === "undefined"
        ? undefined
        : window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
      // 音の仕組みが無い。**表示せず記録だけ**（鳴らせなかった場合の分岐 1/3）
      console.log("[ring] 音の仕組みが無いため鳴らさない");
      return false;
    }

    const ctx = new Ctx();
    // まだ画面を触っていない場合、ブラウザが音を止めている。触っていれば再開できる
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch { /* 下の判定で拾う */ }
    }
    if (ctx.state !== "running") {
      // 触る前の画面。**表示せず記録だけ**（鳴らせなかった場合の分岐 2/3）
      console.log("[ring] まだ音を出せない状態のため鳴らさない（画面を一度触ると鳴る）");
      void ctx.close().catch(() => {});
      return false;
    }

    const t0 = ctx.currentTime;
    TONES.forEach((hz, i) => {
      const start = t0 + i * (TONE_SEC + GAP_SEC);
      const end = start + TONE_SEC;

      const osc = ctx.createOscillator();
      // sine は倍音が無く、耳に刺さらない。square や sawtooth は警告音に聞こえる
      osc.type = "sine";
      osc.frequency.value = hz;

      const gain = ctx.createGain();
      // 0 から上げて 0 に戻す。急に切らないことで「プツッ」を避ける
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(PEAK_GAIN, start + FADE_SEC);
      gain.gain.setValueAtTime(PEAK_GAIN, end - FADE_SEC);
      gain.gain.linearRampToValueAtTime(0, end);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(end);
    });

    // 鳴らし終えたら片付ける。開いたままにすると、呼ばれるたびに増えていく
    window.setTimeout(() => { void ctx.close().catch(() => {}); }, (RING_TOTAL_SEC + 0.3) * 1000);
    return true;
  } catch (e) {
    // 想定していない失敗。**表示せず記録だけ**（鳴らせなかった場合の分岐 3/3）
    console.log("[ring] 鳴らせなかった", e);
    return false;
  }
}
