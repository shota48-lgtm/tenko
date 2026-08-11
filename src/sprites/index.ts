// スプライトの読み込みと、バリアントの切り替え。
//
// ここの ACTIVE_VARIANT を書き換えるだけで村全体が入れ替わる。
// 3案は鍵と寸法が完全に一致しているため、描画側の変更は要らない。
import variantA from "./variant-a.json";
import variantB from "./variant-b.json";
import variantC from "./variant-c.json";

export const ACTIVE_VARIANT: "a" | "b" | "c" = "a";

export type SpriteSheet = {
  meta: { variant: string; name: string; description: string };
  palette: string[];
  labels: Record<string, string>;
  sprites: Record<string, number[][]>;
};

export const VARIANTS: Record<"a" | "b" | "c", SpriteSheet> = {
  a: variantA as SpriteSheet,
  b: variantB as SpriteSheet,
  c: variantC as SpriteSheet,
};

export const sheet = (v: "a" | "b" | "c" = ACTIVE_VARIANT): SpriteSheet => VARIANTS[v];
