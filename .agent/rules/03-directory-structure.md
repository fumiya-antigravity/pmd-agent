---
description: "ディレクトリ構造と各ディレクトリの責務定義。ファイル配置ルール。"
alwaysApply: true
---

# 03: ディレクトリ構造

## 構造

```
pdm-agent/
│
├── .agent/                         ★ 開発プロセスの司令塔
│   ├── rules/                      ← 開発ルール（コーディングAI向け）
│   │   ├── 01-project-overview.md
│   │   ├── 02-architecture.md
│   │   ├── 03-directory-structure.md（このファイル）
│   │   ├── 04-coding-standards.md
│   │   ├── 09-git-workflow.md
│   │   └── 10-deploy.md
│   └── workflows/
│       └── deploy.md
│
├── public/                         ← 静的ファイル（配信対象）
│   ├── index.html
│   └── styles.css
│
├── src/                            ← フロントエンドソース
│   ├── app.js                      ← Flow層（状態管理・UI制御）
│   ├── supabase-client.js          ← DB連携
│   └── ai/                         ★ プロダクトAIの振る舞い定義
│       ├── rules/                  ← プロダクトAIのルール
│       ├── crews/                  ← Crew層（各知的処理ユニット）
│       ├── prompts/                ← 各Crew専用プロンプト
│       └── context-budget.js       ← トークン予算管理
│
├── api/                            ← Vercel Edge Functions
│   └── chat.js
│
├── docs/                           ← プロダクトドキュメント
│   ├── requirements-definition.md
│   ├── deploy-guide.md
│   └── research/
│
├── supabase/                       ← DB定義
│
├── server.py                       ← ローカル開発用
├── package.json / vercel.json      ← 設定
└── .env / .env.example / .gitignore
```

## 配置ルール

| 新しいファイルの種類 | 置く場所 |
|---|---|
| 静的アセット（HTML/CSS/画像） | `public/` |
| フロントエンドロジック | `src/` |
| プロダクトAIルール/プロンプト | `src/ai/` |
| Vercel API | `api/` |
| 開発ルール | `.agent/rules/` |
| ドキュメント/リサーチ | `docs/` |
| DBマイグレーション | `supabase/migrations/` |

## 禁止事項

- root直下に新しいJSファイルを置かない（`ai_api.js`は移行中のバックアップ）
- root直下に新しいMDファイルを置かない（docs/または.agent/rules/に配置）

## 自動更新ルール

> ⚠️ ファイル/ディレクトリの追加・移動・削除時に、このファイルを必ず更新すること。
