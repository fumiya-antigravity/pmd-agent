---
description: "コーディング規約。命名規則、Crew実装、プロンプト管理、エラーハンドリング、ワークスペースルール記述規約。"
alwaysApply: true
---

# 04: コーディング規約

## 言語

- **JavaScript**: ES6+（Vanilla、フレームワークなし）
- **CSS**: Vanilla CSS（TailwindCSS不使用）
- **Python**: サーバーのみ（ローカル開発用）

## 命名規則

| 対象 | 規則 | 例 |
|---|---|---|
| ファイル名 | kebab-case | `context-budget.js` |
| 変数/関数 | camelCase | `buildContext()` |
| 定数 | UPPER_SNAKE_CASE | `MAX_PIPELINE_CALLS` |
| CSSクラス | kebab-case | `.chat-messages` |
| Crew名 | PascalCase（コード内） | `AnalysisCrew` |

## Crew実装規約

各Crewは以下の構造に従う:

```javascript
// src/ai/crews/example.js
const ExampleCrew = (() => {
  'use strict';

  // Crewが必要とするプロンプトをインポート
  // const PROMPT = ExamplePrompt.get();

  async function execute(input, signal) {
    // 入力バリデーション
    // API呼び出し
    // 出力スキーマ検証
    return result;
  }

  return { execute };
})();
```

## プロンプト管理規約

- 各Crewのプロンプトは `src/ai/prompts/` に独立ファイルとして配置
- プロンプトの変更は対応するCrewの動作にのみ影響すること
- プロンプト内に他Crewの責務に関する指示を書かないこと

## エラーハンドリング

- Crew失敗時は必ずフォールバック処理を用意する
- `console.warn()` でログを出力し、ユーザー体験を壊さない
- `try/catch` でAPI呼び出しを囲む

## ワークスペースルール記述規約（`.agent/rules/`）

### 必須フォーマット

全ルールファイルは**YAMLフロントマター**で始めること。フロントマターなしのルールはAIに認識・適用されない。

```yaml
---
description: "ルールの概要説明。何について、どのような場面で適用するか。"
alwaysApply: true
---

# ルールタイトル
（本文）
```

### 活性化モード

| モード | フロントマター | 用途 |
|--------|--------------|------|
| **Always On** | `alwaysApply: true` | 全作業で常に適用（基本はこれ） |
| **Model Decision** | `alwaysApply: false` + `description`のみ | AIが`description`を読んで適用判断 |
| **Glob** | `glob: "*.js"` | 特定ファイルパターンに一致する場合のみ適用 |
| **Manual** | フロントマターなし | `@ルール名`で明示的に呼び出した時のみ |

### descriptionの書き方

- **1文で要約**: ルールが何を定義しているかを簡潔に
- **適用場面を明記**: 「〜の変更時は必ず参照」等
- **キーワードを含める**: AIが適用判断に使う重要語を入れる

```yaml
# ✅ 良い例
description: "データ永続化・DB設計ルール。保存→復元の完全性保証、フォールバック設計。DB関連コード変更時は必ず参照。"

# ❌ 悪い例
description: "ルール5"
```

### ルールファイル追加時のチェックリスト

- [ ] YAMLフロントマターに`description`を記述したか
- [ ] 活性化モード（`alwaysApply`等）を指定したか
- [ ] `03-directory-structure.md`のファイル一覧を更新したか

