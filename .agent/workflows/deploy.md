---
description: GitHub/Vercel/Supabaseへのデプロイ手順
---

# デプロイワークフロー

デプロイ時は必ず [deploy-guide.md](../../docs/deploy-guide.md) を参照すること。

## 通常デプロイ（コード変更のみ）

// turbo-all

1. 変更をコミットする
```bash
git add -A && git commit -m "<type>: <内容>"
```

2. mainにプッシュする（Vercel自動デプロイ + GitHub Actions）
```bash
git push origin main
```

## DBスキーマ変更を含むデプロイ

1. `supabase/migrations/` にSQLファイルを作成する
   - ファイル名: `YYYYMMDDHHMMSS_description.sql`

2. SQLを記述する（CREATE TABLE / ALTER TABLE など）

3. コミットする
```bash
git add supabase/migrations/ && git commit -m "feat: マイグレーション追加 — <内容>"
```

4. mainにプッシュする
```bash
git push origin main
```
→ GitHub Actionsが自動で `supabase db push` を実行

## 緊急デプロイ（Supabase手動SQL実行）

Management APIで直接SQLを実行する場合:
```bash
python3 -c "
import json, urllib.request
sql = open('supabase/migrations/YOUR_FILE.sql').read()
url = 'https://api.supabase.com/v1/projects/mfwgpicsalflypomhuly/database/query'
req = urllib.request.Request(url,
    data=json.dumps({'query': sql}).encode('utf-8'),
    headers={
        'Content-Type': 'application/json',
        'Authorization': 'Bearer \$(grep SUPABASE_ACCESS_TOKEN .env | cut -d= -f2)',
        'User-Agent': 'Mozilla/5.0',
    }, method='POST')
with urllib.request.urlopen(req) as resp:
    print(resp.read().decode('utf-8'))
"
```
