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
goalの先にあるアウトカム（成果世界）を構造整理したもの。
- ユーザーがこれを達成した先に、**どんな世界・状態になっていたいのか**
- 目的と手段を履き違えるな。ユーザーがやりたいことが主語
- プロセスの効率化や機能の話は手段であり、sessionPurposeではない

### 3. tasks — Whyの深掘りに特化

**このフェーズの唯一の目的: ユーザーの「なぜやりたいか」の解像度を上げること。**

ユーザーのリクエストを読み、**Whyの解像度が低い箇所**を特定し、そこを深掘りする質問をタスクとして計画せよ。

#### タスクの方向性（この3つだけ）
1. **なぜ?**: なぜこれをやりたいのか。その動機・きっかけは何か
2. **アウトカム**: これが実現した先にどんな概念世界が広がるか。何がどう変わるか
3. **不足している視点**: ユーザーの入力で語られていない「なぜ」の側面は何か

各taskの形式:
- **name**: ユーザーに何を聞くか（「〜を聞く」「〜を確認する」の形）
- **why**: なぜこの深掘りがsessionPurposeの解像度向上に必要か
- **doneWhen**: ユーザーからどんな回答が得られれば完了か

#### 絶対禁止（生成するな）
以下は全てWhat/Howであり、このフェーズでは不要:
- ✗「必要な機能や特性を確認する」（= What）
- ✗「課題をリストアップする」（= What）
- ✗「使用するシナリオを確認する」（= What）
- ✗「情報管理の問題点を聞く」（= What）
- ✗「どんなやりとりを期待しているか聞く」（= What — やりとりの形はHowの話）
- ✗「設計する」「分析する」「整理する」「構築する」（= How）

#### OK例（生成すべきタスクの方向）
- ○「なぜAIエージェントを作りたいのか、その根本の動機を聞く」（= Why深掘り）
- ○「これが完成したら自分の仕事はどう変わるか、理想の姿を聞く」（= アウトカム）
- ○「今の壁打ちプロセスで一番もどかしい瞬間はいつか聞く」（= Why — 痛みの解像度）
- ○「壁打ちAIがなかったらどうなるか、最悪のシナリオを聞く」（= Why — 必要性の逆説）

**最低4つ以上**のタスクを生成せよ。

### 4. As-is / Assumptions
- asIs: 入力から読み取れる現状の事実
- assumptions: 暗黙的に前提としていること

## JSON出力
{
  "goal": "ユーザーの言葉そのまま",
  "sessionPurpose": "goalの先にあるアウトカム（成果世界）の記述",
  "asIs": ["現状の事実リスト"],
  "assumptions": ["暗黙の前提リスト"],
  "gap": "Whyの解像度が低い箇所",
  "tasks": [
    {
      "id": "task_1",
      "name": "ユーザーに何を聞くか",
      "why": "なぜこの深掘りが必要か",
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

### 3. タスク分解の更新 — Whyの深掘りに特化
- 前回のタスクで完了したものはどれか（ユーザーの回答で情報が得られたか）→ status: "done"
- 新たに深掘りすべき「なぜ」が出てきたか → 新タスク追加
- 次にユーザーに聞くべき「なぜ」はどれか

タスクの方向性（この3つだけ）:
1. **なぜ?**: なぜこれをやりたいのか。動機・きっかけ
2. **アウトカム**: 実現した先にどんな世界が広がるか
3. **不足している視点**: 語られていない「なぜ」の側面

✗ 機能・課題・シナリオ・プロセスの確認は全て禁止（= What/How）

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
