# PHASE5_LOG

Phase 5（認証）の作業記録。設計は `docs/PHASE5_AUTH_DESIGN.md`。

---

## 2026-08-13 段階0〜2

ブランチ: `feature/phase5-auth`（main へのマージ・push は行っていない）

### 到達点

| 段階 | 内容 | 状態 |
|---|---|---|
| 0 | 準備 | **PO待ち。** Google の OAuth クライアントが要る（手順は本ファイル末尾） |
| 1 | DDL + `SELECT *` の潰し込み | **完了**（実測あり） |
| 2 | Auth.js 導入 | **コードは完了。ログインの実機確認だけが PO待ち**（認証情報が無いと動かせない） |

---

## 1. 実行したDDL

`scripts/apply-phase5-ddl.js --apply` で実行した。全文は `docs/PHASE5_SCHEMA.sql`。**15文**。

実行前の確認（スクリプトが自動で行う）:

```
接続先の database: neondb
tenko の表として見つかったもの: attendance_drafts, attendance_records, messages, rooms, users
実行前のトリガー: attendance_drafts_freeze, attendance_records_freeze
```

実行結果:

```
OK: ALTER TABLE users ADD COLUMN name TEXT
OK: ALTER TABLE users ADD COLUMN email TEXT
OK: ALTER TABLE users ADD COLUMN "emailVerified" TIMESTAMPTZ
OK: ALTER TABLE users ADD COLUMN image TEXT
OK: CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL
OK: ALTER TABLE users ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT false
OK: ALTER TABLE users ADD CONSTRAINT users_demo_has_no_email CHECK (is_demo = false OR email IS NULL)
OK: CREATE TABLE accounts (...)
OK: CREATE UNIQUE INDEX accounts_provider_uq ON accounts (provider, "providerAccountId")
OK: CREATE INDEX accounts_user_idx ON accounts ("userId")
OK: CREATE TABLE sessions (...)
OK: CREATE UNIQUE INDEX sessions_token_uq ON sessions ("sessionToken")
OK: CREATE INDEX sessions_user_idx ON sessions ("userId")
OK: CREATE TABLE verification_token (...)
OK: CREATE TABLE demo_presence (...)

実行後のトリガー: attendance_drafts_freeze, attendance_records_freeze
トリガーは変わっていないか: はい
users の列: id, display_name, role, created_at, deleted_at, manager_id, name, email, emailVerified, image, is_demo
表の一覧: accounts, announcement_reads, announcements, attendance_drafts, attendance_records,
         daily_notes, demo_presence, messages, read_states, room_members, rooms, sessions,
         users, verification_token
```

実行条件の遵守:

| 条件 | 結果 |
|---|---|
| 実行前にロールバックSQLをファイルに書く | `docs/PHASE5_SCHEMA.sql` 末尾に記載。スクリプトは実行前に画面にも出す |
| 実行したDDLを1文残らず記録 | 同ファイル。スクリプトの `STATEMENTS` と一致させてある |
| `DROP` / `TRUNCATE` を実行しない | スクリプトに `FORBIDDEN` 判定を置き、含まれていれば実行前に落ちる |
| 既存の列と制約を変更しない | **設計から1文落とした**（下記） |
| 既存のトリガー2つを変更・削除しない | 実行の前後で名前を突き合わせた。同一 |
| tenko 以外のDBに接続しない | 実行前に `current_database()` と tenko の主要5表の存在を確認。無ければ実行せず終了 |

### 設計から落とした1文

```sql
ALTER TABLE users ALTER COLUMN display_name SET DEFAULT '(未登録)';
```

**実行しなかった。** 既存の列の既定値を変える操作であり、実行条件「既存テーブルの既存の列と制約を変更しないこと」に反するため。

この文はもともと「アダプタが `createUser` を呼んだときに 500 にならない保険」だった。
未登録者は `signIn` コールバックで先に落ちるため `createUser` には到達せず、保険が無くても設計は成立する。
設計書にも落とした旨を記録した。

### ロールバックSQL

```sql
DROP TABLE IF EXISTS demo_presence;
DROP TABLE IF EXISTS verification_token;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS accounts;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_demo_has_no_email;
ALTER TABLE users DROP COLUMN IF EXISTS is_demo;
DROP INDEX IF EXISTS users_email_uq;
ALTER TABLE users DROP COLUMN IF EXISTS image;
ALTER TABLE users DROP COLUMN IF EXISTS "emailVerified";
ALTER TABLE users DROP COLUMN IF EXISTS email;
ALTER TABLE users DROP COLUMN IF EXISTS name;
```

**注意**: `DROP COLUMN email` は登録済みのアドレスを失う。
戻す前に `SELECT id, email FROM users WHERE email IS NOT NULL` を控えること。

---

## 2. `SELECT *` の潰し込みと、漏れていないことの実測

### 静的な確認

`src/` と `ws-server/` を `SELECT *` / `select *` / `RETURNING *` / `u.*` で全数検索した。
**該当は0件。** 既存のコードは全て列を明示して選んでいた。潰し込みの必要は無かった。

### 実測（コードを直しただけで済ませない）

列を追加した**あと**に、`scripts/verify-no-leak.js` で全13経路の応答本文を実際に取得し、
`email` / `emailVerified` / `"image"` / `is_demo` / `@` を含まないことを確かめた。

```
OK  200 /api/rooms len=460
OK  200 /api/users len=1747
OK  200 /api/notes len=21
OK  200 /api/notes?user=1 len=22
OK  200 /api/me?user=1 len=53
OK  200 /api/village?user=1 len=30
OK  200 /api/announcements?user=1 len=2027
OK  200 /api/rooms/1/messages?after=0&limit=5 len=1065
OK  200 /api/attendance/drafts?user=1 len=791
OK  403 /api/attendance/approvals?user=1 len=28
OK  200 /api/attendance/corrections?user=1 len=51
OK  200 /api/attendance/anomalies?user=1 len=518
OK  400 /api/attendance/monthly?... len=30

漏れ・失敗: 0 件 / 13 経路
```

`/api/attendance/monthly` は上の実行では引数が足りず 400 だったため、正しい引数で取り直した:

```
GET /api/attendance/monthly?actor=1&user=1&year=2026&month=8
len=175  CSV（# tenko 勤怠記録,テスト太郎(id=1),2026年08月 …）
email を含むか: False
```

**13経路すべてで漏れなし。**

### 実測して分かったこと（重要）

アダプタの `getUser` は `select * from users where id = $1` を投げるため、
**Auth.js の内部には `email` も `is_demo` も入る**（`scripts/probe-id-type.mjs` で確認）。

```
アダプタが返した鍵: id, display_name, role, created_at, deleted_at, manager_id,
                    name, email, emailVerified, image, is_demo
```

これはアダプタの実装であり、こちらでは変えられない。
**画面に出るのは `auth.ts` の `session` コールバックが組み立てたものだけ**にしてあるため、
村の画面や自作APIには流れない。

ただし1点、意図して残した箇所がある:
Auth.js の既定のセッションには `user.email`（**ログインした本人のアドレス**）が入る。
これは標準の挙動で、他人のアドレスは一切含まれない。消す必要は無いと判断した。
**不要と判断されるなら `session` コールバックで落とせる**（1行）。POの判断を仰ぐ。

---

## 3. 段階2で書いたもの

| ファイル | 内容 |
|---|---|
| `src/auth.ts` | Auth.js の設定。プロバイダ / セッション / `signIn` / `session` |
| `src/app/api/auth/[...nextauth]/route.ts` | Auth.js の入口。繋ぐだけ |
| `src/app/login/page.tsx` | ログイン画面と拒否の説明。Server Component |
| `src/types/next-auth.d.ts` | セッションの型（`id: number` / `displayName` / `role`） |
| `scripts/apply-phase5-ddl.js` | 段階1のDDL |
| `scripts/verify-no-leak.js` | 応答に `email` 等が混ざらないことの実測 |
| `scripts/probe-id-type.mjs` | `bigint` の型の実測 |

**既存のAPIには一切手を入れていない。** `actor.ts` も `village-client.tsx` も無変更。
段階2の時点では既存の権限の検証は今までどおり効いている（破壊試験で確認。9節）。

パッケージ（完全にピン留め。設計書に挙げた以外は追加していない）:

```
"@auth/pg-adapter": "1.11.3",
"next-auth": "5.0.0-beta.32",
```

`npx tsc --noEmit` は 0 で通る。

---

## 4. ログインの実機確認

### できたこと

`/login` と `/login?error=AccessDenied` が意図どおり描画されることを、ブラウザで確認した（スクリーンショットあり）。

### できなかったこと（**PO待ち**）

**Google のログイン画面まで遷移させられなかった。** 認証情報が無いため。

`.env.local` にあるのは `DATABASE_URL` の1件のみで、`AUTH_SECRET` も Google のクライアントも無い。
この状態での実測:

```
GET /api/auth/providers -> HTTP 500
GET /api/auth/session   -> HTTP 500
GET /api/auth/csrf      -> HTTP 500
サーバのログ: [auth][error] MissingSecret: Please define a `secret`.
```

一方で `/login` は 200 で描画される。**`auth()` は秘密鍵が無くても例外を投げず null を返す**ためで、
これは「ログインしていない人には村を見せる」設計にとっては都合がよい挙動である（段階4で効いてくる）。

したがって以下は**すべて未確認のまま**である。段階0の認証情報が入り次第、続けて確認する。

- Google でログインできること
- 未登録のアドレスで拒否され、DBに1行も作られないこと
- `TENKO_ADMIN_EMAILS` のアドレスが `admin` になること
- 既存の `users` に email を紐づけた人がログインできること
- `OAuthAccountNotLinked` が実際に出るかどうか

**これらは「設計どおりのはず」であって、実測ではない。** 区別して扱うこと。

### ローカルで再現しないと分かっていること

- **Cookie の `secure` 属性**: `http://localhost` では `secure` が付かない。本番（https）で初めて付く
- **別ドメイン間の挙動**: ローカルはアプリも ws-server も localhost で、実質同一オリジンに近い。
  Vercel（アプリ）と Railway（ws）に分かれたときの Cookie の扱いは、**ここでは再現しない**（段階6の論点）
- **`AUTH_URL` の自動検出**: Vercel 上でのみ効く経路がある

---

## 5. `bigint` の id は文字列で返るか（設計書の「要実測」）

**文字列で返る。実測した。**

```
素の pg  : id="1" typeof=string / is_demo=false typeof=boolean
アダプタ : id="1" typeof=string
```

`auth.ts` の `session` コールバックで `Number()` に通している。
これを通さないと `session.user.id === user.id` のような比較が静かに偽になる。

---

## 6. Cookie の設定値と理由

**Auth.js の既定のままにした。** 変えていない。

| Cookie | httpOnly | sameSite | secure | path |
|---|---|---|---|---|
| `authjs.session-token`（本番は `__Secure-` 付き） | true | lax | 本番のみ true | / |
| `authjs.csrf-token`（本番は `__Host-` 付き） | true | lax | 本番のみ true | / |
| `authjs.pkce.code_verifier` / `authjs.state` | true | lax | 本番のみ true | /（900秒） |

理由:

- **httpOnly: true** — JavaScript から読めない。画面のスクリプトが漏れてもセッションを持ち出せない
- **secure: 本番 true** — https でのみ送る。ローカルの http で開発できるよう、自動で切り替わる
- **sameSite: lax** — `strict` にしない。**Google から戻ってくる遷移で Cookie が送られず、ログインが完了しなくなる**ため。
  `lax` でも他サイトからの POST には送られないので、書き込みのCSRFは防げる。
  ただしこれに頼らず、段階3で `Origin` の確認を全ての書き込み経路に入れる（多層）
- `__Host-` / `__Secure-` の接頭辞は、Cookie の書き換えに対する追加の防御。既定で付く

出典はドキュメントではなく `@auth/core@0.41.3` の `lib/utils/cookie.js` の**実装**である
（ドキュメントに既定値の一覧が無い）。

---

## 7. proxy に頼らないこと

**この段階では `proxy.ts` を作っていない**（段階4の作業）。

`/login` は Server Component で `auth()` を直接呼んでいる。
既存のAPIは今までどおり `actor.ts` で検証している。
proxy を「守り」として使う経路は、現時点で1つも存在しない。

---

## 8. 決めたこと（POの判断に基づく実装方針）

| # | 判断 | 反映先 |
|---|---|---|
| 1 | `allowDangerousEmailAccountLinking: true` を付ける。**Google 単独である限り安全。別の提供元を追加する場合は必ず見直す** | `src/auth.ts` のコメント / 設計書3節 |
| 2 | `/api/notes` は開放するが**デモ用の利用者の分だけ** | 設計書4節（実装は段階4） |
| 3 | `/api/ws-verify` の失敗時は接続を維持。**連続5回で警告、連続10回（約10分）で認証済み接続を切り、見るだけに落とす** | 設計書6節（実装は段階6） |
| 4 | 村に出すデモ用の利用者は20人前後。残りは一覧にのみ出す | 設計書8節（実装は段階5） |
| 5 | 見るだけモードの噴水は「押せるが中身は見えない」 | 設計書4節（実装は段階4） |

判断3の内訳（CCが決めた部分）:

- 1〜4回（〜4分）: ログに出すだけ
- 5回（5分）: 警告に上げる。新しい接続は受け続ける（券の検証はHMACだけででき、アプリに依存しない）
- **10回（10分）: 認証済みの接続を `close(4001)` で切り、確認が1回成功するまで見るだけ扱いにする**

60秒の遅延を許容できるとした根拠は「短時間の障害なら在席の表示が古くなるだけ」だった。
10分続く障害はその前提が崩れている。切られた人はアプリが復旧していれば数秒で戻り、
復旧していなければ券が取れないので、そもそも入れない状態と一致する。

---

## 9. 破壊試験（段階2の完了時）

既存のスクリプトをそのまま実行した。**認証を入れる過程で壊れた保証は無い。**

| 試験 | 結果 | 出典 |
|---|---|---|
| WebSocket 経由で投稿を保存できないこと | **保たれている**（messages 10 → 10。増えない） | `attack-presence.js` / `attack-phase45.js` |
| 承認済みの勤怠記録が変更できないこと | **保たれている**（例外: 承認済みの勤怠記録は変更できません id=1） | `attack-phase45.js` |
| 確定・却下済みの下書きが変更できないこと | **保たれている**（例外: 確定または却下済みの下書きは変更できません id=1） | `attack-phase45.js` |
| 他人の勤怠記録を承認できないこと（4通り） | **保たれている**。本人 403 / 無関係 member 403 / 別の上長 403 / 担当の上長のみ 200 | `attack-phase45.js` |
| 他人の在席状態を変更できないこと | **既知の穴のまま**（S6）。WSに認証が無いため変更できてしまう。**段階6で塞ぐ**。名前は配信していないため騙れない | `attack-presence.js` |
| 他人のアバターを移動できないこと | **保たれている**（被害者は動いていない。添えたIDは読まれない） | `attack-phase48.js` |
| `member` がお知らせを書き込めないこと | **保たれている**（member 403 / manager 403 / admin 201。DBの書き手は全て admin の id=6） | `attack-phase49.js` |

あわせて確認できたもの（回帰）:
定員超過で建物に入れない（4/4で断り）/ 呼びかけの連打制限（15回中0回通過）/
不正な座標の扱い / 入力の検証（201文字は400、空は400）/ 存在しない利用者は401。

### 失敗した1件（Phase 5 とは無関係）

`scripts/verify-phase4-permissions.js` が最後まで走らなかった。

```
ERR: duplicate key value violates unique constraint "messages_dedupe_uq"
```

原因: このスクリプトは固定のUUIDで投稿を作り、そのあと `messages.user_id` を書き換える作りになっている。
2回目以降の実行で `(user_id, client_msg_id)` が既存行と衝突する。**スクリプト自身が繰り返し実行できない**。

Phase 5 の変更が原因ではない（`users` に列を足しただけで `messages` には触れていない）。
このスクリプトが見る「承認の権限4通り」は `attack-phase45.js` の末尾が同じ範囲を実際に確認しており、
そちらは通っている。**スクリプトの修正は段階3で行う**（今回の範囲外の変更を混ぜないため）。

---

## 10. 段階3以降に向けて分かったこと・懸念

1. **`village-client.tsx` は1257行あり、`me.id` を30か所以上で使っている。**
   段階3の書き換えはここが本体になる。`?user=` を外すだけでなく、
   `devUser()`（画面が自分で利用者を決めている関数）そのものを消す必要がある
2. **`/api/rooms/[roomId]/messages` は `actor.ts` を使っていない。**
   独自に `const CURRENT_USER_ID = Number(process.env.TENKO_DEV_USER_ID ?? 1)` を持っている。
   段階3の「`requestedUserId` を消す」だけでは**この経路が残る**。見落としやすい
3. アダプタが `select *` を使う以上、**`users` に機微な列を足すときは常に注意が要る**。
   段階3で入れる `verify-auth-coverage.js` に、`SELECT *` の全数検索も入れる
4. 開発サーバに Turbopack の内部エラー（HMRの panic）が1度出た。
   ファイルを足した直後の再読み込みで発生し、再起動で消えた。**実害は確認していない**

---

## 11. 現時点で答えを持たない事項

| 事項 | 区分 | 内容 |
|---|---|---|
| Google でログインできるか | **未検証** | 認証情報が無く試せていない。段階0がPO待ち |
| 未登録が拒否され、DBに行が作られないか | **未検証**（実装の順序は確認済み） | `@auth/core` の実装で `signIn` が `createUser` より前に走ることは確認済み。**実際に試してはいない** |
| `TENKO_ADMIN_EMAILS` による昇格 | **未検証** | 同上 |
| `OAuthAccountNotLinked` が出るか | **仮説のまま** | `allowDangerousEmailAccountLinking` を付けたため、**そもそも出ない見込み**。外して試せば確認できるが、確認のために危険側の設定へ倒す価値は無いと判断した |
| 本番（別ドメイン）での Cookie の挙動 | **未検証** | ローカルでは再現しない。段階6の spike で確認する |
| Vercel → Neon のセッション確認の実遅延 | **要実測** | 段階3の完了時に測る |
| セッションに本人の `email` が載ること | **仕様。判断待ち** | Auth.js の既定。他人のアドレスは含まれない。落とすなら1行 |

---

---

# 2026-08-13（続き）環境変数の確認と、段階2の実測

段階0の認証情報がPOによって設定されたため、保留していた実測を行った。

## A. 環境変数

`tenko\.env.local` の状態（**値は記録しない。名前と有無のみ**）:

| 変数名 | 有無 |
|---|---|
| `DATABASE_URL` | あり |
| `AUTH_SECRET` | あり |
| `AUTH_GOOGLE_ID` | あり |
| `AUTH_GOOGLE_SECRET` | あり |
| `TENKO_ADMIN_EMAILS` | あり（**名前を直した。下記**） |

### 変数名の食い違いを1件直した

POが設定したのは `TENKO_ADMIN_EMAIL`（単数）で、`src/auth.ts` が読むのは
**`TENKO_ADMIN_EMAILS`（複数形）**だった。このままでは管理者の昇格が動かない。

**値には触れず、行の先頭の変数名だけを書き換えた**（`TENKO_ADMIN_EMAIL=` → `TENKO_ADMIN_EMAILS=`）。
書き換えの前後で、5つの変数すべてについて値の文字数が変わっていないことを確認している。

複数形を正とした理由: カンマ区切りで複数の管理者を書ける設計にしてあり、
設計書・実装・このログの全てが複数形で書かれているため。
単数形に合わせるより、環境変数側の1語を直す方が影響が小さい。

### `npx auth secret` の書き込み先

**`tenko\.env.local` に正しく書かれていた。** 他の場所には作られていない。

開発ルート配下の `.env` 系ファイルを全数検索した結果:

```
ablens\.env.example / ablens\.env.local
ec-app\.env / ec-app\.env.example
rag-kitei-qa\.env / rag-kitei-qa\.env.example
reservation-app\.env
style-diagnosis-app\.env.local
tenko\.env.local          ← 今回のもの
```

**開発ルート直下には無い。** 他は全て隣接プロジェクトのもので、**一切触っていない**。

`AUTH_SECRET` の中身の形式だけ確認した（値は見ていない）:
83文字、引用符なし、空白なし、`#` なし、英数字と `+/=_-` のみ。
`npx auth secret` の既定（44文字）より長いが、秘密鍵としては問題ない。

### `.gitignore`

```
.gitignore:34:.env*    .env.local     ← git check-ignore -v の出力
git ls-files .env.local → error: pathspec did not match any file(s) known to git（＝未追跡）
git log --all -- .env .env.local .env* → なし（＝履歴に一度も入っていない）
```

**無視されており、追跡されておらず、履歴にも存在しない。**

## B. セッションから email を落とした

`session` コールバックで `...session.user` の展開をやめ、**外に出す項目を列挙する形**にした。

`session.user.email` を参照している箇所は `src` 全体に**0件**だったため、他は壊れていない。
`npx tsc --noEmit` は 0 で通る。

### 実測中に見つけた、もっと重い問題（自分の実装のバグ）

`/api/auth/session` の応答を実際に見たところ、**セッショントークンがそのまま載っていた**。

```json
{"id":"1","userId":"1","expires":"...","sessionToken":"c52e00e2-…","user":{…}}
```

原因: DB方式では `session` コールバックが受け取る `session` は**セッションの行そのもの**であり、
`...session` と展開して返すと `sessionToken` が応答に含まれる。

危険度: Cookie を持つ本人にしか返らないため、他人には漏れない。
しかし **Cookie を httpOnly にしている意味を薄める**。
XSS が入った場合、`fetch("/api/auth/session")` でトークンを読み出せてしまう。
httpOnly はまさにそれを防ぐための設定である。

対処: `...session` の展開もやめ、`expires` と `user` だけを組み立てて返すようにした。

```json
{"expires":"2026-08-19T21:02:13.850Z","user":{"id":1,"displayName":"テスト太郎","role":"admin","name":"テスト太郎","image":null}}
```

**コードを読んでいるだけでは気づかなかった。** 応答を実際に見たから見つかった。

この応答からは同時に3つのことが確認できる:

- `email` が載っていない（POの判断どおり）
- `id` が**数値の 1**（文字列の `"1"` ではない。`Number()` が効いている）
- `expires` が **2026-08-19**（ログインは 08-13。**7日後。`maxAge` が効いている**）

## C. 段階2の実測（5項目）

実測の順序を工夫した。**先に「まだ登録されていない状態」で試す**ことで、
同じアカウントで「拒否」と「成功」の両方を確認できる。

### 実測前のDBの状態

```
[ログイン前] users=56(email入り 0 / 最大id 56) accounts=0 sessions=0 verification_token=0
```

### 2. 未登録のアドレスで拒否されること（最重要）

`users` の誰にもメールアドレスが入っていない状態で、Google でログインした。

- Google のアカウント選択 → 同意画面 → 「次へ」
- 結果: **`http://localhost:3000/login?error=AccessDenied` に戻った。**
  画面には「このアプリは、あらかじめ登録された方だけが使えます」が出た

サーバのログ:

```
[auth][error] AccessDenied: AccessDenied.
    at handleAuthorized (…@auth_core…:1376:28)
    at async Module.callback (…)
GET /api/auth/callback/google?… 302
```

**`handleAuthorized`（= signIn コールバック）で止まっている。**

拒否の直後のDB:

```
[未登録での拒否のあと] users=56(email入り 0 / 最大id 56) accounts=0 sessions=0 verification_token=0
```

**4つの表すべてで1行も増えていない。最大idも 56 のまま。**

設計書で「実装の順序から、そうなるはず」としていた
（`handleAuthorized` が `handleLoginOrRegister` より前に走る）ことが、**実測で裏付けられた**。

### 4 → 1 → 3. 既存の行に紐づけてログインし、admin になること

既存の `users` の1行（**id=1「テスト太郎」/ role=member**）にアドレスを紐づけた
（`scripts/link-user-email.js`。アドレスは `.env.local` から読み、画面には出さない）。

```
変更前: id=1 テスト太郎 role=member email=なし is_demo=false
変更後: id=1 テスト太郎 role=member email=あり
```

id=1 を選んだ理由: `TENKO_DEV_USER_ID` の既定であり、村の既存データが最も多い行のため。
**role は member のままにした。** admin へ変えるのは `signIn` の仕事であり、
先に admin にしてしまうと昇格が起きたのか元からそうだったのか区別できないため。

この状態でもう一度ログインした結果:

- **同意画面は出ず、そのまま `http://localhost:3000/`（村）に戻った** → ログイン成功
- サーバのログ: `[auth] id=1 を admin にした（TENKO_ADMIN_EMAILS による）`

```
[ログイン成功のあと] users=56(email入り 1 / 最大id 56) accounts=1 sessions=1 verification_token=0
  id=1 テスト太郎 role=admin email=あり is_demo=false
```

読み取れること:

| # | 項目 | 結果 |
|---|---|---|
| 1 | Google でログインできる | **できた**（村に戻った） |
| 3 | 環境変数で指定したアドレスが `admin` になる | **なった**（member → admin。ログにも1行出た） |
| 4 | 既存の `users` に紐づく | **紐づいた。`users` は 56 のまま増えていない**（最大idも 56）。`accounts` が1行できて既存の行に繋がった |

### 5. `OAuthAccountNotLinked`

**出なかった。** `allowDangerousEmailAccountLinking: true` が意図どおり働き、
既存の `users` の行に `accounts` が紐づいた（`users` が増えていないことがその証拠）。

設計書で「仮説」としていた項目は、**「この設定を付けた状態では出ない」ことが実測で確定した**。
外した場合に出るかどうかは**未検証のまま**である（確認のために危険側の設定へ倒す価値は無いと判断した）。

### Cookie の実測

`Set-Cookie` を実際に見た:

```
authjs.csrf-token   : Path=/; HttpOnly; SameSite=Lax
authjs.callback-url : Path=/; HttpOnly; SameSite=Lax
```

`Secure` が付いていないのは `http://localhost` のため（**本番の https では自動で付く**）。
**ローカルでは再現しない項目**であり、本番デプロイ時に確認する必要がある。

### 実データが入った状態での、漏れの再検査

`users` に**実際のメールアドレスが1件入った状態**で、13経路の応答をもう一度検査した。

```
漏れ・失敗: 0 件 / 13 経路
```

最初の検査は「DBに email が1件も無い状態」だったため、
**値が入ってからの再検査で初めて意味のある確認になった。**

## D. ローカルでは再現しないこと（再掲・追加）

- **Cookie の `Secure` 属性**: http のため付かない。本番でのみ確認できる
- **別ドメイン間の Cookie**: Vercel と Railway に分かれたときの挙動（段階6の論点）
- **`AUTH_URL` の自動検出**: Vercel 上でのみ効く経路がある
- **Google の同意画面**: 2回目以降は出ない。初回だけの挙動は、別のアカウントでしか再確認できない

## E. この作業で変わったDBの状態（POに申し送り）

| 変わったもの | 内容 | 戻し方 |
|---|---|---|
| `users` id=1「テスト太郎」 | `email` が入り、**role が member → admin になった** | `node scripts/link-user-email.js 1 --unlink` と `UPDATE users SET role='member' WHERE id=1` |
| `accounts` | 1行（id=1 と Google の紐づけ） | `DELETE FROM accounts WHERE "userId"=1` |
| `sessions` | 1行（**いまブラウザがログイン状態**） | `DELETE FROM sessions` でログアウトさせられる |

**id=1 が admin になった点に注意。** 噴水のお知らせを書ける人が1人増えている。
別の行を本人にしたい場合は、上の戻し方で外してから紐づけ直せる。

## F. 段階3に向けて新たに分かったこと

1. **`session` コールバックで展開してはいけない**。DB方式では `session` はセッションの行そのもの。
   段階3で `requireActor()` を書くときも、**セッションの中身をそのまま返す実装にしない**
2. ログイン後も村は今までどおり動いた（既存のAPIは `actor.ts` のままで無変更のため）。
   画面には「お試し版・ログインなし（誰にでもなりすませます）」の帯が出たままである。
   **段階3でこの帯を外す**（外す前に外すと、実態と表示が食い違う）
3. `/api/me` が role=admin を返すようになったため、噴水の書き込み欄が出る。
   段階3以降の確認では「id=1 は admin である」を前提にすること

## G. 現時点で答えを持たない事項（更新）

| 事項 | 区分 | 内容 |
|---|---|---|
| `OAuthAccountNotLinked` が設定を外すと出るか | **未検証** | 付けた状態では出ないことは確定した。外した場合は試していない |
| 本番（別ドメイン・https）での Cookie の挙動 | **未検証** | ローカルでは再現しない。段階6の spike と本番デプロイで確認する |
| Vercel → Neon のセッション確認の実遅延 | **要実測** | ローカルの往復では意味のある数字にならない。段階3の完了時に本番相当で測る |
| 2人目以降の利用者を登録する手順 | **未整備** | いまは `scripts/link-user-email.js` で1行ずつ紐づける。管理画面は Phase 5 の範囲外 |
| セッションが7日で切れる挙動 | **未検証** | `expires` が7日後になっていることは確認したが、**切れた瞬間の挙動は時間を進めないと見られない**。段階3で `sessions` の行を直接古くして確認する |

---

# 2026-08-13（続き）段階3: `actor.ts` の差し替えと全経路の認証

## A. 作業1-2: `actor.ts` を経由していない経路の一覧（全数検索の結果）

`src/` 全体を機械的に検索した。**利用者を決めている箇所は、以下ですべてである。**

| 場所 | どう決めていたか | 区分 |
|---|---|---|
| `src/lib/actor.ts` | `requestedUserId(raw)`。`?user=` / `body.user` を信用。`TENKO_TRUST_USER_PARAM=0` なら固定値 | 本体 |
| **`src/app/api/rooms/[roomId]/messages/route.ts`** | **独自に `const CURRENT_USER_ID = Number(process.env.TENKO_DEV_USER_ID ?? 1)`** | **actor.ts を経由していない** |
| `src/app/village-client.tsx` | `devUser()`。URL の `?me=` を読む | 画面側 |
| `src/app/attendance/page.tsx` | `actorId()`。URL の `?me=` を読む | 画面側 |
| `src/app/approvals/page.tsx` | `actorId()`。URL の `?me=` を読む | 画面側 |

`src/app/rooms/[id]/page.tsx`（チャット画面）は利用者を決めていなかった（サーバー側の定数に任せていた）。

**actor.ts を経由していなかったのは messages の1経路のみ。** これは段階2の報告で挙げた懸念のとおりだった。
発言は勤怠の下書きの根拠になるため、ここが漏れると勤怠まで偽装できる。**最初に潰した。**

## B. 差し替えの方針

`requestedUserId(raw)` を廃止し、**引数を取らない** `currentActor()` に置き換えた。

```
export async function currentActor(): Promise<Actor | null>
```

- **引数が無いので、リクエストから利用者IDを渡す経路が構文の上で存在しない。**
  「うっかり `body.user` を渡す」ことが型の上でできない
- **役割はセッションから取らない。毎回 `users` を引き直す。**
  セッションに載せた `role` は画面の分岐にしか使わない。降格が即座に効く
- `deleted_at IS NULL` と `is_demo = false` もここで確認する
- 書き込みの経路には `assertSameOrigin(req)` を入れた（CSRF対策の2層目。
  1層目は Cookie の `sameSite=lax`。それに頼らず Origin も確かめる）

## C. 作業3: 全経路の実測（未認証 / なりすまし / 権限）

**1経路ずつ差し替え、その都度 `scripts/attack-phase5-auth.js` で実際に送って確認した。**
まとめて差し替えてから最後に試す進め方はしていない。

確認用のセッションはDBに直接作る（Auth.js のアダプタが作るのと同じ形）。
5つの役割（admin / member / 担当の上長 / 無関係な member / 別の上長）で叩き分け、終わったら消す。

| 経路 | 未認証 | なりすまし | 権限 |
|---|---|---|---|
| `/api/me` | **401** | `?user=2` を添えても `id=1`（自分）が返る | member でも自分の分は取れる（200） |
| `/api/village` | **401** | `?user=他人` の応答が自分の応答と**完全に同一** | — |
| `/api/notes`（自分） | **401** | `?user=admin&mine=1` でも自分の分しか返らない | — |
| `/api/notes` PUT / DELETE | **401** | member が `user=admin` を添えても admin の note は**変わらない** | — |
| `/api/notes`（全員分） | 200（意図どおり開放。段階4で絞る） | — | — |
| `/api/announcements` GET | **401** | — | — |
| `/api/announcements` POST | **401** | `body.user=admin` を添えても **403** | member **403** / manager **403** / admin 201 |
| `/api/rooms/1/messages` GET | **401** | — | — |
| `/api/rooms/1/messages` POST | **401**（かつ messages は 11→11 で増えない） | `user`/`userId` に admin を添えても、**保存された `user_id` はセッションの人（2）** | — |
| `/api/attendance/drafts` | **401** | `?user=他人` の応答が同一。他人の下書きの混入 **0件** | — |
| `/api/attendance/drafts/[id]` | **401** | 他人の下書きを確定しようとして **409**、`status` は `pending` のまま | — |
| `/api/attendance/approvals` | **401** | `?user=admin` を添えても **403** | member **403** |
| `/api/attendance/approvals/[id]` | **401**（`status` は `submitted` のまま） | — | 本人 **403** / 無関係 member **403** / 別の上長 **403** / **担当の上長のみ 200** |
| `/api/attendance/corrections` GET | **401** | `?user=admin` の応答が同一 | — |
| `/api/attendance/corrections` POST | **401** | — | — |
| `/api/attendance/anomalies` | **401** | `?user=admin` を添えても `actor.id` は自分（4） | `?target=他人` で **403** |
| `/api/attendance/monthly` | **401** | — | 無関係な member が他人の分を取ると **403**。自分の分は 200 |
| `/api/rooms` | 200（開放。建物を描くのに要る） | — | — |
| `/api/users` | 200（開放。表示名だけ。**email を含まないことを確認**） | — | — |

```
結果: OK 45 件 / 通ってしまった 0 件
```

**通ってしまったものは1件も無い。** 差し替えの途中でも、各段階で通ったものは無かった。

## D. 作業1-3: `verify-auth-coverage.js`

人の注意力に頼らず、機械で抜けを見つける。`scripts/` に置き、`src/` からは参照していない。

落ちる条件:

1. `src/` に `SELECT *` / `RETURNING *` がある
2. API の経路が `currentActor()` も「開放」の宣言も持っていない
3. 書き込み（POST/PUT/DELETE/PATCH）の経路が `currentActor()` を呼んでいない
4. 書き込みの経路が `assertSameOrigin()` を呼んでいない
5. `requestedUserId` / `TENKO_DEV_USER_ID` / `TENKO_TRUST_USER_PARAM` / `?me=` / `?actor=` / `devUser()` が残っている

**開放してよい経路はスクリプトの中に一覧で持つ。書かれていないものは閉じているのが既定。**
新しいAPIを足したとき、どちらも書かなければ落ちる。

実行結果:

```
調べたファイル: 39 件（うち API の経路 15 件）
未認証で開放している経路（既定は閉じている）:
  - src/app/api/rooms/route.ts
  - src/app/api/users/route.ts
  - src/app/api/notes/route.ts
  - src/app/api/auth/[...nextauth]/route.ts

  [認証] src/app/api/announcements/route.ts
  [認証] src/app/api/attendance/anomalies/route.ts
  [認証] src/app/api/attendance/approvals/route.ts
  [認証] src/app/api/attendance/approvals/[id]/route.ts
  [認証] src/app/api/attendance/corrections/route.ts
  [認証] src/app/api/attendance/drafts/route.ts
  [認証] src/app/api/attendance/drafts/[id]/route.ts
  [認証] src/app/api/attendance/monthly/route.ts
  [開放] src/app/api/auth/[...nextauth]/route.ts
  [認証] src/app/api/me/route.ts
  [開放] src/app/api/notes/route.ts
  [開放] src/app/api/rooms/route.ts
  [認証] src/app/api/rooms/[roomId]/messages/route.ts
  [開放] src/app/api/users/route.ts
  [認証] src/app/api/village/route.ts

問題なし
```

`SELECT *` は 0 件。段階1で確認したとおり、アプリ側は列を明示している。

## E. 作業2: `village-client.tsx` の差し替え

**`devUser()` は削除した。** 参照を減らしただけではない。関数そのものが無い。
`attendance/page.tsx` と `approvals/page.tsx` の `actorId()` も同様に削除した。

確認（`verify-auth-coverage.js` の検査5に含めてある）:

```
src/ 全体で devUser / actorId / ?me= の読み取り: 0 件
```

誰として村にいるかは `page.tsx`（Server Component）が `currentActor()` で決め、props で渡す。
渡すのは `{ id, name, role, colorIndex }` だけ。**色も利用者IDから決める**（画面側で選ばせない）。

未ログインなら `null` を渡す。画面側は `isGuest` として扱い、
自分の情報を取る要求（`/api/village`・`/api/announcements`・`/api/notes?mine=1`）を出さず、
WebSocket に在席の申告（`presence.set`）も送らない。

**ただし、これは体験のためであって担保ではない。** WS を直接叩けば在席は申告できる（段階6で塞ぐ）。

## F. 作業3の副産物: チャット画面で見つけた不具合

`src/app/rooms/[id]/page.tsx` の送信の待ち行列に、こういう行があった。

```ts
// 4xx は送り直しても通らないので行列から外す。5xx と通信断は残して再送する
ok = res.ok || (res.status >= 400 && res.status < 500);
```

認証が入るまで 401 は返らなかったので、これで正しかった。
**認証が入った後は、ログインしていない人が書いた文が「送り直しても通らない」と判定され、黙って消える。**

401 だけを別扱いにし、行列に残したまま「ログインが必要です（書いた N 件は消さずに残してあります）」を出す形にした。

**認証を入れることで、認証と直接関係のない箇所の前提が崩れた例。** 他にも同種の箇所がないか、段階4で見る。

## G. 未ログインで村を開いたときの挙動（段階4の土台）

実機で確認した（スクリーンショットあり）。

| | ログイン後 | 未ログイン |
|---|---|---|
| ヘッダ | 表示名（テスト太郎） | **「見るだけ（ログインしていません）」＋ ログインボタン** |
| 村・建物・地面・装飾 | 見える | **見える** |
| 自分のアバター | 出る（金の枠・「あなた」） | **出ない** |
| 噴水 | 「お知らせ 5」（未読の数） | 「お知らせ」（**数は出ない。中身も見えない**） |
| 勤怠の印 | 「勤怠 1」 | 出ない |
| メンバー | 1/56 | 0/56 |

**村の絵は完全に描かれる。** 建物・道・噴水・装飾はすべて見える。
いま人がいないのは、デモ用の利用者がまだ接続を持たないため（**段階5で常設する**）。

段階4で残っている作業:
- `/api/notes` をデモ用の利用者の分だけに絞る
- 噴水を押したときの「ログインすると読めます」
- `TENKO_PUBLIC_VIEW=0` の切り替え
- `proxy.ts`（体験のための層。**担保にはしない**）

## H. 作業4-1: `verify-phase4-permissions.js` を直した

2つ直した。

1. **セッションで叩く形にした**（`?user=` / `body.user` が読まれなくなったため）
2. **何度実行しても同じ結果になるようにした。**
   以前は固定のUUIDで投稿を作ってから `messages.user_id` を書き換えており、
   2回目の実行で `(user_id, client_msg_id)` の一意制約に当たって途中で止まっていた。
   UUID を毎回生成し、**部下として発言し部下として確定する**（後から書き換えない）形にした

**3回続けて実行し、同じ結果・exit 0 を確認した。**

```
=== 承認を試みる（記録は部下のもの）===
  本人(member)                   -> status=403 記録=submitted 「承認できるのは manager か admin のみです」
  無関係な member                  -> status=403 記録=submitted 「承認できるのは manager か admin のみです」
  別の上長(manager・担当外)            -> status=403 記録=submitted 「この利用者の承認者ではありません」
  担当の上長(manager)               -> status=200 記録=approved

=== 一覧の見え方 ===
  無関係な member          -> status=403 件数=-
  別の上長                 -> status=200 件数=0
  担当の上長                -> status=200 件数=0
  管理者(admin)           -> status=200 件数=1

=== 未認証で一覧を取れるか ===
  Cookie なし -> status=401 {"error":"ログインが必要です"}

=== 他人の記録を本人として再提出できるか（なりすまし）===
  無関係な member が再提出 -> status=403 {"error":"自分の記録ではありません"}
```

## I. 作業4-2: 「お試し版」の帯をどうしたか

**差し替えた。** 消さずに、意味を変えた。

- 段階2まで: 「お試し版・ログインなし（誰にでもなりすませます）」を**常時**表示
- 段階3から: **未ログインのときだけ**「見るだけ（ログインしていません）」＋ログインボタン。
  ログイン後は表示名を出す

判断の理由:

- 認証が入った以上、「誰にでもなりすませます」は**事実と違う**。事実でない警告は、他の警告の信用も落とす
- ただし帯そのものを消すと、未ログインの人が「なぜ自分のアバターが出ないのか」が分からない。
  **状態を示す表示としては残す必要がある**
- 段階4で見るだけモードを整えるまで、未ログインの見え方は未確定である。
  そのため文面は「見るだけ」という**事実の記述**に留め、価値判断（お試し版・本番では使えない）を外した

**WS の穴（在席の偽装）はまだ残っている。** これは画面の帯ではなく README に書いた
（利用者に見せる情報ではなく、開発者が知るべき情報のため）。

## J. 破壊試験（新規2項目を含む）

| 試験 | 結果 | 出典 |
|---|---|---|
| WebSocket 経由で投稿を保存できない | **保たれている**（messages 20 → 20） | `attack-presence.js` |
| 承認済みの勤怠記録が変更できない | **保たれている**（UPDATE×2・DELETE すべて例外。行は残存） | `verify-freeze.js` |
| 確定・却下済みの下書きが変更できない | **保たれている**（同上） | `verify-freeze.js` |
| 他人の勤怠記録を承認できない（4通り） | **保たれている**（本人403 / 無関係403 / 別の上長403 / 担当の上長のみ200） | `verify-phase4-permissions.js` |
| 他人の在席状態を変更できない | **まだ通る（S6）。段階6で塞ぐ** | `attack-presence.js` |
| 他人のアバターを移動できない | **保たれている**（被害者は動かない） | `attack-phase48.js` |
| `member` がお知らせを書き込めない | **保たれている**（member 403 / manager 403 / admin 201） | `attack-phase5-auth.js` |
| **他人になりすまして発言できない（新規）** | **保たれている。** `user`/`userId` に他人のIDを添えても、保存された `user_id` はセッションの人 | `attack-phase5-auth.js` |
| **未認証で書き込み系のAPIを叩けない（新規）** | **保たれている。** POST/PUT/DELETE すべて 401。投稿は保存もされない | `attack-phase5-auth.js` |

あわせて確認できたもの（回帰）: 定員超過で建物に入れない（4/4で断り）/
呼びかけの連打制限（15回中0回通過）/ 不正な座標の扱い / 呼びかけに名前が含まれない。

### 段階3で変わった破壊試験の結果が1つある

`attack-presence.js` の「他人の『今日やること』を書き換えられるか」が
**200 → 401 に変わった**（書き換えられなくなった）。スクリプト内の説明文はまだ
`TENKO_TRUST_USER_PARAM=0 にすれば塞がる` と書いてあるが、この変数自体が廃止された。
測定結果は正しいので、文面の更新は段階4でまとめて行う。

### 既存の攻撃スクリプトのうち、HTTP を叩く部分について

`attack-phase45.js` と `attack-phase49.js` は `?user=` / `body.user` で誰かを名乗る作りのため、
**HTTP を叩く部分は今後 401 / 403 しか返さない**（＝守られていることの確認にはなるが、
本来調べたかった「その先の挙動」は調べられない）。
同じ範囲は `attack-phase5-auth.js` と `verify-phase4-permissions.js` がセッションで確認しており、
そちらは通っている。**書き換えは段階4に回す**（今回の範囲外の変更を混ぜないため）。

## K. 段階4以降に向けて分かったこと・懸念

1. **認証を入れると、認証と関係のない箇所の前提が崩れる**（F節のチャットの401）。
   段階4で「4xx をまとめて扱っている箇所」を全数検索する
2. **ログアウトの導線が無い。** いまブラウザからログアウトする手段が画面に無く、
   確認のためにDBのセッション行を消した。段階4で付ける
3. `/api/notes` の全員分は、いま**全員の業務内容が未認証で読める**。
   POの判断（デモ用の利用者の分だけ）は**まだ実装していない**。段階4の最初にやる
4. 未ログインの村に人が1人もいない。デモ用の利用者の常設（段階5）まで、
   見るだけモードは「空っぽの村」に見える。**段階4と段階5は続けて行うほうがよい**
5. `proxy.ts` はまだ作っていない。作らなくても各経路で検証しているため穴は無い。
   段階4で「体験のための層」として入れる

## L. この作業で変わったDBの状態（POに申し送り）

| 変わったもの | 内容 |
|---|---|
| `sessions` | **0件。** 未ログインの見え方を確認するため、ブラウザのセッションを消した。**POは再ログインが必要**（`/login` から1クリック） |
| `users`「検証 部下」等5人 | 確認スクリプトが役割と上長を設定し直している（従来どおり） |
| `attendance_records` | 確認用の記録が数件増えた（対象は「検証 部下」。承認済みは消せないため残る） |
| `messages` | 確認用の投稿が数件増えた |

## M. 現時点で答えを持たない事項（更新）

| 事項 | 区分 | 内容 |
|---|---|---|
| WebSocket の在席の偽装 | **既知の穴（S6）** | 段階6で塞ぐ。設計は済んでいる（入場券方式）が未実装 |
| セッションが7日で切れた瞬間の挙動 | **未検証** | `expires` が7日後になることは確認済み。切れた瞬間は時間を進めないと見られない。`sessions` の行を古くして試すのは段階4に持ち越した |
| 本番（別ドメイン・https）での Cookie の挙動 | **未検証** | ローカルでは再現しない |
| Vercel → Neon のセッション確認の実遅延 | **要実測** | `currentActor()` は毎回 `auth()`（2クエリ）＋ `users` の1クエリを引く。**1リクエストあたり3クエリになった**。ローカルでは体感差が無いが、本番で測る必要がある |
| `assertSameOrigin` が Vercel の背後で正しく働くか | **仮説** | `Origin` と `Host` を比べている。プロキシが `Host` を書き換える構成では誤判定しうる。本番デプロイ時に確認する |
| 4xx をまとめて扱っている他の箇所 | **未調査** | F節と同じ形の不具合が他にある可能性。段階4で全数検索する |

---

# 2026-08-13（続き）段階4-5: 見るだけモードとデモ用の利用者

## A. 作業1: 4xx をまとめて扱っている箇所の全数検索

段階3で宣言した作業。`src/` を機械的に検索し、**7か所**見つけた。

| # | 場所 | 扱い | 認証導入後に問題が起きるか | 対応 |
|---|---|---|---|---|
| 1 | `rooms/[id]/page.tsx:129` 送信の待ち行列 | `ok = res.ok \|\| (4xx)` | **起きた**（書いた文が黙って消える） | 段階3で修正済み |
| 2 | `village-client.tsx` `loadVillage()` | `if (!res.ok) return` | **起きる。** セッションが切れても黙って古い未読・下書きを映し続ける | **直した**（下記） |
| 3 | `village-client.tsx` `loadAnns()` | 同上 | **起きる。** 同上（お知らせの未読数が止まる） | **直した** |
| 4 | `village-client.tsx` `loadNotes()` | 同上 | 起きない。開いている経路で 401 が返らない | そのまま |
| 5 | `rooms/[id]/page.tsx:65` `fetchDrafts()` | 同上 | 起きない。同じ画面の `fetchSince()` が 401 を拾って知らせる | そのまま |
| 6 | `village-client.tsx` `saveNote()` / `postAnn()` | `!res.ok` → サーバーの文言を出す | 起きない。401 なら「ログインが必要です」と出る | そのまま |
| 7 | `approvals/page.tsx` `load()` / `act()` | 同上 | 起きない。同上 | そのまま |

**直した2件（2・3）の考え方:**

401 を黙って捨てると、**画面は開いたまま、古い情報を映し続け、操作だけが通らない**状態になる。
段階3のチャットと同じ形の失敗である。`noteSessionLost(status)` を通し、
401 を受けたらヘッダに帯を出す。

> ログインの期限が切れました ［入り直す］

**「認証と無関係に見える箇所」ほど危険**という段階3の観察は、村の取得にもそのまま当てはまった。

## B. 作業2: 見るだけモードの完成（段階4）

### 開放した経路と、実測した応答

分岐は `src/lib/public-view.ts` の1か所に集めた。開放は**4本のみ**。

| 経路 | 未認証に返すもの | 応答の実測（未認証） |
|---|---|---|
| `/api/rooms` | 建物の一覧（名前・種別・定員・飾り） | 200 / 460 バイト |
| `/api/users` | **デモ用の利用者の表示名だけ** | 200 / 2258 バイト |
| `/api/notes` | **デモ用の利用者の「今日やること」だけ** | 200 / 971 バイト |
| `/api/demo-presence`（新設） | デモ用の位置・状態・話しかけ可否 | 200 / 1682 バイト |

`scripts/attack-public-view.js` で実際に叩いて確認した（**24件すべてOK / 通ったもの0件**）:

```
=== 1. 開いている経路の応答に、機微な情報が無いか
  OK   /api/rooms に機微な語が無い : status=200 len=460
  OK   /api/users に機微な語が無い : status=200 len=2258
  OK   /api/notes に機微な語が無い : status=200 len=971
  OK   /api/demo-presence に機微な語が無い : status=200 len=1682
=== 2. 実在の利用者が漏れていないか
  OK   実在の利用者の表示名が /api/users に出ない : 0 件
  OK   「今日やること」がデモ用の分だけ : デモ以外が 0 件（全 13 件）
```

検査した語: `email` / `@` / `manager_id` / `"role"` / `attendance` / `work_date`。
**実在の6人（テスト太郎・検証系5人）の表示名が1件も含まれないことを、名前そのもので突き合わせて確認した。**

### 実在の利用者の「名前」も絞った（設計から一歩進めた判断）

POの判断は「今日やること」についてのものだったが、**同じ理屈は表示名にも当てはまる**。
未ログインの人に実在の社員の氏名を配る理由が無い。`/api/users` はデモ用の分だけを返す。

結果として、ログイン中の実在の人が村にいると、**未ログインの画面では名前のないアバター**として見える。
このとき当初は「利用者1」と出ていた（実機で確認）。
**名前の代わりに利用者IDを配ることになる**ため、「メンバー」とだけ出す形に直した。

### 勤怠は読み取りも含めて全閉

```
  OK   未認証で /api/attendance/drafts が読めない : status=401
  OK   未認証で /api/attendance/approvals が読めない : status=401
  OK   未認証で /api/attendance/corrections が読めない : status=401
  OK   未認証で /api/attendance/anomalies が読めない : status=401
  OK   未認証で /api/attendance/monthly?year=2026&month=8 が読めない : status=401
  OK   未認証で /api/attendance/drafts/1 が読めない : status=405
  OK   未認証で /api/attendance/approvals/1 が読めない : status=405
  OK   勤怠の応答に中身が無い : {"error":"ログインが必要です"}
```

### `verify-auth-coverage.js` に検査を1つ足した

開放した経路が **`allowPublic()` を通っていること**を機械的に確かめる。
通っていなければ `TENKO_PUBLIC_VIEW=0` で止まらない経路が残るため。

```
  [開放] src/app/api/auth/[...nextauth]/route.ts
  [開放] src/app/api/demo-presence/route.ts
  [開放] src/app/api/notes/route.ts
  [開放] src/app/api/rooms/route.ts
  [開放] src/app/api/users/route.ts
  （他11経路は [認証]）
問題なし
```

## C. 作業3: `TENKO_PUBLIC_VIEW=0` の動作確認

環境変数を 0 にして dev を起動し、未認証で叩いた（**実測**）:

```
GET /              -> 307 /login   （村そのものを見せない）
GET /api/rooms     -> 401
GET /api/users     -> 401
GET /api/notes     -> 401
GET /api/demo-presence -> 401
```

**「建物だけ見える」のような中途半端な状態は作らなかった。**
何が公開されているかが分からなくなり、確認もできなくなるため（`public-view.ts` にも書いた）。

## D. 作業2: ログアウトの導線をどこに置いたか

**アバターのメニューの中、「退勤（村から消える）」の隣。**

判断の理由:

- ヘッダは**村の外の状態**（接続が切れている・見るだけである）を出す場所として使っている。
  自分に対する操作（状態を変える・今日やることを書く・退勤する）は、
  Phase 4.7 で**すべてアバターのメニューに集めた**。その方針を崩さない
- 「退勤」と「ログアウト」は意味が違う（村から消えるだけ／セッションを捨てる）が、
  **どちらも終わりの操作**である。並べて置くことで、その2つの違いを見比べられる
- ヘッダに置くと、村を見ている最中に常に目に入る。終わりの操作は探して見つかればよい

実装は `/api/auth/signout` へ CSRF トークン付きで POST し、
在席を消してから `router.refresh()` で描き直す（見るだけの村に変わる）。
**実機で押して確認した**（ログイン中の村 → 見るだけの村に変わった）。

## E. 作業3: デモ用の利用者の実装方法（段階5）

### 接続なしで村にいる仕組み

```
DB: demo_presence（user_id / state / talk / room_id / x / y / color_index）
      ↑ 段階1のDDLで作成済み。今回は行を入れただけで、DDLの追加は無い
  ↓ 60秒ごと
アプリ: GET /api/demo-presence （未認証で開いている）
  ↓
ws-server: demo[] に保持し、presenceList() で実際の接続に足して配る
```

- **デモ用のプロセスは動かさない。** Railway の枠を消費せず、落ちて村が空になることも無い
- 取得に失敗したときは**前の内容を使い続ける**。一時的に取れないだけで村が空になると、
  見るだけの人には壊れて見えるため
- `occupantsOf()` にもデモ用を数える。数えないと**建物の人数表示と定員の判定が食い違う**
- `freeSpot()` / `nudge()` もデモ用を避ける。重なると下になった人を選べなくなる
- 配信には `demo: true` を付ける。画面が「この人はデモ用」と分かるようにするため

### 村に出した人数と内訳

```
デモ用にする: 50 人
デモ用にしない: 1:テスト太郎, 2:検証 部下, 3:検証 上長, 4:検証 無関係, 5:検証 別上長, 6:検証 管理者
そのうち村に出す: 20 人

  状態: idle 9人 / away 3人 / resting 2人 / talking 6人
  話しかけて: ok 8人 / later 9人 / focus 3人
  今日やること: あり 13人 / なし 7人
  「オフィス」に 2人（定員 4）
  「会議室」に 2人（定員 4）
  「開発」に 1人（定員 4）
  「営業」に 1人（定員 4）
```

- **id=1（PO本人）はデモ用にしていない**
- **検証用の5人もデモ用にしていない。** デモ用はログインできないため、
  この5人をデモにすると確認スクリプトが動かなくなる（実行前に気づいた）
- 30人は「メンバー一覧には出るが村にはいない」（`is_demo` だが `demo_presence` の行が無い）

### 置き方で1つ直した

`geo.SPOTS` は「村の中心に近い順」に並んでいる。順に取ったところ、
**20人全員が中心の下側に固まり、村の上半分が空のままになった**（実機で確認）。
間隔を空けて取る形に変え、村全体に散らばらせた。

## F. 作業4: 見るだけの体験（実機で確認）

未ログインの状態で村を開いた（スクリーンショットあり）。

| 確認 | 結果 |
|---|---|
| 開いた瞬間、賑わって見えるか | **見える。** 20人が村全体に散らばり、吹き出しが8件出ている |
| 状態が色とラベルで分かるか | **分かる。** 足元のリング（在席=緑 / 休憩=黄 / 離席=灰）と「集中中」「後で」の札 |
| 吹き出しが読めるか | **読める。**「見積もりの作成」「外出（14時に戻ります）」「請求書のチェック」など |
| 建物の中に人がいると分かるか | **分かる。** 建物の下の帯が部分的に埋まり、窓が光っている（拡大して確認） |
| 噴水は押せるが中身は見えないか | **そのとおり。**「村のお知らせは、ログインすると読めます」＋ログインの導線 |
| 書き込む操作が一切できないか | **できない。** 自分のアバターが無いので操作のメニューが出ない。 他人を押しても「他の人の状態は変えられません」だけ。呼びかけの押しどころも出ない |
| ログインできると分かるか | **分かる。** ヘッダに「見るだけ（ログインしていません）」＋［ログイン］ |

### 「採用担当が初めて開いたときに、動いていると伝わるか」

**伝わると判断した。** 根拠:

- 人が20人いて、**状態が揃っていない**（在席・離席・休憩・会議中が混ざっている）。
  全員が同じ状態だと、置いてあるだけの絵に見える
- 吹き出しの中身が業務の言葉になっている（「月末の締め作業」「採用面談」）。
  村が何のためのものかが、説明を読まなくても伝わる
- 建物に人が入っていて、人数の帯が部分的に埋まっている。
  **「入れる箱」であることが、操作しなくても分かる**

**弱いと感じた点（正直に書く）:**

- **動きが無い。** デモ用の利用者は止まっている。開いて数十秒見ても何も変わらない。
  「リアルタイムに同期している」ことは、**自分がログインして動かしてみせるまで伝わらない**。
  設計時にPOが「リアルタイムであることは自分が動けば示せる」と判断したとおりだが、
  採用担当が**ログインせずに**閉じた場合、この主張は届かない
- 対策の案（**未実装。段階6の後に判断したい**）: デモ用の利用者を数分に1回だけ動かす、
  時刻に応じて状態を変える（昼は休憩が増える）など。
  ただし**常時動くプロセスは作らない**という制約は守る必要がある

## G. デモ用の利用者への呼びかけ・チャットの扱い

### 呼びかけ

**押せないようにした。** 押せてしまうと「返事が来ない＝壊れている」に見える。

- 画面: デモ用の人を押すと、呼びかけの押しどころの代わりに説明を出す
  > この人は、村の様子を見せるために置いてあるデモの利用者です。呼びかけても返事はしません。
- ws-server: 画面の分岐は担保にならないため、**サーバー側でも断る**
  > この人は村の様子を見せるために置いてあるデモの利用者です。返事はしません

### チャット

**部屋（建物）は今までどおり誰でも入れる。** 部屋はデモ用の利用者に紐づいていないため、
「デモの人とのチャット」という状態がそもそも存在しない。

判断: **1対1のチャットは tenko に無い**（会話は部屋単位）。
デモ用の利用者に話しかける経路は呼びかけだけで、そこは上のとおり塞いだ。
部屋に書き込んでも返事が来ないのは、**人がいない部屋に書いたときと同じ**であり、
デモ用の利用者に固有の不自然さは生じない。

## H. 破壊試験（新規3項目を含む）

| 試験 | 結果 | 出典 |
|---|---|---|
| WebSocket 経由で投稿を保存できない | **保たれている**（messages 23 → 23） | `attack-presence.js` |
| 承認済みの勤怠記録が変更できない | **保たれている**（UPDATE×2・DELETE すべて例外） | `verify-freeze.js` |
| 確定・却下済みの下書きが変更できない | **保たれている** | `verify-freeze.js` |
| 他人の勤怠記録を承認できない（4通り） | **保たれている**（403/403/403/担当の上長のみ200） | `verify-phase4-permissions.js` |
| 他人のアバターを移動できない | **保たれている** | `attack-phase48.js` |
| `member` がお知らせを書き込めない | **保たれている** | `attack-phase5-auth.js` |
| 他人になりすまして発言できない | **保たれている** | `attack-phase5-auth.js` |
| 未認証で書き込み系のAPIを叩けない | **保たれている**（7経路すべて401。投稿も保存されない） | `attack-public-view.js` |
| **未認証で勤怠の記録を読めない（新規）** | **保たれている**（7経路すべて401/405、応答に中身が無い） | `attack-public-view.js` |
| **未認証で実在の利用者の「今日やること」を読めない（新規）** | **保たれている**（デモ以外 0 件 / 全13件） | `attack-public-view.js` |
| **デモ用の利用者としてログインできない（新規）** | **保たれている。** DBの制約でメールアドレスを付けられず、仮にセッションを作っても `currentActor()` が弾く | `attack-public-view.js` |
| 他人の在席状態を変更できない | **まだ通る（S6）。段階6で塞ぐ** | `attack-presence.js` |

集計: `attack-public-view.js` 24件 / `attack-phase5-auth.js` 45件 / `verify-freeze.js` 6件、
**通ってしまったもの 0 件**。`verify-auth-coverage.js` も「問題なし」。

### デモ用の利用者としてログインできないことの担保は2重

1. **DBの制約**: `users_demo_has_no_email`（`is_demo = true` なら `email` は NULL）。
   実際に UPDATE を試して例外を確認した
   ```
   new row for relation "users" violates check constraint "users_demo_has_no_email"
   ```
2. **アプリ**: `currentActor()` が `is_demo` を弾く。
   セッション行を直接作って `/api/me` を叩き、401 を確認した

## I. 段階6（WebSocket）に向けて分かったこと・懸念

1. **デモ用の利用者は、入場券の検証の対象外になる。**
   接続を持たないので券も持たない。`presenceList()` に足す経路は
   **ws-server の内側**であり、外から名乗る経路ではない。設計は変えなくてよい
2. **`/api/demo-presence` を ws-server が叩く。** 段階6で入れる `/api/ws-verify` と合わせ、
   ws-server → アプリの経路が2本になる。**まとめて1本にするか**は段階6で判断する
3. **見るだけの接続をどう数えるか。** いま ws-server は接続してきた全員に
   `presence.list` を配る。段階6で「券の無い接続＝見るだけ」と決めたとき、
   **見るだけの接続が何本あっても村の人数は増えない**ことを確認する必要がある
4. `attack-presence.js` の「他人の在席を変える」はまだ通る。
   **段階6の完了条件は、この試験が通らなくなること**である

## J. この作業で変わったDBの状態（POに申し送り）

| 変わったもの | 内容 | 戻し方 |
|---|---|---|
| `users.is_demo` | **50人を true にした**（id=1 と検証用5人を除く全員） | `node scripts/seed-demo.js --undo --apply` |
| `demo_presence` | **20行**（村に出す人） | 同上 |
| `daily_notes` | デモ用13人分の「今日やること」を入れた | 同上では消えない（当日分のみ。翌日には出なくなる） |
| `sessions` | **POのログインを復旧した。** 見るだけの確認のため一度ログアウトし、確認後に入り直した | — |

**id=1「テスト太郎」はデモ用にしていない。** role=admin のまま、emailも紐づいたまま。

## K. 現時点で答えを持たない事項（更新）

| 事項 | 区分 | 内容 |
|---|---|---|
| デモ用の利用者が動かないこと | **未解決（判断待ち）** | 見るだけで開いた人には「リアルタイム」が伝わらない。F節に案を書いたが未実装 |
| WebSocket の在席の偽装 | **既知の穴（S6）** | 段階6で塞ぐ |
| 見るだけの接続の数え方 | **未検証** | 段階6で確認する（I節3） |
| セッションが7日で切れた瞬間の挙動 | **未検証** | 帯を出す仕掛けは入れたが、**実際に切らして試してはいない**（`sessions.expires` を過去にすれば試せる。段階6で行う） |
| 本番（別ドメイン・https）での Cookie の挙動 | **未検証** | ローカルでは再現しない |
| デモ用の利用者の「今日やること」が翌日消えること | **仕様。未対応** | `daily_notes` は日付ごと。**翌日に村を開くと吹き出しが全部消える。** 見るだけの価値が落ちる。段階6以降で「デモ用は日付を見ない」等の対応が要る |
| `assertSameOrigin` が Vercel の背後で正しく働くか | **仮説** | 本番デプロイ時に確認する |

---

# 2026-08-13（続き）段階6: WebSocket サーバーの認証

**S6（他人の在席を偽装できる）を塞いだ。** Phase 5 で唯一残っていた穴である。

## A. 作業0: デモの「今日やること」を日付から切り離した

`daily_notes` は日付ごとの表で、デモ用の吹き出しをそこに入れていた。
**日が変わると20人ぶんの吹き出しが全部消える**（段階4-5のスクリーンショットが翌日には再現しない）。

デモ用の利用者は「今日」を持たない存在なので、日付のある表に置くのが誤りだった。

DDL（追加のみ1文。ロールバックSQLは `scripts/apply-phase5-demo-note-ddl.js` に併記）:

```sql
ALTER TABLE demo_presence ADD COLUMN note TEXT;
-- 戻す場合: ALTER TABLE demo_presence DROP COLUMN IF EXISTS note;
```

段階4-5で入れた13人分の内容はそのまま写した（`daily_notes` から 13 件）。
取り出し方は「実在の人は `daily_notes`（日付ごと）／デモ用は `demo_presence.note`（日付なし）」に分けた。
**未認証にデモ用の分だけを返す担保（段階4）は壊していない**（`attack-public-view.js` で再確認済み）。

### 実測: 日が変わっても消えないこと

システムの時計は動かさず、**DBの `daily_notes.note_date` を1日前にずらして**「今日が明日になった」状態を作った。

```
いまの吹き出し: 13 件（うちデモ用 13 件）

=== 日が変わった状態を作る（daily_notes.note_date を1日前にずらす）===
日が変わったあとの吹き出し: 13 件（うちデモ用 13 件）
  例: 7:見積もりの作成 / 8:朝会の準備 / 9:請求書のチェック

=== 日付を元に戻す ===
戻した。daily_notes の最新日付=2026-08-13 / 今日=2026-08-13（一致: true）

判定: デモ用の吹き出しは日が変わっても 消えない（OK）
```

**日付は戻してある。** ただし1度目の実行で戻すのに失敗した:

```
ERR: duplicate key value violates unique constraint "daily_notes_user_date_uq"
```

全行を1文で1日動かすと、途中の行が別の行と同じ `(user_id, note_date)` になり一意制約に当たる。
**いったん遠い未来へ逃がしてから戻す2段の形**に直し、日付が今日に戻っていることを確認した。
確認スクリプト（`scripts/verify-demo-note-date.js`）も2段の形にしてある。

## B. 作業1: 設計書6節の訂正（3点）

`docs/PHASE5_AUTH_DESIGN.md` の6節を、スパイクの実測にもとづいて**節ごと書き直した**。

| # | 誤っていた記述 | 実測 | 直した内容 |
|---|---|---|---|
| 1 | 「base64url」とだけ書いていた | パディング（`=`）が1文字でも入ると、**ブラウザが `new WebSocket` の時点で `SyntaxError` を投げ、サーバには何も届かない** | 「**パディングを付けないこと**」を要件として明記。サーバ側では救えないことも書いた |
| 2 | 「期限切れなら `close(4003)`」とだけ書いていた | `handleProtocols` で `false` を返すと、ブラウザに届くのは **1006**。さらに **`ws` はサーバ側の `connection` を発生させる**（拒否したはずの接続が存在する） | 「**ハンドシェイクで断らない**」を明記し、分岐を `connection` に集める形に書き直した |
| 3 | 「応答の値を誤ると接続できない」 | **券を含む値を返しても普通に接続できる。** 接続できなくなるのは「何も返さない」場合だけ | 券を返さない理由を「壊れるから」から「**券が応答ヘッダに載るから**」に差し替えた |

誤り3は**結論は正しく、理由が誤っていた**例である。
誤った理由で正しい結論を守っている状態は、次に誰かが「別に繋がるじゃないか」と気づいた瞬間に崩れる。
変更ログにも、元の記述が誤りだったことを残した。

あわせて、PO判断（`/api/ws-verify` と `/api/demo-presence` を1本にまとめない）と、
再接続の方針を6節に取り込んだ。

## C. 作業2: `/api/ws-ticket`

**POST のみ・認証必須。** 応答の実測:

```
status=200
Cache-Control: no-store
応答の鍵: ticket, expiresIn
expiresIn: 60
券の長さ: 115 文字
券の文字種が base64url と . だけか: true
券に = が含まれるか: false
応答に含まれる禁止語: なし          ← email / @ / role / manager / displayName / name / admin / sessionToken
応答の全長: 143 バイト

Cookie なしで叩いた: status=401 {"error":"ログインが必要です"}
GET で叩いた: status=405
```

**券に入れる `sessionId` は、セッションの行の id（数字）であって、セッショントークンではない。**
トークンを ws-server に渡すと、券が漏れたときにアプリのセッションごと奪われる。
行の id なら「どのセッションか」を指すだけで、それ自体では何もできない。

## D. 作業3: ws-server の認証

### `protocols` を送らずに繋いだ場合の挙動（スパイクで未確認だった1点）

**実測した。`handleProtocols` は呼ばれない。**

段階6の ws-server を先に出し、**まだ券を送らない画面**（段階5のまま）で繋いだときのログ:

```
[open] viewer 見るだけ（券なし（見るだけ）） clients=1
[drop] 券の無い接続からの受信を捨てた: {"type":"presence.set","user":{"id":1,"name":"テスト太郎",…
[drop] 券の無い接続からの受信を捨てた: {"type":"presence.sync"}
```

**決めた扱い: 控えが無い接続は「券なし＝見るだけ」を既定とする。**
`handleProtocols` が呼ばれないのだから、控え（`pendingAuth`）に何も入らない。
`connection` 側で `?? { authed: false, … }` の既定値を置き、**認証済みに倒れる経路を作らない**。

あわせて**画面側は、券が無くても `"tenko.v1"` を必ず送る**ようにした。
送らないとサーバの判定が走らず、「なぜ見るだけなのか」がログから読めなくなるため。

### 判定の置き場所

`handleProtocols` は判定して覚えるだけ。応答は常に `tenko.v1`。
断るのは `connection` の中で `close(4003)` / `close(4004)`。
`message` は**他のどの判定よりも先に** `ws.authed` を見て、偽なら種別を問わず捨てる。

### 利用者IDの決まり方（S6 の本体）

```js
// 段階5まで
const uid = Number(u.id) || 0;      // ← 名乗ったIDをそのまま信じていた
// 段階6
const uid = ws.userId;              // ← 券から取る。msg.user.id は読まない
```

色も自己申告を読まず、利用者IDから決めるようにした（他人と同じ色を名乗って紛らわしくできたため）。

## E. 作業4: `/api/ws-verify`

**`/api/demo-presence` とは1本にまとめていない**（PO判断。失敗時の扱いが逆であるため）。
`setInterval` も別に回している。

失敗の段階は定数 `VERIFY_FAIL_WARN = 5` / `VERIFY_FAIL_CUT = 10`。
**10回の失敗を10分待たずに確かめられるよう、確認の間隔を環境変数
`TENKO_WS_VERIFY_INTERVAL_MS` で短くできるようにした**（既定は60秒）。

### 実測（`scripts/attack-ws-verify.js`）

```
=== 2. 接続中にセッションを無効にすると切られるか ===
  OK   正しい券で繋がる（対照） : opened=true
  セッションを消した。次の確認で切られるはず
  OK   無効になったセッションの接続が切られる : code=4001 reason=session revoked
  OK   切る前に auth.expired を送っている : 受け取った種別: presence.list, auth.expired

=== 3. 確認が10回続けて失敗すると切られるか ===
  OK   確認が失敗していても、はじめは繋がったまま : opened=true
  OK   連続10回の失敗で切られる : code=4001 reason=verify unavailable
  ws-server のログ（抜粋）:
    [verify] 確認できなかった（7回目）: fetch failed → 連続5回以上。新しい接続は受け続ける
    [verify] 確認できなかった（8回目）: fetch failed → 連続5回以上。新しい接続は受け続ける
    [verify] 確認できなかった（9回目）: fetch failed → 連続5回以上。新しい接続は受け続ける
    [verify] 確認できなかった（10回目）: fetch failed → 連続10回。認証済みの接続 1 本を切り、以後は見るだけ扱いにする
  OK   5回で警告、10回で切断のログが出ている : 警告 5 回 / 切断 1 回
  OK   確認ができない間は、券が正しくても村に載らない : 村の人数=0

=== 4. /api/ws-verify は共有秘密なしで答えるか ===
  OK   共有秘密なしでは 401 : status=401
  OK   違う共有秘密でも 401 : status=401
  OK   正しい共有秘密なら答える（対照） : status=200 {"valid":[],"invalid":[999999]}
```

**「アプリが落ちている」状態は、届かないポートを `TENKO_API` に指定して作った。**
確認用の ws-server は別ポート（8091/8092/8093）で起動し、本番の動作には影響させていない。

## F. 作業5・6: 画面側と、出す順序

**作業6の順序で確かめた。**

1. **ws-server を先に出す**（券があれば認証済み・無ければ見るだけの両対応）。
   このとき画面はまだ段階5のまま = 券を送らない。
   → **村は壊れなかった。** 建物・デモ用の20人・吹き出しはそのまま見え、
   ログインした人が村に出ないだけになる（メンバー 20/56）。
   **これがデプロイ時の安全弁になる**（ws-server を先に上げても、画面が古いまま村が死なない）
2. 次に画面を券つきに変える → `POST /api/ws-ticket 200` が出て、
   `[open] viewer 認証済み userId=1` になり、村に自分が出る（メンバー 21/56）

### 券の取り直しの実測

ws-server を落として起こし直したときの、アプリ側のログの数え上げ:

```
落とす前の ws-ticket の回数: 21
落として起こしたあとの ws-ticket の回数: 23
（新しい ws-server のログ）[open] viewer 認証済み userId=1 clients=1
```

**繋ぎ直しのたびに新しい券を取っている。** 券は使い捨てなので、これが必要な形である。

## G. 破壊試験の結果

| 試験 | 結果 | 出典 |
|---|---|---|
| **他人の在席状態を変更できない（S6。段階6の完了条件）** | **塞がった。** 下に出力を貼る | `attack-presence.js` |
| 券なしで `presence` に載れない | ✅ 券なしの申告は捨てられ、村に現れない | `attack-presence.js` |
| 期限切れの券で繋げない | ✅ `close(4003, ticket invalid)` | `attack-ws-verify.js` |
| 券を使い回して繋げない | ✅ `close(4003)` | `attack-presence.js` |
| 他人の券を横取りして使えない | ✅ **一度使われた券は使えない**（下に注記） | `attack-presence.js` |
| 券の `userId` を書き換えて繋げない | ✅ 署名が合わず `close(4003)` | `attack-presence.js` |
| `TENKO_PUBLIC_VIEW=0` で券なしが拒まれる | ✅ `close(4004, public view disabled)` | `attack-ws-verify.js` |
| 見るだけの接続からメッセージを送っても反映されない | ✅ 種別を問わず捨てられる | `attack-presence.js` |
| WebSocket 経由で投稿を保存できない | ✅ messages 23 → 23 | `attack-presence.js` |
| 承認済みの勤怠記録が変更できない | ✅ | `verify-freeze.js` |
| 確定・却下済みの下書きが変更できない | ✅ | `verify-freeze.js` |
| 他人の勤怠記録を承認できない（4通り） | ✅ | `verify-phase4-permissions.js` |
| 他人のアバターを移動できない | ✅ | `attack-phase48.js` |
| `member` がお知らせを書き込めない | ✅ | `attack-phase5-auth.js` |
| 他人になりすまして発言できない | ✅ | `attack-phase5-auth.js` |
| 未認証で書き込み系のAPIを叩けない | ✅ | `attack-public-view.js` |
| 未認証で勤怠の記録を読めない | ✅ | `attack-public-view.js` |
| 未認証で実在の利用者の「今日やること」を読めない | ✅ | `attack-public-view.js` |
| デモ利用者としてログインできない | ✅ | `attack-public-view.js` |

集計: `attack-presence` 12件 / `attack-ws-verify` 13件 / `attack-phase5-auth` 45件 /
`attack-public-view` 24件 / `verify-freeze` 6件 — **通ってしまったもの 0 件**。
`verify-auth-coverage.js` も「問題なし」。

### S6 が塞がったことの、実際の出力

```
被害者=2（検証 部下） 攻撃者=4（検証 無関係）
被害者の状態（攻撃前）: {"id":2,"colorIndex":2,"state":"idle","roomId":null,"talk":"ok","x":308,"y":350,"connections":1}

=== 1. 他人になりすまして在席を変える（S6。段階6の完了条件）===
  被害者の状態（攻撃後）: {"id":2,"colorIndex":2,"state":"idle","roomId":null,"talk":"ok","x":308,"y":350,"connections":1}
  攻撃者として村に出たもの: {"id":4,"colorIndex":4,"state":"away","roomId":null,"talk":"focus","x":352,"y":350,"connections":1}
  OK   他人の在席を変えられない : state=idle talk=ok（攻撃前と同じなら守られている）
  OK   名乗ったIDではなく、券の利用者として村に出る : 攻撃者 id=4 state=away

=== 2. 券なしで村に載れるか ===
  OK   券なしの接続は在席を申告できない : 被害者 state=idle
  OK   券なしの接続は村に現れない : 村の人数=23

=== 3. 見るだけの接続を何本張っても村の人数が増えないか ===
  OK   見るだけを5本足しても人数が変わらない : 23 -> 23

=== 4. 不正な券で繋げるか ===
  OK   同じ券を使い回して繋げない : opened=true code=4003 reason=ticket invalid
  OK   署名を書き換えた券で繋げない : code=4003 reason=ticket invalid
  OK   券の利用者IDを書き換えて繋げない : code=4003 reason=ticket invalid

結果: OK 12 件 / 通ってしまった 0 件
```

**段階5までは、同じ攻撃が通っていた**（「認証が無いため WS では防げない。これは既知の状態（S6）」と出ていた）。

### 「他人の券を横取りして使えない」の限界（正直に書く）

**使い回しは塞がっている**（一度使われた券は拒まれる）。
しかし**まだ使われていない券を60秒以内に盗めれば、その人として入れる。**
これは持参人式の券に共通の性質であり、緩和策は3つ:

1. 有効期限60秒
2. 使い捨て（一度使えば無効）
3. 券を取れるのは同一オリジンのログイン済みの人だけ

**盗まれる経路（XSS・端末の乗っ取り）が成立している時点で、セッションCookieも同時に危ない。**
券だけを特別に守っても意味がないため、ここは受け入れる。

### 試験スクリプト自身に見つかった問題

`attack-presence.js` を段階6の形に直したとき、**最初は3件が「通った」と出た**。
調べると、スクリプトが `open` イベントだけを見て「繋がった」と判定していた。
不正な券は**いったん受け入れてから閉じる**ため、開いた瞬間には成功に見える。
開いたあと少し待って判定する形に直したところ、すべて `4003` を捕まえられた。

**設計を「受け入れてから閉じる」に変えたことが、試験の書き方にも影響した例である。**

## H. `verify-auth-coverage.js` の結果

新設2経路を含めて確認した。

```
  [認証] src/app/api/ws-ticket/route.ts
  [認証:内部] src/app/api/ws-verify/route.ts
問題なし
```

`/api/ws-verify` は**利用者のセッションではなく共有秘密で守る**サーバ同士の経路である。
`currentActor()` を通らないため、検査に「内部の経路」の区分を足した。
素通しにならないよう、**共有秘密の確認が本当にあるか**（`x-tenko-internal` と
`TENKO_WS_INTERNAL_TOKEN` の両方が出てくるか）を機械的に見ている。

書き込みの経路に `assertSameOrigin` を求める規則からは、内部の経路を外した。
サーバ同士の通信には `Origin` が無く、代わりに共有秘密が守るためである。

## I. 段階7に向けて分かったこと・懸念

### Railway で `Sec-WebSocket-Protocol` が通らなかった場合に何が必要か

**デプロイ直後、最初に確認する項目とする。** 通らなかった場合に要るものを先に整理しておく。

| 症状 | 意味 | 必要な作り直し |
|---|---|---|
| ブラウザが `1006` で切れ、ws-server のログに `[open]` が出ない | プロキシがハンドシェイクごと落としている | 券の渡し方を変える。**接続後の最初のメッセージで券を送る**形（設計で一度退けた案）へ切り替える。認証前の接続にタイムアウトが要る（**+2.0h 程度**） |
| `[open] 見るだけ（券なし）` が出る | ヘッダは通っているが `Sec-WebSocket-Protocol` だけ落ちている | 同上 |
| 応答の `tenko.v1` が返らずブラウザが切る | プロキシが応答ヘッダを落としている | 同上 |
| `[open] 認証済み` が出る | **通っている。作り直しは不要** | — |

**切り替えの土台はできている。** `ws.authed` を見て捨てる形は、最初のメッセージで認証する案でもそのまま使える。
変わるのは「いつ `authed` を立てるか」だけである。

### そのほか

1. **ws-server → アプリの経路が2本になった**（`/api/demo-presence` と `/api/ws-verify`）。
   Railway からVercelへ、60秒ごとに2回の要求が出る。**Vercel の無料枠の呼び出し回数**は
   1日あたり 2 × 60 × 24 = 2880 回。段階7で枠を確認する
2. **`TENKO_WS_TICKET_SECRET` と `TENKO_WS_INTERNAL_TOKEN` を、Vercel と Railway の両方に同じ値で置く必要がある。**
   片方だけ入れると、券が通らない（4003 が出続ける）か、確認が401で失敗し続ける（10分後に全切断）
3. 手元で動かすとき、ws-server はアプリの `.env.local` から `TENKO_` で始まる値だけを借りる。
   **本番では環境変数が直接設定されるため、この読み込みは何もしない**
4. **`/api/ws-verify` が落ちると、10分後に全員が見るだけに落ちる。**
   Vercel の障害がそのまま村の機能停止になる。段階7で、この挙動をPOが受け入れるか再確認したい

## J. この作業で変わったDBの状態（POに申し送り）

| 変わったもの | 内容 |
|---|---|
| `demo_presence.note` | **列を追加**（追加のみのDDL 1文）。13人分の内容を `daily_notes` から写した |
| `daily_notes` | **中身は変えていない。** 確認で日付を1日ずらし、元に戻した（最新日付=今日 を確認済み） |
| `.env.local` | `TENKO_WS_TICKET_SECRET` と `TENKO_WS_INTERNAL_TOKEN` を追加（32バイトの乱数。**値は表示していない**） |
| `sessions` | **POのログインはそのまま。** 確認スクリプトが作ったセッションはすべて削除済み |

## K. 現時点で答えを持たない事項（更新）

| 事項 | 区分 | 内容 |
|---|---|---|
| Railway のプロキシが `Sec-WebSocket-Protocol` を通すか | **未検証** | ローカルでは再現しない。**段階7で最初に確認する**。通らない場合の作り直しは I 節に整理した |
| 別ドメイン間で Cookie が WS ハンドシェイクに送られるか | **未検証** | 設計はCookieに依存しない（券だけで通ることをスパイクで実測済み） |
| 本番（https・別ドメイン）での Cookie の `Secure` / `SameSite` | **未検証** | ローカルでは `Secure` が付かない |
| `assertSameOrigin` が Vercel の背後で正しく働くか | **仮説** | `Origin` と `Host` を比べている。プロキシが `Host` を書き換える構成では誤判定しうる |
| セッションが7日で切れた瞬間の挙動 | **未検証** | 段階6で `sessions` を消したときの挙動（4001 で切れる）は確認したが、**期限切れそのもの**は試していない。`expires` を過去にすれば試せる |
| 券がまだ使われていない60秒の間に盗まれた場合 | **受け入れる（仕様）** | G節に理由を書いた。持参人式の券に共通の性質で、盗める経路が成立していればCookieも同時に危ない |
| 見るだけの接続の本数の上限 | **未実装** | 券が要らないので、いくらでも張れる。段階7で上限を決めるか判断する |
| デモ用の利用者が動かないこと | **未解決（判断待ち）** | 段階4-5から持ち越し |

---

# 2026-08-13（続き）段階7: 公開の準備

**結論を先に書く: コードは完成した。デプロイの実行はPO待ちで止めている。**

## A. なぜ止めたか（デプロイに着手できない理由）

**このリポジトリには git remote が無い。**

```
$ git remote -v
（何も出ない）
```

Render も Vercel も **Git のリポジトリからデプロイする**。
つまり最初にやることは「GitHub にリポジトリを作って push する」であり、
これは**POのアカウントで行う操作**である（アカウントの作成・リポジトリの所有はCCが代行しない）。

Render と Vercel のアカウント作成も同じ。**したがって作業4〜6は着手できない。**

手順は `docs/DEPLOY.md` に、POが順に実行できる形で書いた。
`cd` から始まる完成形のコマンドと、画面の操作を分けて書いてある。

**報告の 1〜8 のうち、本番が要る項目（1・3・4・5・6・7と、8の一部）は「未実施」である。**
`docs/DEPLOY.md` の4節に、`Sec-WebSocket-Protocol` の判定表をそのまま置いてある。

## B. 作業1: ws-server が寝ていても村に人がいる

**Phase 4.10 と同じ形にした。** サーバー側で `demo_presence` を読み、最初のHTMLに載せる。

```
src/app/page.tsx    demoPresence() を読み、initialPeople / initialCounts として渡す
village-client.tsx  people の初期値をそれにする。WS が繋がったら WS の一覧と合わせる
```

### 実測: ws-server を止めた状態で村を開く

**ws-server を起動していない状態**で `/` を開いた（スクリーンショットあり）:

- **デモ用の20人が全員出た。** 吹き出し8件、状態のリング、「集中中」「後で」の札も出る
- 建物の下の帯も埋まっている（会議中の6人が数えられている）
- メンバー **20/56**
- ヘッダは「**接続しています…**」（赤くない。静かな表示）

その後 ws-server を起こすと:

- **人が飛ばない。20人とも同じ位置のまま**、自分（テスト太郎）が1人増えて **21/56**
- 「接続しています…」が消える

**置き換わる瞬間のちらつき・座標の飛びは無かった**（同じ値が入るため）。

### 表示の出し分け（作業1のあわせて・作業3）

| 状態 | 出すもの |
|---|---|
| 最初の接続まで | 「接続しています…」（静かな表示。無言で待たせない） |
| 見るだけの人が切断された | **何も出さない。** 元々動かせないので、接続の有無は関係がない |
| ログイン済みで切断された | 赤く出す。動かせるはずのものが動かないため |
| 在席の同期が止まった | 「**在席の同期が止まっています（村の人数は実際と違うかもしれません）**」 |

## C. 実機で見つけた問題（作業3の確認中）

**作業3の表示を確かめるために、わざと `/api/ws-verify` を失敗させたところ、村が空になった。**

```
メンバー 0/56    ← デモ用の20人が消えた
```

原因: ws-server がアプリに到達できない状態で起動すると、`/api/demo-presence` も取れない。
その ws-server が**空の `presence.list`** を送り、画面がそれで**丸ごと置き換えていた**。

**この段階で直そうとしていた失敗（村が空になる）が、別の経路で起きていた。**
作業1は「ws-server が寝ている」場合しか見ておらず、
「ws-server は起きているが、アプリに届かない」場合を見落としていた。

直し方:

- 画面は、サーバーが最初のHTMLに載せたデモ用の人を**下敷きとして置く**。
  WS が同じIDを送ってきたらそちらで上書きする（生きている人の情報が優先される）
- 建物の人数も、**実際に描く人から数え直す**（サーバーの数字をそのまま使うと、
  帯は空なのに中に人がいる状態になる）
- あわせて、券は正しいのに確認ができず見るだけへ落とした接続にも `auth.expired` を送る。
  黙って落とすと、**利用者は村にいるつもりで、実際にはいない**

直したあとの同じ状況（スクリーンショットあり）:

```
在席の同期が止まっています（村の人数は実際と違うかもしれません）   ← ヘッダ
メンバー 20/56                                                  ← デモ用の20人は残る
```

**村が空にならず、かつ「同期が止まっている」ことが分かる。** 両方を満たした。

## D. 作業2: 認証済みの接続が0本のとき `ws-verify` を投げない

届かないポートを `TENKO_API` に指定した ws-server を起こし、
接続0本のまま 200ms 間隔で 2.5 秒（10回以上まわる時間）待った。

```
=== 6. 認証済みの接続が0本のとき、確認を投げないか（段階7）===
  OK   接続が0本の間は1回も投げない : [verify] のログ 0 行
  OK   見るだけの接続だけでも投げない : [verify] のログ 0 行
```

**投げていれば必ず失敗のログが出る**（届かないポートを指定しているため）。0行なので投げていない。
失敗回数も数えていない（数えると、誰かが最初にログインした瞬間に切断の条件を満たす）。

## E. 作業4の準備: `render.yaml` と `/healthz`

Render の無料枠は **HTTPの応答で生死を判定する**。
`WebSocketServer({ port })` の形は普通のHTTPに 400 しか返さず、健康確認に落ちる。

HTTPのサーバーを自分で持ち、その上に WebSocket を載せる形に変えた。

```
GET /healthz  -> 200 "ok 1"        （数字は今の接続数）
GET /         -> 404 "tenko ws-server"
（WebSocket は同じポートで今までどおり繋がる。実測で確認）
```

起動時のログに、鍵が入っているかも出すようにした（**値は出さない**）:

```
ws-server listening on port 8080 / API=http://localhost:3000
  見るだけモード: 有効 / 券の鍵: あり / 共有秘密: あり
```

鍵を入れ忘れたまま動かすと、券が通らず全員が見るだけになる。
**その状態を、起動の1行目で気づけるようにした。**

## F. 作業6: 実測した数値（**手元での測定**。本番は未測定）

`scripts/measure-phase5.js`（**本番のURLを渡せば本番で測れる**）:

| 項目 | 値 | 備考 |
|---|---|---|
| セッション確認の遅延（`/api/me`） | **中央 343ms**（最小 335 / 平均 384 / 最大 1124） | **設計書の見積 2〜10ms と大きく違う** |
| 未ログインで村を開いてから最初のHTMLまで | **中央 233ms**（最小 220 / 最大 288）。HTML 19.9 KB | 手元。Vercel では別の値になる |
| 最初のHTMLに載るデモ用の人数 | **20人**（`demo_presence` の全行） | ws-server が寝ていても見える人数 |
| アプリの呼び出し回数 | **1日あたり最大 2880 回** | `demo-presence` 1440 + `ws-verify` 1440 |

### セッション確認の遅延について（正直に書く）

設計書5節は「Vercel と Neon が同じ地域なら 2〜10ms」と**見積もっただけ**だった。
段階3で「実測する」と書いて実測していなかった。**今回測ったら 343ms だった。**

内訳の推定（**推論**）: 1リクエストにつき3クエリ（`auth()` の2 + `users` の1）で、
手元のPCから Neon（シンガポール）への往復が 1回あたり 100ms 強。3回で 340ms 前後になる。

- **これは手元の数字であって、本番の数字ではない。** Vercel と Neon が同じ地域なら大きく下がる
- ただし**3クエリという構造は変わらない**。地域が離れていれば、その3倍の遅延がそのまま出る
- **本番で測り直し、遅ければ「役割を毎回引き直す」判断を見直す**（いまは降格が即座に効くことを優先している）

### 呼び出し回数

2880回/日は**上限**であり、実際はこれより少ない:

- ws-server が寝ている間は**0回**（無料枠は15分の無通信で停止する）
- `ws-verify` は**認証済みの接続が0本のとき投げない**（作業2）

Vercel の無料枠（Hobby）は関数の実行回数に十分な余裕がある想定だが、
**枠の実際の数字は本番の管理画面で確認する**（未確認）。

## G. 作業7: 文書

- `README.md`: 公開先（Vercel / Render / Neon。すべて無料枠）、できること、
  **動かせないもの**（深夜0時をまたぐ勤務・無料枠の15分停止・デモ用の利用者は動かない）を書いた。
  URLの表が古かった（`/village` と `/?room=1`）ので直した
- **「お試し版・ログインなし」の帯は段階3で外し済み。** いま画面に残っているのは、
  差し替えた経緯を説明するコメントだけである（表示はしない）
- `docs/TENKO_STATE.md`: **完成版で置き換えた**（丸ごと差し替えられる形で出力した）
- `docs/DEPLOY.md`: **新規。** POが順に実行する手順

## H. 破壊試験（段階7の変更後）

ws-server に HTTP のサーバーを足し、画面の在席の扱いを変えたため、全部を流し直した。

```
attack-presence（S6）     : OK 12 件 / 通ってしまった 0 件
attack-ws-verify          : OK 15 件 / 通ってしまった 0 件
attack-phase5-auth        : OK 45 件 / 通ってしまった 0 件
attack-public-view        : OK 24 件 / 通ってしまった 0 件
verify-freeze             : 通ってしまった 0 件
verify-auth-coverage      : 問題なし
```

**本番URLに対する実行は未実施**（デプロイ待ち）。手順は `docs/DEPLOY.md` の5節にコマンドを置いた。

## I. 現時点で答えを持たない事項

| 事項 | 区分 | 内容 |
|---|---|---|
| **Render のプロキシが `Sec-WebSocket-Protocol` を通すか** | **未検証。最重要** | デプロイ後、**他の何よりも先に確認する**。通らない場合は +2.0h の作り直し（判定表は `docs/DEPLOY.md` 4節） |
| `assertSameOrigin` が Vercel の背後で働くか | **仮説のまま** | 段階4からの持ち越し。手元では `Origin` と `Host` を比べているだけで、本番のプロキシが `Host` を書き換えるかは分からない。確認のコマンドは `docs/DEPLOY.md` 5-1 |
| Render の起動にかかる実時間 | **未測定** | 公表値は「約1分」。実測値を持つ |
| 15分で本当に停止するか | **未検証** | 2026年2月の変更で WS のメッセージも停止を先送りするとされる。**誰かが村にいる間は止まらないこと**を含めて確認する |
| 本番でのセッション確認の遅延 | **要実測** | 手元では343ms。地域が離れていれば本番でも大きい |
| Vercel の無料枠の実際の上限 | **未確認** | 呼び出しは1日あたり最大2880回 |
| 本番（https・別ドメイン）での Cookie の挙動 | **未検証** | 設計はCookieに依存しないが、`Secure` が付くことは本番でしか見られない |
| デモ用の利用者が動かないこと | **未解決（判断待ち）** | 段階4-5からの持ち越し |
| 公開後に誰が `users` に登録されるか | **未定** | いま email が入っているのはPOの1人だけ。**他人を入れる手順は script で1行ずつ**（管理画面は作っていない） |

## J. POが次に行うこと（まとめ）

1. GitHub にリポジトリを作り、`git remote add` して push（`docs/DEPLOY.md` 1節）
2. Render に ws-server を出す（同2節）
3. Vercel にアプリを出す（同3節）
4. **`Sec-WebSocket-Protocol` が通ったかを最初に確認する**（同4節）。
   通らなければ**そこで止めてCCに報告する**
5. 通っていれば、同5節の確認（停止と起動の実測・破壊試験・`assertSameOrigin`）

---

# 2026-08-13（続き）段階7-B: 本番での実測と検証

## A. 本番に対する破壊試験

**すべて本番URL（`https://tenko-eight.vercel.app` / `wss://tenko-ws.onrender.com`）に対して実行した。**

| 試験 | 結果 |
|---|---|
| `attack-public-view.js` | **OK 24 件 / 通ってしまった 0 件** |
| `attack-phase5-auth.js` | **OK 45 件 / 通ってしまった 0 件** |
| `attack-presence.js`（S6） | **OK 12 件 / 通ってしまった 0 件** |
| `attack-ws-verify.js`（外から見える範囲のみ） | **OK 4 件 / 通ってしまった 0 件** |
| `attack-origin.js`（新規） | **OK 5 件 / 通ってしまった 0 件** |
| `verify-freeze.js` | 通ってしまった 0 件 |
| `verify-auth-coverage.js` | 問題なし |

**公開中のサーバーに対して「確認を10回失敗させて全員を切る」試験は行っていない**（`TENKO_SKIP_LOCAL=1`）。
段階6で手元では確認済み。

### S6 が本番でも塞がっていること（実際の出力）

```
被害者=2（検証 部下） 攻撃者=4（検証 無関係）
被害者の状態（攻撃前）: {"id":2,"colorIndex":2,"state":"idle",...,"talk":"ok","x":308,"y":350,"connections":1}

=== 1. 他人になりすまして在席を変える（S6。段階6の完了条件）===
  被害者の状態（攻撃後）: {"id":2,"colorIndex":2,"state":"idle",...,"talk":"ok","x":308,"y":350,"connections":1}
  攻撃者として村に出たもの: {"id":4,"colorIndex":4,"state":"away",...,"talk":"focus","x":352,"y":350,"connections":1}
  OK   他人の在席を変えられない : state=idle talk=ok（攻撃前と同じなら守られている）
  OK   名乗ったIDではなく、券の利用者として村に出る : 攻撃者 id=4 state=away

=== 4. 不正な券で繋げるか ===
  OK   同じ券を使い回して繋げない : opened=true closed=undefined code=null 受け取った知らせ=auth.rejected
  OK   署名を書き換えた券で繋げない : 受け取った知らせ=auth.rejected
  OK   券の利用者IDを書き換えて繋げない : 受け取った知らせ=auth.rejected

結果: OK 12 件 / 通ってしまった 0 件
```

## B. 「拒否された」と「到達していない」の区別（**最初は区別できていなかった**）

**最初の実行で「通ってしまった 18 件」が出た。すべて試験側の問題だった。**
守れていないのではなく、**試験が壊れると「合格」として報告される**形の問題である。

### 問題1: 本番ではセッションCookieの名前が変わる

本番（https）では `__Secure-authjs.session-token`。手元の名前で送ると**すべて 401** になる。

```
通った member は一覧を見られない（403） : 401 {"error":"ログインが必要です"}
通った 別の上長が承認できない          : 401 {"error":"ログインが必要です"}
```

401 は「拒否」なので、**期待値を「拒否されること」だけにしていたら、そのまま合格と読めていた。**

**気づけたのは、試験に「対照」（成功するはずのもの）を入れていたからである。**

```
通った 担当の上長だけが承認できる（対照） : 401 status=submitted   ← ここで壊れていると分かる
通った 自分の月次は取れる（対照）         : 401 len=21
```

**「拒否されること」だけを並べた試験は、到達していなくても合格する。**
**対照を1つ入れておくと、到達していないことが必ず露見する。**

### 問題2: close code が本番では届かない（正確には20秒遅れ、コードが消える）

段階6のスパイクでは、手元で `close(4003)` が画面まで届くことを確認していた。**本番では違った。**

```
auth.rejected が届くまで: 254 ms
close が届くまで        : 20,254 ms 後（code=1006）
```

**プロキシが close を20秒ほど遅らせ、コードを 1006 に置き換えている。**

- 試験側: 「知らせ（`auth.rejected`）が来た **か** 4003 で閉じられた」を断りとみなす形に直した
- 画面側: **繋ぎ直しの引き金を知らせに変えた**（後述 D節）

### 問題3: 遠いサーバーでは往復に時間がかかる

「開いたあと閉じられるか」を待つ時間が手元の 500ms のままだと、断りが届く前に判定していた。
`wss://` のときは 3 秒待つようにした。

### 区別できない試験は残っていない

すべての試験に、**「到達していれば必ず成功する対照」**があるか、
**「断りの知らせを受け取ったこと」**を直接見る形になっている。

## C. `assertSameOrigin` の決着（**段階4から4段階持ち越した仮説**）

**本番で働いている。実測で決着した。**

```
対象: https://tenko-eight.vercel.app / 利用者 4（検証 無関係）

=== 1. 正しい Origin（＝本番のURL）
  OK   正しい Origin なら書ける : status=200
=== 2. 別のオリジンを名乗る
  OK   Origin: https://evil.example.com が拒まれる : status=403 {"error":"別のサイトからの操作は受け付けません"}
  OK   Origin: http://localhost:3000 が拒まれる : status=403
  OK   Origin: https://tenko-eight.vercel.app.evil.com が拒まれる : status=403
=== 3. Origin を付けない（サーバ同士の通信・curl など）
  status=200（設計どおり通る。Cookie が要ることが別の担保になっている）
=== 4. 未ログインなら、Origin が正しくても書けないか
  OK   Cookie なしでは書けない : status=401

結果: OK 5 件 / 通ってしまった 0 件
```

**懸念していた「プロキシが `Host` を書き換えると誤判定する」は起きていない。**
`tenko-eight.vercel.app.evil.com`（前方一致の罠）も 403 で弾いている。

## D. 本番でしか出ない差を2つ直した

| # | 差 | 直し方 |
|---|---|---|
| 1 | セッションCookieの名前（`__Secure-` が付く） | 試験スクリプトが URL の scheme で名前を切り替える |
| 2 | close が20秒遅れ、code が 1006 になる | **画面の繋ぎ直しの引き金を、close code から知らせ（`auth.expired` / `auth.rejected`）に変えた** |

2 は本番の体験に直に効く。close code を待つ形では:

- 券を取り直すまでに **20秒**かかる（知らせなら **254ms**）
- **4001（セッション無効）と 4003（券が不正）の区別が失われる**（どちらも 1006 になる）

**段階6のスパイクは「手元では close code が届く」ことを確かめた。
プロキシを挟むと届き方が変わる。ローカルの実測では見えない差だった。**

## E. 接続の後始末（誤った疑いを1つ立てて、測り直した）

`/healthz` の接続数が増える一方に見えたため、**「閉じた接続が残っている（メモリの漏れ）」と疑った。**
待ち時間を延ばして測り直したところ、**誤りだった。**

```
1本開いた       : ok 3
行儀よく閉じた  : ok 3      ← 8秒ではまだ残っている
乱暴に切って10秒: ok 3
乱暴に切って20秒: ok 2      ← 20秒で消える
乱暴に切って40秒: ok 2
```

**閉じてから ws-server が気づくまで 10〜20 秒かかる。** 消えないのではなく、遅い。

村の在席も確認した:

```
村に入った後  : 22 人 / 自分は いる
接続を閉じた。10秒待つ…
閉じた後      : 21 人 / 自分は 消えた
```

**タブを閉じれば村から消える。** ただし**最大20秒ほど残る**（＝退勤の反映が最大20秒遅れる）。

**2.5秒しか待たずに「残っている」と報告していたら、無い問題を報告していた。**

## F. 本番で測った数値

| 項目 | 値 |
|---|---|
| 未ログインで村が出るまで（最初のHTML） | **中央 648ms**（最小 628 / 最大 2781）。15.8 KB |
| セッション確認（`/api/me`） | **中央 1077ms**（最小 1057 / 最大 2394） |
| ├ DBを引かない分（往復＋関数の起動） | 200ms |
| └ **DBを3回引く分** | **約 862ms**（1回あたり 約290ms） |
| 参考: `/api/rooms`（DBを1クエリ） | 415ms |
| 最初のHTMLに載るデモ用の人数 | **20人** |
| アプリの呼び出し回数 | 1日あたり最大 2880 回 |

### セッション確認の遅延についての意見（**判断はPOに返す**）

設計書5節の見積は「Vercel と Neon が同じ地域なら 2〜10ms」だった。**実測 1077ms で、2桁外れている。**

内訳を切り分けた（Cookie なしの `/api/me` は `auth()` がDBを引かずに返るため、往復と関数の起動だけになる）:

- 往復＋関数の起動: **200ms**
- DBの3クエリ: **約 862ms**（1回あたり約 290ms）

**1クエリ290msは、Vercel の実行地域と Neon の地域（シンガポール）が離れていることを示す**（推論）。

意見:

1. **まず地域を揃えることを試すべき。** Vercel の Functions の地域をシンガポールに寄せるだけで、
   設定だけで済み、費用もかからない。**これで足りるなら、設計を変える必要はない**
2. それでも遅い場合に初めて、**3クエリを1クエリに減らす**ことを検討する。
   `auth()` の2クエリはアダプタの実装なので、減らせるのは「役割を引き直す1クエリ」だけである
3. ただし**役割を毎回引き直すのは「降格が即座に効く」ための判断**であり、
   これをやめると「権限を落としたのに、古いセッションのまま権限が残る」時間が生まれる。
   **勤怠の承認に関わる権限なので、速さと引き換えにする判断はPOがすべき**

**この場では最適化していない。**

### Vercel の無料枠に対する評価

**未確認。** 1日あたり最大2880回（ws-server が寝ている間は0回）だが、
**Vercel Hobby の実際の上限値は管理画面でしか確認できず、CCは触らない。**
PO が Vercel の Usage を見て判断すること。

なお、2880回は**寝ない前提の上限**であり、無料枠は15分で寝るため、実際はこれより大幅に少ない。

## G. Render の停止・起動（**PO の操作待ちで未完**）

**測れていない。** ws-server に接続が2本残っており、**停止しないため。**

```
13:46:34  ok 2
13:48:35  ok 2
14:02:35  ok 2   ← 起動（12:47）から75分、ずっと2本のまま
```

- 自分のタブは閉じた。**残っている2本はPOのブラウザだと考えられる**
- 接続が生きている間は、`/healthz` の数字が減らない

**これは item 7（誰かが村にいる間は停止しない）の証拠にはなっている。**
起動から**75分以上、15分の無通信ルールにかかわらず停止していない。**

**残り（15分で止まるか / 止まった状態で村が見えるか / 起動にかかる実時間）は、
POが全てのタブを閉じてから測る。**

## H. 現時点で答えを持たない事項

| 事項 | 区分 | 内容 |
|---|---|---|
| 15分で実際に停止するか | **未測定（PO待ち）** | 接続が残っているため測れない。**全タブを閉じてもらう必要がある** |
| 停止中に村が見えるか | **未測定（PO待ち）** | 仕組みは入っており、**手元では ws-server を止めて20人が出ることを確認済み**（段階7） |
| 起動にかかる実時間 | **未測定（PO待ち）** | Render の公表値は「約1分」 |
| ws-server の外向きの通信が停止を妨げるか | **推論** | 停止の判定は**受信**の有無で行われるため、`/api/rooms` などの送信は妨げないはず。**未確認** |
| Vercel の無料枠の実際の上限 | **未確認** | 管理画面はPOの職掌 |
| セッション確認 1077ms を許すか | **判断待ち** | F節に意見を書いた。**この場では最適化していない** |
| デモ用の利用者が動かないこと | **未解決（判断待ち）** | 段階4-5からの持ち越し |
| 公開後に誰を `users` に登録するか | **未定** | いま email があるのはPOの1人だけ |

## 12. 変更ログ

- 2026-08-13 段階0〜2。DDL 15文を実行。Auth.js v5 を導入。**ログインの実機確認は認証情報待ち**
- 2026-08-13 環境変数を確認（変数名の食い違いを1件修正）。セッションから email を落とし、
  実測中に見つけた **sessionToken の露出**も直した。段階2の5項目をすべて実測で確認した
- 2026-08-13 段階3。`requestedUserId` を廃止し、引数を取らない `currentActor()` に置き換えた。
  全13経路 + 画面3つを1つずつ差し替え、その都度攻撃を送って確認した（45件すべてOK）。
  `devUser()` と `actorId()` を削除。`verify-auth-coverage.js` で抜けを機械検査する形にした。
  **WSの在席の偽装（S6）は残っている。段階6で塞ぐ**
- 2026-08-13 段階7。**コードは完成。デプロイの実行はPO待ち**（git remote が無く、
  Render も Vercel も Git から取るため、GitHub のリポジトリ作成が先。POのアカウントの操作）。
  ws-server が寝ていても村に人がいる形にし（最初のHTMLにデモ用の在席を載せる）、
  接続0本のときは `ws-verify` を投げないようにした。`render.yaml` と `docs/DEPLOY.md` を用意。
  **実機の確認中に「ws-server がアプリに到達できないと村が空になる」問題を見つけて直した**
- 2026-08-13 段階6。**S6（他人の在席の偽装）を塞いだ。** WSに入場券の検証を入れ、
  利用者IDを券から取る形にした。`/api/ws-ticket` と `/api/ws-verify` を新設。
  設計書6節をスパイクの実測にもとづき訂正（誤り3点）。作業0でデモの吹き出しを日付から切り離した。
  破壊試験は全項目維持、通ったもの0件
- 2026-08-13 段階4-5。見るだけモードを完成（開放は4経路のみ。`TENKO_PUBLIC_VIEW=0` で全閉）。
  未認証には**デモ用の利用者の分だけ**を返す（今日やること・表示名の両方）。
  デモ用の利用者50人のうち20人を、接続なしで村に出した。
  4xx をまとめて扱っている箇所を全数検索し、7か所のうち2か所を直した。
  破壊試験は新規3項目を含めてすべて維持（通ったもの0件）
