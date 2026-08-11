// 吹き出しの配置。描画（画面）と検証（PNG書き出し）の両方から使う純粋な計算。
//
// 村の一覧性を壊さないための規則をここに集約する:
//   - 常時表示するのは上限まで。それを超えたら「他 N 人」に畳む
//   - 1つの吹き出しは2行まで。溢れたら省略記号で切る
//   - 村の外にはみ出さないよう、左右と上を折り返す
//
// 文字幅は「全角1・半角0.5」の近似で数える。実際のフォント幅とは一致しないが、
// 折り返しと重なりの判定にはこの粒度で足りる（画面側は CSS / measureText で最終調整する）。

export type BubbleInput = {
  userId: number;
  x: number;      // 人物の左上（村の座標。1ドット単位）
  y: number;
  text: string;
};

export type BubbleBox = {
  userId: number;
  x: number;      // 吹き出しの左上
  y: number;
  w: number;
  h: number;
  lines: string[];
  tailX: number;  // しっぽの先端（人物の頭の上）
  tailY: number;
};

export type BubbleLayout = {
  boxes: BubbleBox[];
  hiddenCount: number;      // 上限を超えて畳んだ人数
  markOnly: BubbleInput[];  // 吹き出しは出さず、頭上に「メモあり」の印だけ出す人
};

export const BUBBLE = {
  // 常時表示する上限。
  // 8件で試したところ、広場に人が並ぶと吹き出しが横につながって1本の帯に見え、
  // 重なりが5件出た（審査役BのPNG実測）。村の一覧性が最優先なので3件に絞る。
  // 残りは頭上の小さな印だけにして、存在は分かるが画面は埋まらない形にする
  maxVisible: 3,
  maxLines: 2,
  maxCharsPerLine: 14,  // 全角換算
  padX: 3,
  padY: 2,
  lineHeight: 7,
  charW: 6,             // 全角1文字あたりの見込み幅（ドット）
  tail: 3,
};

const widthOf = (ch: string) => {
  const cp = ch.codePointAt(0) ?? 0;
  // 半角英数・記号・半角カナはおよそ半分の幅
  if (cp <= 0x7e || (cp >= 0xff61 && cp <= 0xff9f)) return 0.5;
  return 1;
};

// 全角換算の幅で折り返す
export function wrap(text: string, maxCols: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = "";
  let curW = 0;
  for (const ch of text) {
    const w = widthOf(ch);
    if (curW + w > maxCols) {
      lines.push(cur);
      cur = "";
      curW = 0;
      if (lines.length === maxLines) break;
    }
    cur += ch;
    curW += w;
  }
  if (lines.length < maxLines && cur.length > 0) lines.push(cur);

  // 溢れた分があれば、最後の行の末尾を省略記号にする
  const consumed = lines.join("");
  if (Array.from(consumed).length < Array.from(text).length && lines.length > 0) {
    const last = Array.from(lines[lines.length - 1]);
    last.splice(Math.max(0, last.length - 1), 1, "…");
    lines[lines.length - 1] = last.join("");
  }
  return lines;
}

export function measure(lines: string[]): number {
  let max = 0;
  for (const l of lines) {
    let w = 0;
    for (const ch of l) w += widthOf(ch);
    if (w > max) max = w;
  }
  return max;
}

// 吹き出しを配置する。
// 表示するのは maxVisible 件まで。どれを出すかは呼び出し側が決めた並び順に従う
export function layoutBubbles(
  inputs: BubbleInput[],
  villageW: number,
  villageH: number,
  opt: Partial<typeof BUBBLE> = {},
): BubbleLayout {
  const cfg = { ...BUBBLE, ...opt };
  const shown = inputs.slice(0, cfg.maxVisible);
  const boxes: BubbleBox[] = [];
  const overflow: BubbleInput[] = inputs.slice(cfg.maxVisible);

  const hits = (a: { x: number; y: number; w: number; h: number }) =>
    boxes.some((b) => a.x < b.x + b.w + 2 && b.x < a.x + a.w + 2 && a.y < b.y + b.h + 2 && b.y < a.y + a.h + 2);

  for (const it of shown) {
    const lines = wrap(it.text, cfg.maxCharsPerLine, cfg.maxLines);
    if (lines.length === 0) continue;
    const w = Math.round(measure(lines) * cfg.charW) + cfg.padX * 2;
    const h = lines.length * cfg.lineHeight + cfg.padY * 2;

    // 人物の頭の上に出す。人物は 16x16 で、頭は上から2ドットあたり
    const tailX = it.x + 8;
    const tailY = it.y + 1;
    let x = Math.round(tailX - w / 2);
    const y = tailY - cfg.tail - h;

    // 村の外にはみ出さないよう寄せる
    if (x < 1) x = 1;
    if (x + w > villageW - 1) x = villageW - 1 - w;

    // 既に置いた吹き出しと重ならないよう、上へ段差を付けて避ける。
    // 避けきれない場合は吹き出しを出さず、頭上の印だけにする（重なった表示より読めない状態を作らない）
    let placed = false;
    for (let step = 0; step < 6; step++) {
      const ty = y - step * (h + 3);
      if (ty < 1) break;
      if (!hits({ x, y: ty, w, h })) {
        boxes.push({ userId: it.userId, x, y: ty, w, h, lines, tailX, tailY });
        placed = true;
        break;
      }
    }
    if (!placed) overflow.push(it);
  }

  return { boxes, hiddenCount: overflow.length, markOnly: overflow };
}

// 吹き出し同士が重なっているかを数える（検証用）
export function countOverlaps(boxes: BubbleBox[]): number {
  let n = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) n++;
    }
  }
  return n;
}
