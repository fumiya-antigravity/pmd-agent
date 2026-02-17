/* ===================================================
   プロンプト: Phase0 — Goal特定 + sessionPurpose + タスク分解
   責務: ユーザー入力からGoal/sessionPurpose/タスクを特定

   三層GOAL構造:
   - Layer 1: プロダクト使命（RulesLoader.getProductMission()）
   - Layer 2: sessionPurpose（このPhaseで初期設定 or 更新）
   - Layer 3: プロンプトアクション（タスク分解指示）
   =================================================== */

const IntentPrompt = (() => {
  'use strict';

  /**
   * 初回分析用プロンプト（新規セッション）
   * @param {string} productMission - Layer 1: プロダクト使命
   */
  function buildInitial(productMission) {

    return `## プロダクト使命（不変）
${productMission}

## あなたのタスク

ユーザーの入力を読み、以下を出力せよ。

### 1. goal
ユーザーが達成したいこと。ユーザーの言葉に忠実に。

### 2. sessionPurpose
goalを構造整理したもの。
ユーザーが「何を」「なぜ」「どういう状況で」達成したいかを整理。
**問題分析ではない。ユーザーの目的そのものの解像度を上げた記述。**
目的と手段を履き違えるな。ユーザーがやりたいことが主語。

### 3. tasks
sessionPurposeの解像度をさらに上げるために、ユーザーに追加で聞くべきことのリスト。

各taskは以下の形式:
- **name**: ユーザーに何を聞くか（「〜を聞く」「〜を確認する」の形）
- **why**: なぜこの情報がsessionPurposeの解像度向上に必要か
- **doneWhen**: ユーザーからどんな回答が得られれば完了か

タスク生成の絶対ルール:
- 「設計する」「分析する」「リストアップする」「整理する」「構築する」は**禁止**
- NG例: 「機能のリストアップ」「データ構造を設計する」「プロセスを明確化する」
- OK例: 「壁打ちで具体的にどんなやりとりを期待しているか聞く」「対象ユーザーは自分だけか確認する」
- ユーザー入力に含まれる各論点それぞれに対応するタスクを生成せよ
- **最低4つ以上**のタスクを生成せよ

### 4. As-is / Assumptions
- asIs: 入力から読み取れる現状の事実
- assumptions: 暗黙的に前提としていること

## JSON出力
{
  "goal": "ユーザーの言葉そのまま",
  "sessionPurpose": "goalを構造整理したもの（目的中心）",
  "asIs": ["現状の事実リスト"],
  "assumptions": ["暗黙の前提リスト"],
  "gap": "sessionPurposeの解像度を上げるために聞くべきこと",
  "tasks": [
    {
      "id": "task_1",
      "name": "ユーザーに何を聞くか",
      "why": "なぜこの情報が必要か",
      "doneWhen": "どんな回答が得られれば完了か",
      "priority": 1
    }
  ]
}`;
  }

  /**
   * セッション継続用プロンプト（2ターン目以降 — sessionPurpose更新判定）
   * @param {string} productMission - Layer 1: プロダクト使命
   * @param {string} previousGoal - 前回のGoal
   * @param {string} previousSessionPurpose - 前回のsessionPurpose
   * @param {Array} previousTasks - 前回のタスク分解
   * @param {string} progressSummary - これまでの進捗サマリ
   */
  function buildSession(productMission, previousGoal, previousSessionPurpose, previousTasks, progressSummary) {
    const tasksJson = JSON.stringify(previousTasks || [], null, 2);

    return `## プロダクト使命（不変）
${productMission}

## このセッションの目的（Layer 2）
${previousSessionPurpose || '未設定'}

## 前回までのGoal
${previousGoal || '未設定'}

## 前回のタスク分解
${tasksJson}

## これまでの進捗
${progressSummary || 'まだ進捗なし'}

## あなたのタスク

ユーザーの新しい発言を踏まえ、以下を判定せよ。

### 1. sessionPurpose更新判定
前回のsessionPurposeと比較して、解像度が上がったか？方向が変わったか？
- **更新すべき場合**: 新しいsessionPurposeを記述。sessionPurposeUpdateReasonに理由を記載
- **維持すべき場合**: sessionPurposeUpdatedをfalseに
- 目的と手段を履き違えるな。ユーザーがやりたいことが主語。

### 2. Goal更新判定
前回のGoalと比較して変化があるか？
- ユーザーが方向転換した場合のみ更新

### 3. タスク分解の更新
- 前回のタスクで完了したものはどれか（ユーザーの回答で情報が得られたか）→ status: "done"
- 新たに聞くべきことが出てきたか → 新タスク追加
- 次にユーザーに聞くべきことはどれか

タスクは**ユーザーへの深掘り質問の計画**であること。
「設計する」「分析する」「リストアップする」等は禁止。

### 4. 発言の目的適合性
ユーザーの発言はsessionPurposeに沿っているか？
脱線している場合は、その情報を活かしつつ目的に戻すタスクを生成せよ。

## JSON出力
{
  "goal": "現在のGoal",
  "goalUpdated": true/false,
  "updateReason": "Goal更新理由（更新時のみ）",
  "sessionPurpose": "現在のsessionPurpose",
  "sessionPurposeUpdated": true/false,
  "sessionPurposeUpdateReason": "更新理由（更新時のみ）",
  "asIs": ["更新されたAs-is"],
  "assumptions": ["仮定リスト"],
  "gap": "残りのGap",
  "tasks": [
    {
      "id": "task_1",
      "name": "ユーザーに何を聞くか",
      "why": "なぜ必要か",
      "doneWhen": "完了条件",
      "priority": 1,
      "status": "done|pending|new"
    }
  ],
  "onTrack": true/false,
  "redirectNote": "脱線時のみ: どう戻すか"
}`;
  }

  return { buildInitial, buildSession };
})();
