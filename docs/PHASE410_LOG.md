# PHASE410_LOG

tenko Phase 4.10（残り2件の修正）の作業ログ。

---

## 1. 修正1の原因（実測で特定したもの）

### 測ったこと

`/` を開いた直後の `performance.getEntriesByType("resource")` を読んだ。

```
/api/rooms          開始 832ms  所要 574ms   → 到着は約 1.4 秒後
/api/users          開始 832ms  所要 605ms
/api/notes          開始 832ms  所要 662ms
/api/village?user=1 開始 832ms  所要 803ms
```

### 原因

**建物の配置（部屋の一覧）を、画面側の `fetch("/api/rooms")` で取りに行っていた。**

- 地面・装飾・噴水は地図データ（`map.json`）から描くので、最初の描画で出る
- 人物は WebSocket から届くので、これも早い
- **建物だけが HTTP の到着待ちで、約1.4秒のあいだ「建物のない村」が描かれていた**

POが開いた直後のスクリーンショットは、この1.4秒の中にあった。
そのあと「メンバー一覧を開いたら現れた」のは、操作が描画を促したのではなく、
その時点までに `/api/rooms` が届いていたためである（一覧を開く操作は部屋を取り直さない）。

なお、当時の取得は `.catch(() => {})` で握り潰しており、
**一度失敗すると、そのセッションでは建物が二度と出ない**状態でもあった。

### 直したこと

**部屋の一覧をサーバー側で読み、最初のHTMLに載せて渡す形にした。**

- `src/app/page.tsx` をサーバーコンポーネントにし、DBから部屋を読む
- 画面側（`src/app/village-client.tsx`）は受け取った値で始まる。`/api/rooms` は叩かない
- 建物の配置は村の骨組みであり、後から届く情報にしない

### 実測（直した後）

最初のHTMLに部屋名が含まれているか（`node scripts\verify-first-paint.js 5`）:

```
1 回目: status=200 132ms / 最初のHTMLに含まれる部屋 7/7 OK
2 回目: status=200 144ms / 最初のHTMLに含まれる部屋 7/7 OK
3 回目: status=200 135ms / 最初のHTMLに含まれる部屋 7/7 OK
4 回目: status=200 126ms / 最初のHTMLに含まれる部屋 7/7 OK
5 回目: status=200 127ms / 最初のHTMLに含まれる部屋 7/7 OK
```

---

## 2. 5回の再読み込みの結果

**何も操作せず**、ブラウザで再読み込みを5回行った。

測り方は2つ。
（a）描画のたびに、そのときの部屋数を記録する（最初の5回ぶんだけ残す。`window.__villagePaints`）。
（b）描き上がった canvas の画素を読み、7か所の建物枠で「草でない画素」が4割を超えるかを数える。

| 回 | 各描画時の部屋数 | 実際に描かれた建物 |
|---|---|---|
| 1 | `[7,7,7,7,7]` | 7 |
| 2 | `[7,7,7,7,7]` | 7 |
| 3 | `[7,7,7,7,7]` | 7 |
| 4 | `[7,7,7,7,7]` | 7 |
| 5 | `[7,7,7,7,7]` | 7 |

**1回目の描画からすでに部屋数が7**（例: `{"t":1137,"rooms":7,"people":0}`）。
部屋が0の状態で描かれる瞬間が無くなった。人物が0の描画は残るが、これは
在席が WebSocket 経由で後から届くためで、村の骨組みは欠けていない。

---

## 3. 修正2で用意した種別と、既存7件への割り当て

### 用意した種別（`rooms.deco`。CHECK制約で固定）

| 値 | 意味 | 印（色・形） |
|---|---|---|
| `dev` | 開発 | 青・四角 |
| `sales` | 営業 | 赤・三角 |
| `meeting` | 会議 | 紫・横棒 |
| `rest` | 休憩 | 緑・丸 |
| `support` | サポート | 藁色・十字 |
| `office` | 事務 | 木・ひし形 |
| `hall` | 共有の広間 | 明るい藁・点 |
| `other` | その他（既定値） | 濃色・点 |

**色だけでなく形も変えている。** 色の見分けがつかない人にも区別できるようにするため。
色はパレット16色から採っており、色数は増やしていない。

### 既存7件への割り当て（名前から一度だけ推測してUPDATE）

```
id=1 オフィス   deco=office
id=2 会議室     deco=meeting
id=3 開発       deco=dev
id=4 営業       deco=sales
id=5 休憩所     deco=rest
id=6 サポート   deco=support
id=7 広間       deco=hall
```

7棟すべて別の種別になっており、見分けられる。

### 実測（`node scripts\verify-room-deco.js`）

| 試したこと | 結果 |
|---|---|
| 部屋名を「開発」→「開発チーム」に変更 | `deco=dev` のまま。**印は変わらない** |
| `deco` を `rest` に変更 | `rest` になった。**印が変わる** |
| `kitchen` を入れる | CHECK制約が拒否 |
| 空文字を入れる | CHECK制約が拒否 |
| `DEV`（大文字）を入れる | CHECK制約が拒否 |
| `'; DROP TABLE rooms; --` を入れる | CHECK制約が拒否。`rooms` は健在（7行） |

検証後、`id=3` は `開発 / dev` に戻してある。

部屋名から推測する処理（`ROOM_MARKS` の名前一致）は削除した。

### 種別を変更する画面を作るか → 今回は作らない

DBの値を直接変える運用に留めた。理由は次の2つ。

- 部屋の追加・削除の画面自体が無く、種別だけ変えられても中途半端になる
- 変更できるのは admin に限るべきだが、**認証が未実装のため「admin のみ」を本当の意味では守れない**。
  認証のフェーズの後に、部屋の管理画面としてまとめて作るのが筋である

---

## 4. 実行したDDLとロールバックSQL

`docs/PHASE410_SCHEMA.sql` / `scripts/apply-phase410-ddl.js`。
追加のみ。`DROP` / `TRUNCATE` / `ALTER COLUMN` は含まない。既存の列・制約・トリガーには触れていない。

```sql
ALTER TABLE rooms ADD COLUMN deco text NOT NULL DEFAULT 'other';

ALTER TABLE rooms ADD CONSTRAINT rooms_deco_values
  CHECK (deco IN ('dev','sales','meeting','rest','support','office','hall','other'));

UPDATE rooms SET deco = CASE
  WHEN kind = 'hall'         THEN 'hall'
  WHEN name LIKE '%開発%'     THEN 'dev'
  WHEN name LIKE '%営業%'     THEN 'sales'
  WHEN name LIKE '%会議%'     THEN 'meeting'
  WHEN name LIKE '%休憩%'     THEN 'rest'
  WHEN name LIKE '%サポート%' THEN 'support'
  WHEN name LIKE '%オフィス%' THEN 'office'
  ELSE 'other'
END;
```

既定値を `ADD COLUMN` に含めているため、既存の7件はこの時点で `other` で埋まり、
そのあと名前から一度だけ割り当てている。**既存行が壊れる瞬間が無い。**

ロールバック（実行前に用意した。今は実行していない）:

```sql
ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_deco_values;
ALTER TABLE rooms DROP COLUMN IF EXISTS deco;
```

---

## 5. 破壊試験の結果

| 試験 | 結果 |
|---|---|
| WebSocket 経由で投稿を保存 | `messages 10 -> 10`（増えない） |
| 承認済みの勤怠記録を UPDATE | 例外「承認済みの勤怠記録は変更できません」 |
| 確定・却下済みの下書きを UPDATE | 例外「確定または却下済みの下書きは変更できません」 |
| 他人の勤怠を承認（本人 / 無関係 / 別上長 / 担当上長） | 403 / 403 / 403 / 200 |
| 他人の在席を変更 | HTTPに口が無い（`/api/presence` → 404）。配信に名前は含まれない（`undefined`） |
| 他人のアバターを移動 | 動かない |
| `member` がお知らせを書き込む | 403。DBに残った書き手は admin（id=6）のみ |

満員の建物への移動も引き続き拒否される（「「オフィス」は満員です（4/4）」）。

---

## 6. 迷った点と、選んだもの・却下したもの

| 迷った点 | 選んだもの | 却下したもの・理由 |
|---|---|---|
| 建物が出ない問題の直し方 | **部屋をサーバー側で読んで最初のHTMLに載せる** | 画面側の fetch のまま、届くまで村を描かない（1.4秒間なにも出ない）／fetch に再試行を足す（遅さは残り、失敗時だけの対策にしかならない） |
| 部屋の取り直し | 開いた時点の値で固定（`force-dynamic` で毎回サーバーが読む） | 定期的な取り直し（部屋の増減は稀で、通信を増やす価値がない）。人数は WebSocket が配るので、変わり続ける情報は別経路にある |
| 種別の持ち方 | `text` + CHECK制約 | PostgreSQL の `ENUM` 型（値を足すのに型の変更が要り、追加のみのDDLという条件と相性が悪い） |
| 種別の見せ方 | 色と形の両方を変える | 色だけ（色の見分けがつかない人に区別できない） |
| 種別の変更手段 | 今回はDBの値を直接変える | 管理画面（認証が無いため「admin のみ」を守れない。部屋の追加・削除も無いので中途半端になる） |
| 描画の計測 | 描画のたびの状態を最初の5回だけ残す | 一時的な計測コードを入れて後で消す（同じ不具合が再発したときに、また入れ直すことになる） |

---

## 7. コミット

（末尾の「git --no-pager log --oneline」を参照）
