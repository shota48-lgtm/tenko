# PHASE5_AUTH_DESIGN

作成日: 2026-08-13
状態: **設計のみ。実装していない。DDLは実行していない。** POの検収待ち

前提（POと設計担当が確定済み。この設計では変更していない）:
Google認証のみ / ドメイン制限なし / `users` に登録済みの人だけが中に入れる /
未ログインでも村は見える / セッションはDB方式・7日 / 最初の管理者は環境変数 /
デモ用の利用者は常に村にいる・ログインできない / 権限は既存の `role` と `manager_id` で持つ。

---

## 0. 先に報告すべき、実体との食い違い

設計に入る前に、指示文と実体が食い違っている点を2つ確認した。**実体を正とした**（J1）。

| 項目 | 指示文 | 実体 | 確認方法 |
|---|---|---|---|
| デモ用の利用者の人数 | 26人 | **56人**（admin 1 / manager 2 / member 53。deleted_at は全員 NULL） | `SELECT count(*) FROM users` を読み取りのみで実行 |
| Auth.js v5 の安定版 | 「2024年後半に安定版になった」 | **いまも beta。** npm の dist-tag は `latest=4.24.15` / `beta=5.0.0-beta.32` | npm レジストリ（registry.npmjs.org/next-auth）の dist-tags |

56人という人数は、設計の結論を変えない（デモ用の印を立てる対象が増えるだけ）。
ただし「デモ用に残すのは何人か」はPOの判断事項なので、9節に挙げる。

v5 が beta のままである点は採否に関わるため、1節で扱う。

既存の `users` の列（実測）:

```
id bigint NOT NULL default nextval / display_name text NOT NULL /
role text NOT NULL default 'member' / created_at timestamptz NOT NULL default now() /
deleted_at timestamptz NULL / manager_id bigint NULL
```

**メールアドレスの列は存在しない。** 認証の紐づけ先を新たに作る必要がある。

---

## 1. 採用するライブラリと構成

### 結論: 推奨どおり Auth.js v5（`next-auth@5.0.0-beta.32`）+ `@auth/pg-adapter` を採る

ただし「v5 は安定版」という前提は誤りで、**beta を承知のうえで採る**という判断になる。
それでも採る理由:

1. **Next.js 16 を peerDependencies で明示的に支持している唯一の選択肢だった。**
   `next-auth@5.0.0-beta.32` の peerDependencies は `next: ^14.0.0-0 || ^15.0.0 || ^16.0.0`。
   安定版の v4（4.24.15）は App Router / Next 16 を前提にしていない。
   **v4 に落とすことは「安定版を選ぶ」ことにならない。**
2. Auth.js の公式ドキュメントが既に Next.js 16 の `proxy.ts` を前提に書き換わっている
   （後述の「proxy に頼るな」の警告文が `proxy.ts` の名前で書かれている）。
3. 既存の Neon の DB をそのまま使える（`@auth/pg-adapter` は `pg` を peer に取る。tenko は既に `pg@8.23.0` を使っている）。
4. 費用ゼロ。外部サービスへの依存が増えない。

beta であることへの手当て:

- **バージョンは完全にピン留めする**（`^` や `~` を付けない）。beta は破壊的変更が入りうる
- 依存を薄く使う。tenko が Auth.js に任せるのは「Googleとのやり取り」「セッションの発行と検証」だけで、
  **権限（role / manager_id）は一切渡さない**。乗り換えが必要になったときの影響範囲を、
  `src/lib/actor.ts` と `auth.ts` の2ファイルに閉じ込める

### 採らなかった選択肢

| 選択肢 | 採らない理由 |
|---|---|
| Neon Auth | 独自の利用者テーブルを持つ形になり、`role` / `manager_id` を持つ既存の `users` と二重管理になる |
| Clerk / Auth0 / WorkOS | 数人の利用者に対して過剰。外部依存が増える |
| next-auth v4（安定版） | App Router / Next 16 を前提にしていない。「安定版だから安全」は成り立たない |
| 自前実装 | Googleとのやり取り（PKCE・state・id_token検証）を自分で書くことになり、認証を自前で持たない方針と矛盾する |

### パッケージ（固定値でピン留め）

```
next-auth       5.0.0-beta.32     (npm dist-tag: beta。2026-08-13 時点)
@auth/pg-adapter 1.11.3           (npm dist-tag: latest。peer: pg ^8)
```

`pg@8.23.0` は既にあるため追加不要。`@neondatabase/serverless` は**入れない**
（Auth.js の Neon 向け記述は Edge ランタイムでの利用を前提にしたもので、
tenko の API と proxy はどちらも Node.js ランタイムで動くため、既存の `pg` の Pool をそのまま使える）。

### 環境変数

| 名前 | 用途 | 置き場所 |
|---|---|---|
| `AUTH_SECRET` | Cookie とトークンの署名。`npx auth secret` で生成 | Vercel |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth クライアント | Vercel |
| `AUTH_URL` | 本番のURL（自動検出が効かない場合の明示） | Vercel |
| `TENKO_ADMIN_EMAILS` | 最初の管理者。カンマ区切り | Vercel |
| `TENKO_PUBLIC_VIEW` | 見るだけモード。`1` で有効（既定）、`0` で無効 | Vercel と Railway の両方 |
| `TENKO_WS_TICKET_SECRET` | WS の入場券の署名鍵。**アプリと ws-server で同じ値** | Vercel と Railway |
| `TENKO_DEV_USER_ID` / `TENKO_TRUST_USER_PARAM` | **段階3の完了時に削除する**（なりすましの経路そのもの） | 削除 |

シークレットの値はチャットにも引数にも出さない（J13）。Vercel / Railway の管理画面で直接入力する。

---

## 2. データ設計

### 方針: Auth.js の `users` を、既存の `users` に相乗りさせる

`@auth/pg-adapter@1.11.3` が `users` に対して実際に投げるSQLを実装から確認した:

```sql
-- createUser
INSERT INTO users (name, email, "emailVerified", image) VALUES ($1,$2,$3,$4)
  RETURNING id, name, email, "emailVerified", image
-- getUser / getUserByEmail
select * from users where id = $1  /  select * from users where email = $1
-- getUserByAccount
select u.* from users u join accounts a on u.id = a."userId"
  where a.provider = $1 and a."providerAccountId" = $2
```

つまりアダプタが要求するのは **テーブル名 `users` と、`name` / `email` / `emailVerified` / `image` の4列だけ**。
既存の `display_name` / `role` / `manager_id` には触れない。
よって**別テーブルを作らず、既存の `users` に4列を足す**のが最も素直で、二重管理も起きない。

`id` は既存が `bigint` のまま使える（アダプタのSQLは型を指定していない。パラメータとして渡すだけ）。
ただし**注意点が1つある**: `pg` は `bigint` を JavaScript の文字列として返すため、
セッション内の `user.id` が `"3"` のような文字列になる。
`actor.ts` で必ず `Number()` に通す（3節）。**これは実装時に実測で確認すること**（9節の未検証項目）。

### 提示するSQL（**未実行**。POが Neon の SQL Editor で手動実行する）

実行先: Neon の **tenko** プロジェクト（パンくずでプロジェクト名の一致を確認してから実行）。

```sql
-- ============================================================
-- tenko Phase 5: 認証（Google + Auth.js v5 / DBセッション）
-- 実行は PO が SQL Editor で手動で行う。CC は実行しない。
-- 追加のみ。既存の列・データは変更しない。
-- ============================================================

-- 1) 既存の users に、Auth.js が使う4列を足す
--    display_name / role / manager_id はそのまま。認証は「誰か」だけを持つ
ALTER TABLE users ADD COLUMN name          TEXT;
ALTER TABLE users ADD COLUMN email         TEXT;
ALTER TABLE users ADD COLUMN "emailVerified" TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN image         TEXT;

-- 同じアドレスの人が2行できないようにする。NULL は重複を許すのでデモ用の利用者は影響を受けない
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;

-- 2) デモ用の印。接続が無くても村にいる人（ログインは絶対にできない）
ALTER TABLE users ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT false;

-- デモ用の利用者はメールアドレスを持てない = Googleのアドレスと一致しようがない。
-- 「ログインできない」をアプリの分岐だけでなくDB側でも担保する
ALTER TABLE users ADD CONSTRAINT users_demo_has_no_email
  CHECK (is_demo = false OR email IS NULL);

-- 3) （この文は実行しなかった。2026-08-13 / 段階1）
--    ALTER TABLE users ALTER COLUMN display_name SET DEFAULT '(未登録)';
--    アダプタが万一 createUser を呼んでも 500 にならないようにする保険だったが、
--    既存の列の既定値を変える操作であり、実行条件
--    「既存テーブルの既存の列と制約を変更しないこと」に反するため落とした。
--    未登録者は signIn で先に落ちるため createUser には到達せず、保険が無くても設計は成立する。

-- 4) Auth.js のテーブル。列名は大文字小文字を含むため必ず二重引用符付きで作る
CREATE TABLE accounts (
  id                  BIGSERIAL PRIMARY KEY,
  "userId"            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                VARCHAR(255) NOT NULL,
  provider            VARCHAR(255) NOT NULL,
  "providerAccountId" VARCHAR(255) NOT NULL,
  refresh_token       TEXT,
  access_token        TEXT,
  expires_at          BIGINT,
  id_token            TEXT,
  scope               TEXT,
  session_state       TEXT,
  token_type          TEXT
);
CREATE UNIQUE INDEX accounts_provider_uq ON accounts (provider, "providerAccountId");
CREATE INDEX accounts_user_idx ON accounts ("userId");

CREATE TABLE sessions (
  id             BIGSERIAL PRIMARY KEY,
  "userId"       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires        TIMESTAMPTZ NOT NULL,
  "sessionToken" VARCHAR(255) NOT NULL
);
CREATE UNIQUE INDEX sessions_token_uq ON sessions ("sessionToken");
CREATE INDEX sessions_user_idx ON sessions ("userId");

-- メールリンク認証は使わないが、アダプタの実装が参照するため作っておく
CREATE TABLE verification_token (
  identifier TEXT NOT NULL,
  expires    TIMESTAMPTZ NOT NULL,
  token      TEXT NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- 5) デモ用の利用者の見え方。接続が無くても村に出すために持つ。
--    生きている人の在席は今まで通り ws-server の揮発メモリだけで持つ（方針は変えない）
CREATE TABLE demo_presence (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state   TEXT NOT NULL DEFAULT 'idle'
          CHECK (state IN ('idle','away','talking','resting')),
  talk    TEXT NOT NULL DEFAULT 'ok' CHECK (talk IN ('ok','later','focus')),
  room_id BIGINT REFERENCES rooms(id),
  x       INTEGER NOT NULL,
  y       INTEGER NOT NULL,
  color_index INTEGER NOT NULL DEFAULT 1
);
```

DDLではないデータ操作（POが人数を決めてから実行する。**この設計では文面のみ**）:

```sql
-- 例: 自分（実在の利用者）以外をデモ用にする。対象はPOが決める
-- UPDATE users SET is_demo = true WHERE id <> <POのid>;
-- INSERT INTO demo_presence (user_id, x, y, state) SELECT id, ..., ..., 'idle' FROM users WHERE is_demo;
```

### ロールバックSQL

```sql
-- 実行順は作成の逆。データも消えるため、実行前に対象を確認すること
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
戻す場合は先に `SELECT id, email FROM users WHERE email IS NOT NULL` を控えること。

### 既存の56人にどう対処するか

1. 実在する人（PO本人・実際に使う人）には `email` を入れる。この人たちだけがログインできる
2. 残りは `is_demo = true` にする。`email` は NULL のまま。
   **そのうち20人前後にだけ `demo_presence` の行を入れる**（2026-08-13 PO判断）。
   行がある人だけが村に出る。行が無いデモ用の利用者は「メンバー一覧には出るが村にはいない」。
   実際の職場でも全員が同時に在席してはいないため、これが自然でもある。
   22人までは重なり0を実測済み（PHASE49_LOG.md）で、20人はその範囲に収まる
3. デモ用の利用者は、`users` からは消さない。過去のチャット・勤怠の記録が外部キーで参照しているため
   （消すと Phase 1〜4 のデータが壊れる）

---

## 3. ログインの流れ

### 拒否する場所: `signIn` コールバック（DBに書く前）

`@auth/core@0.41.3` の callback ルートの実装で順序を確認した。
`handleAuthorized`（= `signIn` コールバック）は `handleLoginOrRegister`（= アダプタの `createUser` / `linkAccount`）
**より前**に呼ばれる。`signIn` が偽を返すと `AccessDenied` が投げられ、そこで止まる。

> `const redirect = await handleAuthorized({ user: userByAccount ?? userFromProvider, account, profile }, options)`
> …の後に…
> `const { user, session, isNewUser } = await handleLoginOrRegister(...)`

したがって:

- **未登録のアドレスは、DBに行が1つも作られない。** 利用者テーブルも `accounts` も汚れない
- 拒否されると Auth.js は**サインイン画面へ `?error=AccessDenied` を付けて戻す**

流れ（設計）:

```
1. 未ログインの人が /login を開く → 「Googleでログイン」だけがある
2. Google の同意画面 → 戻ってくる
3. signIn コールバック:
     a. profile.email_verified が真でなければ拒否
     b. SELECT id, role, is_demo FROM users WHERE lower(email)=lower($1) AND deleted_at IS NULL
     c. 行が無ければ拒否（= 未登録）
     d. is_demo なら拒否（デモ用の利用者はログインできない）
     e. TENKO_ADMIN_EMAILS に含まれ、かつ role <> 'admin' なら
        UPDATE users SET role='admin' WHERE id=$1  ← 最初の管理者はここで決まる
     f. 真を返す
4. Auth.js が accounts に1行、sessions に1行作り、Cookie を発行する
5. / に戻る。自分のアバターが村に出る
```

拒否したときに表示するもの（`/login?error=AccessDenied` を自作の画面で受ける）:

> **このアプリは、あらかじめ登録された方だけが使えます。**
> ログインした Google アカウント（`____@____`）は登録されていません。
> 村を見るだけであれば、ログインせずにご覧いただけます。 → 「村に戻る」

**表示するアドレスは、いま拒否された本人のものだけ**（他人のアドレスは一切出さない）。
「登録されていない」以上の情報（誰が登録されているか等）は出さない。

### 既に `users` にいる人が初めてログインしたとき、どう紐づくか

ここが**この設計で一番壊れやすい箇所**である。

`@auth/pg-adapter` の既定の挙動では、`email` が一致する `users` の行が既にあっても、
`accounts` に行が無ければ **`OAuthAccountNotLinked` になり、ログインできない**
（Auth.js は「サインインしていない人の既存アカウントへの自動リンク」を安全でないとして既定で禁じている）。

対策は2つある。**（A）を推奨する。**

| 案 | 内容 | 評価 |
|---|---|---|
| **A（採用。2026-08-13 PO承認）** | Google プロバイダに `allowDangerousEmailAccountLinking: true` を付ける | 1行で済む。「危険」とされるのは**複数の**プロバイダを併用し、片方がメールを検証していない場合。tenko は **Google 1つだけ**で、`email_verified` を自分でも確認する。この条件下では既存の行に紐づく以外の経路が無い |
| B | アダプタをラップし、`createUser` を「既存行の更新」に差し替える | アダプタの内部実装に依存する。beta の更新で壊れる |

Aを採る場合、リンクが起きる条件を「Googleが検証済みと言い、かつ `users` に登録済みで、かつデモ用でない」に
`signIn` 側で絞るため、実質的な危険は残らない。

> **この設定は Google 単独である限り安全である。**
> **将来 Microsoft など別の提供元を追加する場合、この設定を必ず見直すこと。**
> 提供元が2つ以上になった時点で、「同じメールアドレスを名乗る別の提供元」という経路が生まれ、
> この設定は安全でなくなる。

同じ文言を `src/auth.ts` の該当箇所のコメントにも置いた（2026-08-13 / 段階2）。

### 最初の管理者

`TENKO_ADMIN_EMAILS`（カンマ区切り）に載っているアドレスでログインした人が `admin` になる。

- 昇格は `signIn` のたびに確認する。**降格はしない**（環境変数から外しても admin のままにする。
  理由: 環境変数の書き間違いで管理者が全員いなくなると、噴水のお知らせが誰にも書けなくなる）
- 既に `admin` の人には何もしない（UPDATE を投げない）
- 未登録のアドレスを `TENKO_ADMIN_EMAILS` に書いても管理者にはならない（cの拒否が先に効く）。
  **`users` に行があることが前提**。この順序は意図的で、環境変数だけで利用者を増やせないようにするため

---

## 4. 見るだけモードの実装

### 原則

- **書き込みは全て認証必須。例外なし。**
- 読み取りのうち、「村の絵として見えているもの」だけを開放する
- **勤怠は、読み取りであっても一切開放しない**

### API の一覧（現状の全13経路）

| API | メソッド | 未ログイン | 理由 |
|---|---|---|---|
| `/api/rooms` | GET | **開放** | 建物を描くのに要る。返すのは部屋名・種別・定員・飾りのみ |
| `/api/users` | GET | **開放（返す内容を減らす）** | 村の名前ラベルに要る。**いまは全員の `id` と `display_name` を返している。未ログインには `is_demo` と、村にいる人だけに絞る** |
| `/api/notes` | GET（全員分） | **開放。ただしデモ用の利用者の分だけ**（2026-08-13 PO判断） | 吹き出し（今日やること）。村が「動いている」ことの主な表現。**実在の利用者が書いた分は未認証に返さない。** いまDBにあるのは全て検証データなので差は出ないが、実運用に入った瞬間、この区別が無いと業務内容が外部に漏れる。実装は `WHERE u.is_demo` を付ける形で行う |
| `/api/notes` | GET（自分の）/ PUT / DELETE | 閉じる | 自分の情報の読み書き |
| `/api/me` | GET | 閉じる | 自分の role を返す |
| `/api/village` | GET | 閉じる | 自分の未読と勤怠の下書き |
| `/api/announcements` | GET / POST / PUT / DELETE | 閉じる | 社内のお知らせ。**噴水は描き、押せることも分かるが、中身は見えない**。押すと「ログインすると読めます」と出す（2026-08-13 PO判断） |
| `/api/rooms/[roomId]/messages` | GET / POST | 閉じる | チャット本文 |
| `/api/attendance/drafts` | GET | 閉じる | **勤怠** |
| `/api/attendance/drafts/[id]` | POST | 閉じる | **勤怠** |
| `/api/attendance/approvals` | GET | 閉じる | **勤怠** |
| `/api/attendance/approvals/[id]` | POST | 閉じる | **勤怠** |
| `/api/attendance/corrections` | GET / POST | 閉じる | **勤怠** |
| `/api/attendance/anomalies` | GET | 閉じる | **勤怠** |
| `/api/attendance/monthly` | GET | 閉じる | **勤怠** |
| `/api/ws-ticket`（**新設**） | POST | 閉じる | WSの入場券。6節 |
| `/api/demo-presence`（**新設**） | GET | **開放** | デモ用の利用者の位置。ws-server が引く |

**開放は4経路のみ**（`rooms` / `users` / `notes` / `demo-presence`）。

### 開放するAPIから機微な情報が漏れないことの担保

1. **列を明示して選ぶ。** `SELECT *` を使わない。
   `users` に `email` を足すため、`SELECT *` が1つでもあると即座に漏れる。
   → 段階1の作業に「`SELECT *` の全数検索と潰し込み」を含める（検証コマンドは 8節）
2. **未ログイン向けの応答は、専用の組み立て関数を1つだけ通す。**
   `src/lib/public-view.ts` に `publicUsers()` / `publicNotes()` を置き、
   ルートは必ずそれを呼ぶ。個別に列を選ばせない
3. **`role` / `manager_id` / `email` は、開放するAPIの応答に一切載せない。**
   自動テストで応答のJSONを文字列化し、`email` / `manager_id` / `role` / `@` を含まないことを検査する
   （`scripts/attack-*.js` と同じ形式で `scripts/attack-public.js` を追加する）

### 「見るだけモードを無効にする」切り替え

環境変数 `TENKO_PUBLIC_VIEW`（既定 `1`）1つで切る。**分岐を1か所に閉じる:**

```
src/lib/public-view.ts
  export const PUBLIC_VIEW = (process.env.TENKO_PUBLIC_VIEW ?? "1") === "1";
  export function guardPublic() { if (!PUBLIC_VIEW) → 401 }
```

- 開放している4経路は、先頭で `guardPublic()` を呼ぶ。`0` なら未ログインは 401
- ページ側（`/`）は `0` のとき未ログインを `/login` へ送る
- ws-server も同じ環境変数を見て、`0` なら入場券の無い接続を拒否する（6節）

`0` にしたときの見え方は「村そのものが見えず、ログイン画面だけ」。
中途半端に建物だけ見える状態は作らない（何が公開されているか分からなくなるため）。

---

## 5. セッションの管理

### 設定

```
session: { strategy: "database", maxAge: 60*60*24*7, updateAge: 60*60*24 }
```

- `maxAge` の既定は 2,592,000 秒（30日）なので、**604,800 秒（7日）に明示して下げる**
- `updateAge` の既定は 86,400 秒（1日）。触らない。
  意味は「セッション行の `expires` を延ばす頻度」で、1日に1回だけ UPDATE が走る。
  0 にすると毎アクセスで UPDATE になり、Neon への書き込みが増える
- ブラウザを閉じても維持される（Cookie に `maxAge` が入るため、セッションCookieにならない）

### Cookie

`@auth/core@0.41.3` の `defaultCookies` を実装で確認した。**既定のままでよい。**

| Cookie | httpOnly | sameSite | secure | path |
|---|---|---|---|---|
| `authjs.session-token`（本番は `__Secure-` 付き） | true | lax | 本番 true | / |
| `authjs.csrf-token`（本番は `__Host-` 付き） | true | lax | 本番 true | / |
| `authjs.pkce.code_verifier` / `authjs.state` | true | lax | 本番 true | /（maxAge 900秒） |

`sameSite: "strict"` にはしない。Google から戻ってくる遷移でCookieが送られず、ログインが完了しなくなるため。

### Vercel のサーバーレスで、毎回DBを見る遅延の見積もり

**見積もりであって実測ではない**（9節に「要実測」として挙げる）。

- 1回のセッション確認は `select * from sessions where "sessionToken"=$1` と
  `select * from users where id=$1` の**2クエリ**（アダプタの `getSessionAndUser` は2本投げる実装だった）
- Vercel と Neon が同じ地域なら、往復は概ね 1〜3ms/クエリ。**1リクエストあたり 2〜10ms 程度**と見積もる
- ただし**接続の確立のほうが支配的**になりうる。サーバーレスは実行環境が使い回されない場合があり、
  そのとき新規接続に 50〜200ms かかる

対策（実装時に入れる）:

1. Neon の接続文字列は **pooler 側のホスト**（`-pooler` が付くもの）を使う
2. `pg` の Pool は既に `src/lib/db.ts` でモジュール変数として使い回している。**この形を崩さない**
3. 村は WebSocket が主で、HTTP は数秒に1回の取得しかない。**体感に出る箇所は少ない**

「毎回DBを見るのが重いから JWT にする」という判断はしない。
**退職者を即座に締め出せることを優先する**という前提を、遅延で覆さない。

### 強制ログアウト（セッションの無効化）

DB方式の利点そのもの。**行を消せば終わり。**

```sql
-- 特定の人を全端末から締め出す
DELETE FROM sessions WHERE "userId" = <id>;
-- 全員を締め出す（鍵が漏れたとき）
DELETE FROM sessions;
```

- 次のHTTPリクエストで `getSessionAndUser` が空を返し、未ログイン扱いになる
- **WebSocket は繋ぎっぱなしなので、これだけでは切れない。** 6節で扱う
- 退職者は `users.deleted_at` を入れる運用にし、`actor.ts` は `deleted_at IS NULL` を必ず条件に入れる
  （**セッション行が生きていても、削除された人は入れない**）。これは既存のAPIが既に持っている条件と同じ
- 管理画面は作らない（Phase 5 の範囲外）。SQLで行う

---

## 6. WebSocket サーバーでの検証（最重要）

### 制約の整理（先に事実を置く）

1. **ブラウザの `WebSocket` は、独自のヘッダを付けられない。**
   コンストラクタが受けるのは URL と `protocols` だけ（MDN で確認）。
   よって `Authorization: Bearer ...` の形は**ブラウザからは使えない**
2. `protocols` の値は `Sec-WebSocket-Protocol` ヘッダとして送られる。
   `ws` の `WebSocketServer` は `handleProtocols(protocols, request)` でその集合を受け取れる
3. **Cookie は当てにできない。** アプリは Vercel、ws-server は Railway で**別のドメイン**になる。
   Auth.js のセッションCookieは `sameSite: lax` のため、別サイトへの接続に送られない見込み。
   （**未検証**。ブラウザのWSハンドシェイクにおける SameSite の扱いは、
   公式ドキュメントで確認できなかった。設計はCookieに依存しない形にしてあるため、結論は変わらない）

### 結論: 短命の「入場券」方式を採る

```
[1] ログイン済みの画面が、同一オリジンで POST /api/ws-ticket を叩く
      → Auth.js の auth() でセッションを確認（Cookieはここでは確実に送られる。同一オリジン）
      → 入場券を返す: base64url( userId . sessionId . exp . nonce ) + "." + HMAC-SHA256(署名鍵)
        有効期限は 60 秒。使い捨て
[2] 画面が new WebSocket(WS_URL, ["tenko.v1", "ticket." + 券]) で繋ぐ
      → 券は Sec-WebSocket-Protocol ヘッダに載る
[3] ws-server が handleProtocols で券を取り出し、署名と有効期限を検証する
      → 鍵は TENKO_WS_TICKET_SECRET。アプリと共有する
      → nonce を10分間だけ記憶し、使い回しを拒む
      → 通れば「この接続は userId の人」と確定する。以後、接続に紐づくIDだけを使う
      → 応答の Sec-WebSocket-Protocol には "tenko.v1" だけを返す（券は返さない）
[4] 券が無い接続は「見るだけ」として受ける（TENKO_PUBLIC_VIEW=1 のとき）
```

### なぜこの形か（渡し方の得失）

| 渡し方 | 得 | 失 | 採否 |
|---|---|---|---|
| クエリ文字列 `?ticket=...` | 実装が最も簡単 | **URL は経路上のログに残る**（Railway のアクセスログ、プロキシ、ブラウザ履歴）。券は短命だが、ログに認証情報が残る形は避けたい | 不採用 |
| **`Sec-WebSocket-Protocol`** | ブラウザから唯一送れるヘッダ。**URLに載らない**ためログに残りにくい | 本来の用途（サブプロトコル交渉）ではない転用。応答の扱いを誤ると接続できない | **採用** |
| 接続後の最初のメッセージ | 素直 | 認証前の接続が存在する時間ができ、その間の扱いを別に決める必要がある。タイムアウト処理が要る | 不採用 |
| セッションCookieをそのまま | 追加の仕組みが要らない | 別ドメインで送られない見込み。送られる構成にするには `sameSite=none` が必要で、CSRFの守りを弱める | 不採用 |

**セッショントークンそのものを ws-server に渡さない**ことも重要。
券が漏れても、有効期限60秒・使い捨て・WSにしか使えない。アプリのセッションは奪われない。

### ws-server から DB を引くか

**引かない。推奨は「引かない」。**

| 案 | 評価 |
|---|---|
| **A（推奨）: 引かない。** 入場時はHMACの検証のみ。無効化の確認は、アプリの `/api/ws-verify` へ定期問い合わせ | ws-server に DB の資格情報を置かなくて済む（漏洩面が1つ減る）。ws-server は既に `/api/rooms` を60秒ごとに叩いており、**同じ経路をもう1本増やすだけ**で構成が増えない |
| B: ws-server が Neon を直接引く | 無効化を即座に判定できる。ただし ws-server に `DATABASE_URL` が要り、Railway 側にDBの鍵を置くことになる。接続数も増える |

Aを採る。定期問い合わせの形:

```
ws-server → POST /api/ws-verify  { sessionIds: [...] }   ヘッダ: x-tenko-internal: <WS_NOTIFY_TOKEN と同じ形の共有秘密>
アプリ    → { valid: [...], invalid: [...] }
   valid  = sessions に行があり expires > now、かつ users.deleted_at IS NULL
```

- 間隔は **60秒**（`/api/rooms` の取得と同じ周期に相乗りさせる）
- `invalid` に入った接続は、`presence` から外し、`{type:"auth.expired"}` を送って `close(4001)` する
- 画面は 4001 を受けたら、券を取り直して繋ぎ直す。取り直せなければ「見るだけ」に落ちる

**最悪でも無効化から60秒で締め出される。** 「即座」ではないが、
勤怠は一切 WS を通っていない（在席の表示だけ）ため、この遅延で失われるものは無い。
「即座」が要るならBに切り替えればよく、切り替えは ws-server の1関数で済む形にする。

### 期限切れ・接続中の無効化

| 事象 | 扱い |
|---|---|
| 券が期限切れ（60秒超） | 接続を `close(4003, "ticket expired")`。画面は券を取り直して再接続する |
| 券の使い回し | nonce を記憶しているので拒否。`close(4003)` |
| 接続中にセッションが消された | 60秒以内の定期確認で検出し、`close(4001)` |
| 接続中にセッションが7日で期限切れ | 同上。`expires > now()` を確認しているため同じ経路で落ちる |
| 定期確認がアプリ側の障害で失敗した | **接続は維持し、ログに出す**（2026-08-13 PO判断）。落とすとVercelの障害が村の全断になる。**ただし無条件には維持しない。下の「失敗が続いた場合」を参照** |
| ws-server が再起動した | 全接続が切れ、画面が券を取り直して繋ぎ直す。揮発メモリの方針どおり、失われるのは位置だけ |

#### 定期確認の失敗が続いた場合（2026-08-13 に決めた）

無条件に維持し続けると、無効化の仕組みそのものが機能しなくなる。段階を分ける。

| 連続失敗 | 経過時間の目安 | 扱い |
|---|---|---|
| 1〜4回 | 〜4分 | **何もしない。** ログに1行出すだけ。一時的な障害はここで収まる |
| 5回 | 5分 | ログを警告に上げる。**新しい接続は今までどおり受ける**（券の検証はHMACだけででき、アプリに依存しないため） |
| **10回** | **10分** | **認証済みの接続を全て `close(4001)` で切る。** 以後、確認が1回成功するまで、券の検証を通った接続も**見るだけ扱い**にする |

10分で切ると決めた理由:

- 60秒の遅延を許容できるとした根拠は「**短時間の**障害なら在席の表示が古くなるだけ」だった。
  10分続く障害は、その前提が崩れている
- 切られた人は券を取り直して繋ぎ直す。**アプリが復旧していれば数秒で戻る**。
  復旧していなければ券が取れないので、そもそも入れない状態と一致する
- 見るだけ扱いに落とすことで、村は見えたままになる（画面が真っ白にならない）

回数はコードの定数（`VERIFY_FAIL_WARN = 5` / `VERIFY_FAIL_CUT = 10`）にし、変えられるようにする。

### 未認証の接続（見るだけモード）をどう扱うか

**WebSocket は要る。** 券の無い接続を「見るだけ」として受け入れる。

理由: 村の価値は「いま誰がどこにいるか」が動くことにある。
最初のHTMLに載せた静止画だけでは、採用担当が開いたときに「動いていない絵」に見える。
自分がログインして動かしてみせるにも、**その動きが未ログインの画面にも届く必要がある**。

見るだけの接続の扱い:

- `presence` マップに**入れない**。よって `presenceList()` に出ない = 他の人から見えない
- 受け取るのは `presence.list` の配信のみ
- **画面から送られてきたメッセージは、種別を問わず全て捨てる**
  （現在の `VIEWER_ALLOWED` の判定より前に、`ws.authed !== true` で落とす）
- `presence.sync` だけは許してよいが、**回数制限を付ける**（1接続あたり毎分6回まで）。
  許さない設計でも成立するので、実装時に単純な方を採る
- `TENKO_PUBLIC_VIEW=0` のときは、券の無い接続を `close(4004)` で即座に拒否する

これで「ログインしていない人が在席を偽装する」経路は塞がる。
**在席の一覧に載るには、券による検証を通った接続であることが必要**になるため。

### デモ用の利用者を、接続なしで村に出す

- ws-server は `/api/demo-presence` を60秒ごとに取得する（`/api/rooms` と同じ形）
- `presenceList()` は「実際の接続から作った一覧」＋「デモ用の一覧」を結合して返す
- 同じIDが両方にある場合は、**実際の接続を優先する**（デモ用の人が実在の人と重なることは無いが、念のため）
- デモ用の利用者は動かない。`presence.move` の対象にならない（接続が無いので構造的に不可能）
- 部屋の人数（`roomCounts`）にはデモ用も数える。数えないと、村の見た目と定員の表示が食い違う

**常時動くデモ用のプロセスは作らない。** 指示どおり。

---

## 7. セキュリティ上の要点

### CSRF

| 対象 | 対策 |
|---|---|
| Auth.js 自身の経路（`/api/auth/*`） | Auth.js が CSRF トークン（`authjs.csrf-token`、二重送信方式）を持っている。触らない |
| tenko 自作の POST / PUT / DELETE | **2層で守る。** (1) セッションCookieが `sameSite: lax` なので、他サイトからの POST には送られない。(2) それに頼らず、`src/lib/guard.ts` に `assertSameOrigin(req)` を置き、`Origin` ヘッダが自分のオリジンと一致することを全ての書き込み経路で確認する |
| GET | 状態を変えないため対象外。**ただし「GETで状態を変える経路を作らない」ことを規律として明記する** |

`sameSite: lax` は「他サイトからのトップレベルGET遷移ではCookieを送る」ため、
**GETで書き込む経路があるとCSRFが成立する**。現状そのような経路は無いことを確認済み
（書き込みは全て POST / PUT / DELETE）。

### オープンリダイレクト

- Auth.js の `redirect` コールバックは、**既定で同一ホストのURLしか許さない**。
  この既定を**弱めない**（`redirect` コールバックを自作しない）
- 自作のログイン後の戻り先（`?next=`）を作る場合は、**`/` で始まり `//` で始まらない相対パスだけを通す**。
  外部URLは無条件に `/` に落とす。判定は `src/lib/guard.ts` の1関数に閉じる
- そもそも戻り先を持たない設計（常に `/` に戻す）でも要件を満たす。**単純な方を推奨する**

### Server Component と Client Component でのセッション取得の違い

| 場所 | 取り方 | 注意 |
|---|---|---|
| Server Component / ページ | `const session = await auth()` を直接呼ぶ | **DBを引く。** 同じページで何度も呼ばない（React の `cache()` で1リクエスト1回にまとめる） |
| Route Handler（API） | `auth()` を呼ぶ、または `export const GET = auth(handler)` の形 | **どちらでも、必ずハンドラの中で確認する** |
| Client Component | `useSession()`（`SessionProvider` が要る）または、サーバから props で渡す | **クライアントのセッションは表示の分岐にしか使わない。担保にはしない。** tenko は既にこの考え方（Phase 4）で書かれている |

tenko では**Client Component にセッションを配らない方を推奨する。**
`village-client.tsx` は現在 `me` を props 相当で受け取る形になっているので、
サーバ側で `auth()` を呼び、`{ id, displayName, role }` だけを props で渡せばよい。
`SessionProvider` を足さずに済み、`email` がクライアントに渡らない。

### proxy だけに頼らない多層の検証

Next.js 16 のドキュメントが自らこう書いている（`node_modules/next/dist/docs` で確認）:

> Proxy is _not_ intended for slow data fetching. … it should not be used as a full session management or authorization solution.
> A matcher change or a refactor that moves a Server Function to a different route can silently remove Proxy coverage.
> **Always verify authentication and authorization inside each Server Function rather than relying on Proxy alone.**

Auth.js のドキュメントも同じことを書いている:

> You should not rely on the proxy exclusively for authorization.
> Always ensure that the session is verified as close to your data fetching as possible.

**tenko の層の分け方:**

| 層 | 役割 | これだけでは守れない |
|---|---|---|
| 1. `proxy.ts` | 未ログインを `/login` へ送る**だけ**。体験のための層 | **そのとおり。担保にしない** |
| 2. ページ（Server Component） | `auth()` で確認し、無ければ表示しない | 直接APIを叩かれると通る |
| 3. **API ハンドラ** | `requireActor()` でセッションを取り、`users` を引き直す。**ここが担保** | — |
| 4. DB のトリガー・制約 | 承認済みの記録を凍結する（Phase 3・4で既にある） | — |
| 5. ws-server | 入場券の検証（6節）。**接続に紐づくIDだけを使う** | — |

なお `proxy.ts` は Next.js 16 で **既定が Node.js ランタイム**になった
（`v16.0.0`: "Middleware is deprecated and renamed to Proxy. Proxy defaults to the Node.js runtime"）。
そのため Auth.js を Edge 用と Node 用に分割する構成は**要らない**。
それでも上の分担は変えない。

CVE-2025-29927 について: Next.js 16.3.0 は修正済みのため、この脆弱性自体の影響は無い。
ただし「proxy を跨げると認可が飛ぶ設計」を作らない、という教訓のみ採る。

### 既存のAPI全てに認証を入れる場合、漏れをどう防ぐか

**「入れ忘れ」を人の注意力で防がない。** 3つの機械的な仕掛けを置く。

1. **入口を1つにする。**
   `src/lib/actor.ts` の `requestedUserId()` を**削除**し、`requireActor()` に置き換える。
   `requireActor()` はセッションが無ければ例外を投げる。
   **引数を取らない**ので、リクエストから利用者IDを渡す経路が構文的に消える
2. **開放するものだけを明示的に書く。**
   `src/lib/public-view.ts` に開放する4経路の名前を定数で持ち、
   開放するルートは `allowPublic()` を明示的に呼ぶ。**書かなければ閉じている**という向きにする
3. **一覧の突き合わせを検証スクリプトにする。**
   `scripts/verify-auth-coverage.js` を作り、`src/app/api` 以下の全 `route.ts` を走査して
   「`requireActor` も `allowPublic` も呼んでいないファイル」を落とす。
   新しいAPIを足したとき、どちらも書かなければ検証で落ちる
4. 実際に叩いて確かめる。`scripts/attack-public.js` を作り、
   **Cookie無しで全17経路を叩いて 401 が返ること**（開放4経路を除く）と、
   開放した応答に `email` / `role` / `manager_id` が含まれないことを検査する
   （既存の `scripts/attack-*.js` と同じ形式）

---

## 8. 移行の手順

**動いているアプリに後から入れる。途中で壊れない順に並べた。**
各段階の終わりでアプリは動作する状態にする。

| 段階 | 内容 | 途中で壊れないか | 元に戻す手順 |
|---|---|---|---|
| **0** | Google Cloud で OAuth クライアントを作る。環境変数を Vercel / Railway に入れる（値はチャットに出さない） | コードを変えないので壊れない | 環境変数を消す |
| **1** | **DDL を実行**（2節）。`users` に4列 + `is_demo`、`accounts` / `sessions` / `verification_token` / `demo_presence` を作る。**追加のみで既存の列は変えない** | 壊れない（誰も新しい列を読まない）。ただし `SELECT *` が残っていると `email` が漏れるため、**この段階で `SELECT *` の全数検索と潰し込みを行う** | 2節のロールバックSQL |
| **2** | Auth.js を入れる。`auth.ts` / `/api/auth/[...nextauth]` / `/login` / 拒否画面。**まだ既存のAPIには手を入れない**。ログインできるが、何も変わらない | 壊れない。既存の経路は `TENKO_TRUST_USER_PARAM=1` のまま動く | ブランチを戻す。DDLは残してよい |
| **3** | **`actor.ts` を差し替える。** `requestedUserId()` → `requireActor()`。全13経路を書き換え、画面から `?user=` を全て外す。`TENKO_DEV_USER_ID` / `TENKO_TRUST_USER_PARAM` を削除 | **ここが一番危ない。** 書き換え漏れがあるとその経路だけ 500 か 401 になる。段階3の完了条件を「`verify-auth-coverage.js` と `attack-public.js` が両方通ること」にする | ブランチを戻す |
| **4** | **見るだけモード。** `public-view.ts`、開放4経路、`/` の未ログイン表示、`proxy.ts` | 段階3でいったん全部閉じているため、ここは開ける作業。壊れる向きが「見えない」側なので安全 | `TENKO_PUBLIC_VIEW=0` にすれば見るだけモードだけ止まる |
| **5** | **デモ用の利用者。** `is_demo` を立て、`demo_presence` を埋め、`/api/demo-presence` と ws-server の結合 | 壊れない。失敗しても村が空になるだけ | `is_demo` を全て false に戻す |
| **6** | **ws-server の検証。** `/api/ws-ticket`、`handleProtocols`、`/api/ws-verify` の定期確認、見るだけの接続 | **画面と ws-server を同時に変える必要がある。** 先に ws-server を「券があれば認証済み・無ければ見るだけ」の**両対応**で出し、後から画面を券つきに変える。この順なら片方ずつ出せる | ws-server を前の版に戻す（Railway の再デプロイ） |
| **7** | 攻撃スクリプトでの検証と、README / TENKO_STATE の更新。「お試し版・ログインなし」の表示を外す | — | — |

**既存の26人（実体は56人）のデータの扱い**（段階5）:

- 行は消さない。過去のチャット・勤怠が外部キーで参照している
- 実在する人にだけ `email` を入れる。それ以外は `is_demo = true`
- **判断が要る**: 56人全員をデモとして村に出すと、村が過密になる可能性がある。
  Phase 4.9 で「22人で重なり0」を実測しているため、56人は未実測の領域。
  何人を村に出すかはPOに確認したい（9節）

### 元に戻す手順（全体）

1. Vercel で1つ前のデプロイに戻す（アプリ）
2. Railway で1つ前のデプロイに戻す（ws-server）
3. 環境変数 `TENKO_DEV_USER_ID` / `TENKO_TRUST_USER_PARAM` を戻す
4. DBは**戻さなくてよい**（全て追加であり、古いコードは新しい列を読まない）。
   完全に戻す場合のみ2節のロールバックSQLを使う

**DBを戻さずにコードだけ戻せる**ように、DDLを全て「追加のみ」で設計してある。

---

## 9. 工数の見積もりと、答えを持たない事項

### 工数

| 段階 | 内容 | 見積 | 根拠 |
|---|---|---|---|
| 0 | Google OAuth クライアント・環境変数 | 1.0h | 画面での操作のみ |
| 1 | DDL + `SELECT *` の潰し込み | 1.5h | DDL は文面済み。潰し込みが読めない |
| 2 | Auth.js 導入・ログイン画面・拒否画面 | 3.5h | beta のため、詰まったときの調べ物を含む |
| 3 | `actor.ts` の差し替えと全13経路 + 画面の `?user=` 除去 | 5.0h | ルート13本 + `village-client.tsx`（1257行）の書き換え |
| 4 | 見るだけモード | 3.0h | 4経路 + 画面の未ログイン表示 + proxy |
| 5 | デモ用の利用者 | 2.5h | 1経路 + ws-server の結合 + 配置の調整 |
| 6 | **ws-server の検証** | **6.0h** | 最難関。下記 |
| 7 | 攻撃スクリプト・文書更新 | 2.5h | 既存の `attack-*.js` の形を流用 |
| | **合計** | **25.0h** | |

### 最も難しいと予想する箇所: 段階6（ws-server の検証）

理由は3つ。

1. **ブラウザ・`ws`・Railway の3者にまたがる。** どこで落ちているかが分かりにくい。
   特に `Sec-WebSocket-Protocol` の交渉は、応答の値を誤ると
   ブラウザ側が「接続できません」としか言わずに切る（原因が読めない形で失敗する）
2. **画面と ws-server を同時に変えたくなる。** 両対応で段階を分ける設計にしたが、
   実際には行き来が発生する
3. **一度に検証できない。** ローカルでは同一オリジンになるため、
   Cookie の有無やドメインの違いに起因する問題がローカルで再現しない。
   Railway に上げてから初めて出る問題がありうる

対策として、段階6は**先に `spike/ws-auth-01` として最小の実験を切る**ことを推奨する
（Phase 0 で WebSocket の実現性を確認したのと同じやり方）。実験の内容:
「券つきで繋がるか」「券なしで見るだけになるか」「`close(4001)` を画面が拾えるか」の3点だけ。

### POに判断してほしい点

1. **`allowDangerousEmailAccountLinking: true` を付けてよいか**（3節）。
   付けないと、`users` に登録済みの人が初回ログインで `OAuthAccountNotLinked` になり、**誰もログインできない**。
   Google 1つだけ・`email_verified` を自分でも確認する構成では実質的な危険は無いと判断しているが、
   オプション名に「dangerous」と入っているため確認したい
2. **`/api/notes`（今日やること）を未ログインに開放してよいか**（4節）。
   村の吹き出しはデモの主要な表現だが、中身は業務内容である。
   開放しない場合、未ログインの村では吹き出しが出ない（人と建物だけになる）
3. **定期確認がアプリ側の障害で失敗したとき、既存の接続を維持するか切るか**（6節）。
   維持を推奨（Vercelの障害で村が全断するのを避ける）。切る方が厳格
4. **56人のうち何人をデモとして村に出すか**（8節）。22人までは実測済み、56人は未実測
5. **見るだけモードで、噴水（お知らせ）をどう見せるか**。
   「ログインすると読めます」を推奨。噴水そのものを描かない案もある

### 現時点で答えを持たない事項

| 事項 | 区分 | 内容 |
|---|---|---|
| `bigint` の `id` がセッションで文字列になるか | **実測済み（2026-08-13）** | **文字列で返る。** 素の `pg` もアダプタの `getUser` も `typeof id === "string"`（`scripts/probe-id-type.mjs`）。`auth.ts` の `session` コールバックで `Number()` に通している |
| WSハンドシェイクでの SameSite Cookie の扱い | **確認できず** | ブラウザの WebSocket ハンドシェイクに `sameSite: lax` のCookieが送られるかを、公式ドキュメントで確認できなかった。設計はCookieに依存しないため結論は変わらない |
| Auth.js の Cookie 既定値の公式ドキュメント | **確認できず（実装では確認済み）** | `authjs.dev/reference/core` には既定値の一覧が無い。`@auth/core@0.41.3` の `lib/utils/cookie.js` の実装から読み取った。**ドキュメントではなく実装が出典である**ことを明記する |
| `OAuthAccountNotLinked` が tenko の構成で実際に出るか | **仮説** | アダプタの実装とAuth.jsのエラー定義からの推論。段階2で必ず実機で確認する |
| Vercel → Neon のセッション確認の実遅延 | **要実測** | 5節の 2〜10ms は見積もりであって実測ではない。段階3の完了時に実測する |
| Railway の費用 | **未確定** | TENKO_STATE 5節のとおり、Phase 5 直前に実測する前提のまま。**この設計では扱っていない** |
| 56人を村に出したときの描画の重なり | **未実測** | 22人までは実測済み（PHASE49_LOG.md） |
| `next-auth` beta の今後の破壊的変更 | **予測不能** | ピン留めで固定する。上げるときは段階2の検証を再実行する |

---

## 10. 出典

**公式ドキュメント / 一次情報**（2026-08-13 に確認）

| 内容 | 出典 |
|---|---|
| `next-auth` の dist-tags（latest 4.24.15 / beta 5.0.0-beta.32） | https://registry.npmjs.org/next-auth |
| `next-auth@5.0.0-beta.32` の peerDependencies（next ^16 を含む）・`@auth/core@0.41.3` | https://registry.npmjs.org/next-auth/5.0.0-beta.32 |
| `@auth/pg-adapter` の最新版 1.11.3・peer `pg ^8` | https://registry.npmjs.org/@auth/pg-adapter |
| pg アダプタのインストールとスキーマ | https://authjs.dev/getting-started/adapters/pg |
| アダプタが実際に投げるSQL（createUser / getSessionAndUser 等） | https://unpkg.com/@auth/pg-adapter@1.11.3/index.js（実装） |
| セッション方式（database / jwt）と無効化 | https://authjs.dev/concepts/session-strategies |
| `session.maxAge` の既定 2592000 秒・`updateAge` 86400 秒・`signIn` / `redirect` コールバック | https://authjs.dev/reference/core#session |
| Cookie の既定値（httpOnly / sameSite lax / secure / path） | https://unpkg.com/@auth/core@0.41.3/lib/utils/cookie.js（**実装**。ドキュメントには記載が無かった） |
| 「proxy だけに頼るな」 | https://authjs.dev/getting-started/session-management/protecting |
| `signIn` コールバックがアダプタの書き込みより前に走ること | https://unpkg.com/@auth/core@0.41.3/lib/actions/callback/index.js（実装） |
| `AccessDenied` / `OAuthAccountNotLinked` の挙動 | https://authjs.dev/reference/core/errors |
| `allowDangerousEmailAccountLinking` の既定と意味 | https://authjs.dev/reference/core/providers#allowdangerousemailaccountlinking |
| Next.js 16 の Proxy（`middleware.ts` → `proxy.ts`、既定が Node.js ランタイム、「Proxy だけに頼るな」） | `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md` および `.../03-api-reference/03-file-conventions/proxy.md`（**同梱の実物**） |
| ブラウザの `WebSocket` が独自ヘッダを送れないこと・`protocols` が `Sec-WebSocket-Protocol` になること | https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket |
| `ws` の `handleProtocols` / `verifyClient`（verifyClient は非推奨） | https://github.com/websockets/ws/blob/master/doc/ws.md |

**実体の確認**（このリポジトリ / DB）

| 内容 | 確認方法 |
|---|---|
| `users` の列と件数（56人・email 列なし） | Neon への読み取りクエリ（`information_schema.columns` / `count(*)`） |
| 既存のAPI 13経路と `requestedUserId` の使われ方 | `src/app/api/**/route.ts` の読み取り |
| ws-server が認証を持たないこと | `ws-server/index.js` の読み取り |

---

## 11. 変更ログ

- 2026-08-13 初版作成。**設計のみ。実装・DDL実行は行っていない。** POの検収待ち
- 2026-08-13 POの検収に合格。判断5件を反映した。
  (1) `allowDangerousEmailAccountLinking` を承認（別の提供元を追加する場合は見直す旨を明記）
  (2) `/api/notes` は開放するが**デモ用の利用者の分だけ**
  (3) `/api/ws-verify` の失敗時は接続を維持。**連続10回（約10分）で切る段階を追加した**（CCが決定）
  (4) 村に出すデモ用の利用者は20人前後。残りは一覧にのみ出す
  (5) 見るだけモードの噴水は「押せるが中身は見えない」
- 2026-08-13 段階1の実行にあわせ、`ALTER COLUMN display_name SET DEFAULT` を落とした
  （既存の列の既定値を変える操作であり、実行条件に反するため）。`bigint` の実測結果を反映した
