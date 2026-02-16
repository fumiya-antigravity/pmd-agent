/* ===================================================
   プロンプト: Phase0 — Goal特定 + タスク分解
   責務: ユーザー入力からGoal/As-is/Gap/タスクを特定

   ※ Layer3(プロダクト方向性)はRulesLoaderから注入
   ※ Layer2(パーソナリティ)はDBから読み込み済みのものを注入
   =================================================== */

const IntentPrompt = (() => {
  'use strict';

  /**
   * 初回分析用プロンプト（新規セッション）
   * @param {string} layer3 - 未使用（後方互換で残す）
   * @param {string|null} personality - user_context.raw_personality（なければnull）
   */
  function buildInitial(layer3, personality) {
    let personalitySection = '';
    if (personality && personality.trim()) {
      personalitySection = `
## このユーザーについて（過去の対話から蓄積された情報）
${personality}
`;
    }

    return `${personalitySection}
## タスク: 初回Goal特定 + タスク分解

ユーザーの入力を読み、以下を整理せよ。

### 1. Goal
この人が最終的に達成したいことは何か。ユーザーの言葉に忠実に。

### 2. As-is（現状の事実）
入力から読み取れる現状をリストアップ。
- 明示的に述べていること（事実）
- 暗黙的に前提としていること（仮定）
この2つを明確に分けよ。

### 3. Gap
GoalとAs-isの間に何が足りないか。
**このGoalに到達するために必要な情報**は何か。

### 4. タスク分解
Gapを埋めるために、**Whyを解明するタスク**を列挙。
各タスクには以下を含むこと:
- **name**: 何を明らかにするか（端的に）
- **why**: なぜこのタスクが必要か（Goalとの結びつき）
- **doneWhen**: どのような情報が集まれば完了するか（完了条件）

タスクはGoalから逆算せよ。「一般的にPRDに必要な情報」からの逆算は禁止。

**重要**: このツールの目的は「なぜやるのか」の思考を深めること。
- タスクは「Why（なぜやるのか・誰がどう困っているのか）」を解明するものに限定せよ
- How（どう実装するか・どんなプロセスにするか）やWhat（何を作るか・どんな機能をつけるか）レベルのタスクは**生成するな**
- 「機能のリストアップ」「設計」「分析」はHowであり、このフェーズでは不要

### 5. 優先順位
タスクの依存関係と重要度に基づいて、priority（1が最優先）を付与せよ。

## JSON出力
{
  "goal": "ユーザーのGoal（自由テキスト）",
  "asIs": ["現時点で判明している事実のリスト"],
  "assumptions": ["暗黙の前提・仮定のリスト"],
  "gap": "GoalとAs-isの差分（自由テキスト）",
  "tasks": [
    {
      "id": "task_1",
      "name": "タスク名",
      "why": "なぜ必要か（Goalとの結びつき）",
      "doneWhen": "何が判明すれば完了か",
      "priority": 1
    }
  ]
}`;
  }

  /**
   * セッション継続用プロンプト（2ターン目以降 — Goal更新判定）
   * @param {string} layer3 - 未使用（後方互換で残す）
   * @param {string|null} personality - パーソナリティ
   * @param {string} previousGoal - 前回のGoal
   * @param {Array} previousTasks - 前回のタスク分解
   * @param {string} progressSummary - これまでの進捗サマリ
   */
  function buildSession(layer3, personality, previousGoal, previousTasks, progressSummary) {
    let personalitySection = '';
    if (personality && personality.trim()) {
      personalitySection = `
## このユーザーについて（過去の対話から蓄積された情報）
${personality}
`;
    }

    const tasksJson = JSON.stringify(previousTasks || [], null, 2);

    return `${personalitySection}
## 前回までのGoal
${previousGoal || '未設定'}

## 前回のタスク分解
${tasksJson}

## これまでに解決したこと（セッション進捗）
${progressSummary || 'まだ進捗なし'}

## タスク: Goal更新判定 + タスク再分解

ユーザーの新しい発言を踏まえ、以下を判定せよ。

### 1. Goal更新判定
前回のGoalと比較して、解像度が上がったか？方向が変わったか？
- **更新すべき場合**: 新しいGoalを記述。updateReasonに更新理由を記載
- **維持すべき場合**: goalUpdatedをfalseに

### 2. タスク分解の更新
- 前回のタスクで完了したものはどれか（ユーザーの回答で情報が得られたか）
- 新たに必要になったタスクはあるか
- 次に取り組むべきタスクはどれか

タスクはGoalから逆算せよ。一般論からの分解は禁止。
**Whyを解明するタスクのみ生成せよ。How/Whatレベルのタスクは生成するな。**

### 3. 発言の目的適合性
ユーザーの発言はGoalに沿っているか？
脱線している場合は、その情報を活かしつつGoalに戻すタスクを生成せよ。

## JSON出力
{
  "goal": "現在のGoal",
  "goalUpdated": true/false,
  "updateReason": "更新理由（更新時のみ）",
  "asIs": ["更新されたAs-is"],
  "assumptions": ["仮定リスト"],
  "gap": "残りのGap",
  "tasks": [
    {
      "id": "task_1",
      "name": "タスク名",
      "why": "Goalとの結びつき",
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
