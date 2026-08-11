/* 審査役A: 「他人が書いた文字列が自分の画面に出る」経路で、
   HTMLとして解釈されないことを実測する。
   吹き出しは <div>{text}</div> の形で本文を入れているので、同じ形を実際に描画して出力を見る。 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const payloads = [
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(1)">',
  "</div><b>太字</b>",
  "1 < 2 && 3 > 2",
  "\"quoted\" and 'single'",
];

console.log("=== React のテキストとして入れた場合の出力 ===");
for (const p of payloads) {
  const html = renderToStaticMarkup(createElement("div", { className: "bubble" }, p));
  const executable = /<script|onerror=|<img/i.test(html.replace(/&lt;|&gt;|&quot;|&#x27;|&amp;/g, ""));
  console.log("  入力: " + JSON.stringify(p));
  console.log("    出力: " + html);
  console.log("    タグとして出ているか: " + (html.includes("<script>") || html.includes("<img ") ? "出ている（危険）" : "出ていない") +
    " / 生のタグ片が残るか: " + (executable ? "残る" : "残らない"));
}

console.log("");
console.log("=== 比較: dangerouslySetInnerHTML を使った場合（この形は使っていない）===");
const bad = renderToStaticMarkup(
  createElement("div", { dangerouslySetInnerHTML: { __html: "<script>alert(1)</script>" } }),
);
console.log("  出力: " + bad);
console.log("  ※ この形だとタグがそのまま出る。だから使わない、という対比のための確認");
