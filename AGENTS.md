# AGENTS.md

## このリポジトリでの実運用メモ（2026-02-22 セッション学び）

- 回答・レポートは日本語で行う。
- 変更後は必ず `typecheck` を実行し、必要なら実アクセスで動作確認する。

## ローカル起動の前提

- `pnpm dev` だけでは外部依存（Supabase Local / MinIO）が自動起動しない。
- 以下を先に起動してから `pnpm dev` を実行する。
  - `npx -y supabase@latest start`
  - `docker compose up -d`

## 環境変数運用

- `.env` はリポジトリルート 1 ファイル運用。
- `.env` には秘匿情報のみを置く（固定値はコード側 config にコミット）。
- Supabase Local キーは毎回実値を使う。`your_anon_key` のままだとログイン不可。
- 反映例: `npx -y supabase@latest status -o env` の `ANON_KEY` / `SERVICE_ROLE_KEY` を `.env` へ設定。

## Web/Worker 設定方針

- Web の固定値は `apps/web/lib/app-config.ts` を参照。
- Worker の固定値は `apps/worker/src/config.ts` を参照。
- Worker は `apps/worker/scripts/load-env-and-run.sh` で `.env` から `.dev.vars` を自動生成して起動する。

## 既知の落とし穴

- `supabase.auth.signInWithPassword` / `signUp` を変数へ代入して呼ぶと `this` が外れて壊れる。
  - NG: `const fn = supabase.auth.signInWithPassword; await fn(...)`
  - OK: `await supabase.auth.signInWithPassword(...)`
- この事故は `pnpm guard:unbound-supabase-auth` で検出可能。

## アップロード周り

- 現在の仕様は「アップロード時に Revision を自動生成」。
- `Failed to fetch` は多くの場合 MinIO (`localhost:9000`) 未起動。
- `presign 404` が出る場合は worker の JOIN 実装差分を疑う（FK 明示が必要）。

## UI テスト時の確認順

1. `http://localhost:3000` が 200 で開く
2. サインアップ/ログインできる
3. Band 作成できる
4. Song/Track 作成できる
5. mp3/wav/midi の presign が 200 になる

