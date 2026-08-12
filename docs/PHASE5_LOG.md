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

## 12. 変更ログ

- 2026-08-13 段階0〜2。DDL 15文を実行。Auth.js v5 を導入。**ログインの実機確認は認証情報待ち**
- 2026-08-13 環境変数を確認（変数名の食い違いを1件修正）。セッションから email を落とし、
  実測中に見つけた **sessionToken の露出**も直した。段階2の5項目をすべて実測で確認した
- 2026-08-13 段階3。`requestedUserId` を廃止し、引数を取らない `currentActor()` に置き換えた。
  全13経路 + 画面3つを1つずつ差し替え、その都度攻撃を送って確認した（45件すべてOK）。
  `devUser()` と `actorId()` を削除。`verify-auth-coverage.js` で抜けを機械検査する形にした。
  **WSの在席の偽装（S6）は残っている。段階6で塞ぐ**
