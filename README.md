# BandLab MVP (Local First)

バンド制作向けのMVPです。以下をローカルで動かします。

- セッション要件メモ: `docs/session-context-2026-02-22.md`

- `apps/web`: Next.js フロントエンド (`http://localhost:3000`)
- `apps/worker`: Cloudflare Workers + Hono API (`http://localhost:8787`)
- Supabase Local: Auth + Postgres (`http://127.0.0.1:54321`)
- MinIO: S3互換ストレージ (`http://localhost:9000`, Console `http://localhost:9001`)

## 技術スタック

- `pnpm + turborepo`
- `Next.js (TypeScript)`
- `Hono on Cloudflare Workers (wrangler dev)`
- `Supabase local (Auth + Postgres)`
- `MinIO (S3互換, presigned PUT)`
- `Zod`（`packages/shared`）

## 重要設計メモ

- D1: `MixSession` を採用
- D2: `audio_preview(mp3)` + `audio_source(wav)` + `midi` を同時運用
- D3: `tracks.active_revision_id` で採用リビジョンを保持（線形のみ）
- `revision_number` は **案A（カウンタ方式）** を採用
  - `track_revision_counters` + `allocate_track_revision_number(track_id)` で競合を回避

## セットアップ

### 1. 依存インストール

```bash
pnpm install
```

### 2. Supabase local 起動

```bash
supabase start
```

起動後、以下を取得して環境変数へ設定します。

```bash
supabase status
```

### 3. MinIO 起動（bucket + CORS適用）

```bash
docker compose up -d
```

- bucket: `band-daw`
- CORS: `scripts/minio-cors.json` が `minio-init` で適用されます

### 4. 環境変数

```bash
cp apps/web/.env.local.example apps/web/.env.local
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
```

`supabase status` で出た `anon key` / `service_role key` を設定してください。

### 5. 開発起動

ターミナル1:
```bash
pnpm --filter worker dev
```

ターミナル2:
```bash
pnpm --filter web dev
```

## マイグレーション

- SQL: `supabase/migrations/202602220001_init.sql`
- テーブル:
  - `bands`, `band_members`
  - `songs`
  - `tracks`
  - `track_revision_counters`, `track_revisions`
  - `track_assets`
  - `mix_sessions`, `mix_session_tracks`
  - `notes`, `decisions`
- enum:
  - `asset_type`: `audio_preview | audio_source | midi`
  - `asset_status`: `pending | uploaded | ready | failed`

## API Routes（MVP）

### Auth / Me

- `GET /api/health`
- `GET /api/me`

### Band

- `POST /api/bands`
- `POST /api/bands/join`

### Songs

- `GET /api/songs` (`x-band-id` 必須)
- `POST /api/songs` (`x-band-id` 必須)
- `GET /api/songs/:songId`
- `PATCH /api/songs/:songId`

### Tracks / Revisions

- `GET /api/songs/:songId/tracks`
- `POST /api/songs/:songId/tracks`
- `PATCH /api/tracks/:trackId`
- `GET /api/tracks/:trackId/revisions`
- `POST /api/tracks/:trackId/revisions`
- `POST /api/tracks/:trackId/active`

### Assets

- `POST /api/revisions/:revisionId/assets/presign`
- `POST /api/assets/:assetId/complete`
- `GET /api/assets/:assetId/stream`
  - `Range` ヘッダ対応（`206 Partial Content`）
  - `<audio>` 再生のため `?token=<access_token>` でも認証可

### MixSession

- `GET /api/songs/:songId/sessions`
- `POST /api/songs/:songId/sessions`
- `GET /api/sessions/:sessionId`
- `PUT /api/sessions/:sessionId/tracks`

### Notes / Decisions

- `GET/POST /api/songs/:songId/notes`
- `PATCH/DELETE /api/notes/:noteId`
- `GET/POST /api/songs/:songId/decisions`
- `PATCH/DELETE /api/decisions/:decisionId`

## 使い方（手動テスト）

1. ログイン画面でユーザー作成（email/password）
2. `Create Band` でバンド作成し `invite_code` を確認
3. 別ユーザーでログインし `Join Band` から同じ `invite_code` を入力
4. Song作成 → Track追加 → Revision追加
5. Revisionごとに `mp3/wav/midi` をアップロード
6. `Play/Pause/Seek` で複数トラック同時再生
7. `Mute/Gain/Pan` 調整
8. MixSession作成・選択・保存
9. Notes/Decisions の追加・編集・削除

## ステータスコード方針

- `401`: 未ログイン
- `403`: band member ではない
- `404`: song/track/revision/asset が存在しない
- `409`: revision競合や asset unique競合
- `413`: Worker経由の大容量アップロードは非推奨（presigned PUT使用）

## 実装メモ

- RLSは基本ポリシーを migration に追加済み
- ただしMVPの主制御は API 側で band membership を明示チェック
- 同時再生は `<audio>` + `WebAudio (GainNode + StereoPannerNode)`
- seek時は全トラックの `currentTime` を更新
- WAVは保管向け、実運用の同時再生はMP3 preview推奨

## TODO（将来）

- Cloudflare R2 binding への切替（S3 endpoint/env依存を置換）
- RLS完全移行（service role 依存の最小化）
- セッション状態の差分保存と履歴管理
- 音声長の自動解析（duration/sample_rate/channels）
- E2Eテスト（Play/Seek/Uploadフロー）
