/* ===================================================
   プロンプト: Phase1 — タスク駆動FB収集 + パーソナリティ分析メタタスク
   責務: Phase0のタスク分解から並列APIコール用メッセージを動的生成

   三層GOAL構造:
   - Layer 1: プロダクト使命（RulesLoader経由）
   - Layer 2: sessionPurpose（Phase0から — 読み取り専用）
   - Layer 3: 各タスクの具体指示

   ※ 通常タスク: Phase0のtasksから自動生成（可変数）
   ※ メタタスク: パーソナリティ分析（毎回必ず1つ追加）
   =================================================== */

const PerspectivePrompts = (() => {
    'use strict';

    /**
     * タスクごとのFB収集プロンプトを生成
     * @param {Object} task - Phase0で分解されたタスク { id, name, why, doneWhen }
     * @param {string} productMission - Layer 1: プロダクト使命
     * @param {string} sessionPurpose - Layer 2: セッション目的
     * @param {string} goal - Phase0で特定されたGoal
     * @param {string|null} progressSummary - セッション進捗
     * @param {string} userMessage - ユーザーの原文
     * @returns {Object} { role, content } のメッセージ配列
     */
    function buildTaskPrompt(task, productMission, sessionPurpose, goal, progressSummary, userMessage) {

        const prompt = `## プロダクト使命（不変）
${productMission}

## このセッションの目的
${sessionPurpose}

## このチャットのGoal
${goal}

${progressSummary ? `## これまでの進捗\n${progressSummary}\n` : ''}

## あなたのタスク

以下のタスクに集中し、ユーザーの入力から得られる情報と、あなたの分析を**大量のテキスト**で回答せよ。

### タスク: ${task.name}
- **なぜ必要か**: ${task.why}
- **完了条件**: ${task.doneWhen}

### 回答の指針
- このタスクの完了条件を満たすために必要な情報を、ユーザーの入力から最大限に抽出せよ
- ユーザーが明示していない暗黙の前提も推論し、テキストとして出力せよ
- 足りない情報がある場合は「何が不足しているか」「どういう情報があれば完了するか」を具体的に述べよ
- 出力は**JSON不要**。自由テキストで、思考の過程も含めて大量に返せ`;

        return [
            { role: 'system', content: prompt },
            { role: 'user', content: userMessage },
        ];
    }

    /**
     * パーソナリティ分析メタタスクのプロンプトを生成（毎回必ず実行）
     * @param {string} productMission - Layer 1: プロダクト使命
     * @param {string|null} existingPersonality - 既存のraw_personality
     * @param {string} userMessage - ユーザーの原文
     * @returns {Object} メッセージ配列
     */
    function buildPersonalityMetaTask(productMission, existingPersonality, userMessage) {
        let existingSection = '';
        if (existingPersonality && existingPersonality.trim()) {
            existingSection = `
## 既存のパーソナリティ情報（過去の対話から蓄積済み）
${existingPersonality}

この情報を踏まえた上で、今回の発言から新しく読み取れる情報に注力してください。
既存情報の繰り返しは最小限に。変化や成長が見られる点を重視してください。
`;
        } else {
            existingSection = `
## 既存のパーソナリティ情報
初めてのユーザーです。まだ情報がありません。
`;
        }

        const prompt = `## プロダクト使命（不変）
${productMission}

${existingSection}

## タスク: ユーザーのパーソナリティ分析

ユーザーの発言を分析し、以下の観点で自由テキストを大量に回答せよ。
**必ず根拠となるユーザーの発言を引用すること。**

### 1. 思考の入口
この人はどこから考え始めている？
- Why（なぜやるか）/ What（何を作るか）/ How（どうやるか）のどれから入っているか
- 具体例: どの発言がそれを示しているか

### 2. 具体性のレベル
- 抽象的な表現が多いか、具体的なシーン描写があるか
- どの部分が抽象的で、どう具体化できそうか
- 数値・固有名詞・事例の使用頻度

### 3. 暗黙の前提
- この人が当然と思っているが明示していないことは何か
- 「〜である」と断言しているが、実は確認が必要な前提はないか

### 4. 強みと伸びしろ
- この人の思考の強みは何か（具体的に）
- どこに伸びしろがあるか（具体的に）

### 5. 効果的なFBの出し方
- この人にはどういう形のフィードバックが響きそうか
  - 選択肢型（「AとBどちらですか？」）
  - たたき台型（「仮にこうだとしたら…」）
  - 質問型（「もう少し教えてください」）
  - 対比型（「〇〇との違いは？」）
- 避けるべきFBの出し方はあるか

### 6. 前回からの変化（既存情報がある場合のみ）
- 前回までの特徴と比較して、成長が見られる点はあるか
- 変わっていない点、繰り返し出てくるパターンはあるか

※ 推測で構わない。ただし必ず根拠を引用すること。`;

        return [
            { role: 'system', content: prompt },
            { role: 'user', content: userMessage },
        ];
    }

    /**
     * Phase0のタスク分解から、Phase1用の全プロンプトを一括生成
     * @param {Object} phase0Result - Phase0の結果 { goal, sessionPurpose, tasks, ... }
     * @param {string} productMission - Layer 1: プロダクト使命
     * @param {string|null} personality - パーソナリティ（メタタスク用）
     * @param {string|null} progressSummary - セッション進捗
     * @param {string} userMessage - ユーザー原文
     * @returns {Array} [ { type: 'task'|'meta', id, messages } ]
     */
    function buildAll(phase0Result, productMission, personality, progressSummary, userMessage) {
        const prompts = [];
        const sessionPurpose = phase0Result.sessionPurpose || phase0Result.goal;

        // 通常タスク（Phase0のtasksから — pendingとnewのみ）
        const activeTasks = (phase0Result.tasks || [])
            .filter(t => !t.status || t.status !== 'done')
            .sort((a, b) => (a.priority || 99) - (b.priority || 99));

        for (const task of activeTasks) {
            prompts.push({
                type: 'task',
                id: task.id,
                name: task.name,
                messages: buildTaskPrompt(
                    task, productMission, sessionPurpose, phase0Result.goal,
                    progressSummary, userMessage
                ),
            });
        }

        // タスクが少ない場合の補完
        if (activeTasks.length < 2) {
            prompts.push({
                type: 'task',
                id: 'supplement_blind_spots',
                name: '見落とし分析',
                messages: buildTaskPrompt(
                    {
                        name: '見落とし・盲点の分析',
                        why: 'ユーザーの入力で見落とされている前提や、この計画が失敗するシナリオを特定するため',
                        doneWhen: '見落とされている前提と失敗シナリオが3つ以上特定される',
                    },
                    productMission, sessionPurpose, phase0Result.goal,
                    progressSummary, userMessage
                ),
            });
        }

        // ★ パーソナリティ分析メタタスク（常に追加）
        prompts.push({
            type: 'meta',
            id: 'personality_analysis',
            name: 'パーソナリティ分析',
            messages: buildPersonalityMetaTask(productMission, personality, userMessage),
        });

        return prompts;
    }

    return { buildTaskPrompt, buildPersonalityMetaTask, buildAll };
})();
