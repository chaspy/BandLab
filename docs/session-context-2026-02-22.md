# Session Context (2026-02-22)

このファイルは、2026-02-22 の実装セッションで確定した背景・要件・方針を、次回以降も参照できるように残すためのメモです。

## 背景とゴール

- 対象: バンド制作向けWebアプリのMVP
- 目的:
  - 曲 -> トラック -> リビジョン -> 音源/MIDI を一元管理
  - 複数トラックの同時再生で全体確認
  - Notes/Decisions で意思決定ログを残す
- まずはローカルで確実に動くことを最優先
- 将来は Cloudflare Workers/Pages + Supabase + R2 を想定

## このセッションでの確定事項（重要）

- D1: MixSession を導入（曲全体の採用状態スナップショット）
- D2: 音源運用は `preview mp3 + source wav`（両方アップ可）
- D3: `tracks.active_revision_id` で採用リビジョンを保持（線形のみ、ブランチなし）

## MVP必須要件（要約）

- 認証: Supabase Auth
- バンド参加: invite code 方式（メール招待なし）
- 主要画面:
  - Login
  - Onboarding（Create/Join Band）
  - Songs list
  - Song detail（Tracks/Revisions/Upload/Player/MixSession/Notes/Decisions）
- Assetアップロード:
  - Worker経由直送ではなく presigned PUT（ブラウザ -> S3互換）
  - upload後に complete API で `ready` 化
- 再生:
  - `/api/assets/:assetId/stream` の Range 対応必須
  - 同時再生は `<audio> + WebAudio(Gain/Pan)`

## 実装方針（要約）

- モノレポ: `pnpm + turborepo`
- 構成:
  - `apps/web` (Next.js)
  - `apps/worker` (Cloudflare Workers + Hono)
  - `packages/shared` (Zod schema)
  - `supabase/migrations` (SQL)
- ローカル基盤:
  - Supabase local
  - MinIO (docker-compose)
- APIは `/api/*` に集約

## DB設計での重要ポイント

- テーブル群: bands, band_members, songs, tracks, track_revisions, track_assets,
  mix_sessions, mix_session_tracks, notes, decisions
- revision採番は **案A（counter方式）** を採用
  - `track_revision_counters`
  - `allocate_track_revision_number(track_id)`
- enum/unique/index を付与
- RLSポリシーを追加（MVPではAPI側 membership チェックも実施）

## API仕様で特に重要な点

- `Authorization: Bearer <access_token>`
- Band境界は membership チェックで保護
- Assets:
  - `POST /api/revisions/:revisionId/assets/presign`
  - `POST /api/assets/:assetId/complete`
  - `GET /api/assets/:assetId/stream`（Range対応）
- MixSession:
  - 作成時 base=`active|latest`
  - trackごとの `track_revision_id/mute/gain_db/pan/start_offset_ms` を保存

## 非ゴール（このセッション時点）

- ブランチ/マージ
- 波形編集、MIDIピアノロール編集
- 権限細分化
- リアルタイム同時編集
- モバイル最適化

## ローカル起動要件（再掲）

- `supabase start`
- `docker compose up -d`（MinIO + bucket + CORS）
- `pnpm --filter worker dev`
- `pnpm --filter web dev`

詳細手順は `README.md` を参照。

## 将来TODO（このセッションでの合意）

- R2 binding への切替
- RLS中心のアクセス制御への移行
- E2Eテスト拡充
- メタ情報（duration/sample_rate/channels）の自動抽出強化
