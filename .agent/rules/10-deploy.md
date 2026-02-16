---
description: "デプロイルール。Vercel/Supabase/GitHubへのデプロイ手順と注意事項。"
alwaysApply: true
---

# 10: デプロイルール

## 必読ドキュメント

デプロイ作業を行う際は、必ず以下を参照すること:
- **手順書**: [docs/deploy-guide.md](../../docs/deploy-guide.md)
- **ワークフロー**: `.agent/workflows/deploy.md`（`/deploy` で呼び出し可能）

## デプロイ原則

1. **mainプッシュ = 本番デプロイ**
   - `main` へのプッシュはVercel自動デプロイ + GitHub Actions（Supabase）を起動する
   - プッシュ前に必ず動作確認を行う

2. **DBスキーマ変更はマイグレーションファイルで管理**
   - 直接Supabaseダッシュボードでスキーマを変更しない
   - `supabase/migrations/` にSQLファイルを追加する
   - ファイル名は `YYYYMMDDHHMMSS_description.sql` 形式

3. **環境変数の安全管理**
   - `.env` は絶対にコミットしない（`.gitignore`で除外済み）
   - Vercel/GitHub Secretsに必要な変数が設定されていることを確認する

4. **デプロイ後の確認**
   - Vercelダッシュボードでデプロイ成功を確認
   - GitHub ActionsタブでSupabase pushの成功を確認

## エージェント（AI）への指示

AIエージェントがデプロイを行う際:
1. `/deploy` ワークフローに従って実行する
2. DBスキーマ変更がある場合はマイグレーションファイルを先に作成する
3. コミットメッセージはConventional Commitsに従う
4. プッシュ後にエラーがないか確認する
