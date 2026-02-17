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
Goalの解像度を上げるために、**ユーザーから追加で聞き出すべき情報**は何か。

### 4. タスク分解
Gapを埋めるために、**ユーザーへの深掘り質問の計画**をタスクとして列挙。
各タスクは「ユーザーに何を聞いて、何を明らかにするか」を表す。

各タスクには以下を含むこと:
- **name**: ユーザーから何を聞き出すか（端的に）
- **why**: なぜこの情報がGoal達成に必要か
- **doneWhen**: ユーザーからどんな回答が得られれば完了か

タスクはGoalから逆算せよ。

### タスク分解の絶対ルール
- タスクは**ユーザーへの質問・深掘りの計画**であること
- 「設計する」「リストアップする」「分析する」「整理する」「構築する」等の**実装・作業タスクは絶対に生成するな**
- NG例: 「機能のリストアップ」「データ構造を設計する」「プロセスを明確化する」「情報を整理する」
- OK例: 「現在の壁打ちで具体的にどんな場面で困っているか聞く」「対象ユーザーは自分だけか他にもいるか確認する」

### 5. 優先順位
タスクの依存関係と重要度に基づいて、priority（1が最優先）を付与せよ。

## JSON出力
{
  "goal": "ユーザーのGoal（自由テキスト）",
  "asIs": ["現時点で判明している事実のリスト"],
  "assumptions": ["暗黙の前提・仮定のリスト"],
  "gap": "Goalの解像度を上げるために聞くべきこと（自由テキスト）",
  "tasks": [
    {
      "id": "task_1",
      "name": "ユーザーに何を聞くか（端的に）",
      "why": "なぜこの情報がGoal達成に必要か",
      "doneWhen": "ユーザーからどんな回答が得られれば完了か",
      "priority": 1
    }
  ]
}
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
- 新たに聞くべきことが出てきたか
- 次にユーザーに聞くべきことはどれか

タスクは**ユーザーへの深掘り質問の計画**であること。
「設計する」「リストアップする」「分析する」等の実装・作業タスクは絶対に生成するな。

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
