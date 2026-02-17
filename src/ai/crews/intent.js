/* ===================================================
   Crew: Phase0 — Goal特定 + sessionPurpose + タスク分解
   責務: ユーザー入力からGoal/sessionPurpose/タスクを特定し、
   Phase1用のタスクリストを生成する

   三層GOAL構造:
   - Layer 1はRulesLoader.getForPhase0()からプロンプトに注入
   - Layer 2(sessionPurpose)はこのPhaseの出力に含まれる
   =================================================== */

const IntentCrew = (() => {
    'use strict';

    /**
     * 初回分析用メッセージ配列を構築
     * @param {string} userMessage - 概要+Why
     * @returns {Array} メッセージ配列
     */
    function buildInitialMessages(userMessage) {
        const productMission = RulesLoader.getForPhase0();
        const prompt = IntentPrompt.buildInitial(productMission);

        return [
            { role: 'system', content: prompt },
            { role: 'user', content: userMessage },
        ];
    }

    /**
     * セッション継続用メッセージ配列を構築（sessionPurpose更新判定）
     * @param {string} userMessage - ユーザーの新しい発言
     * @param {string|null} previousGoal - 前回のGoal
     * @param {string|null} previousSessionPurpose - 前回のsessionPurpose
     * @param {Array|null} previousTasks - 前回のタスク分解
     * @param {string|null} progressSummary - セッション進捗
     * @returns {Array} メッセージ配列
     */
    function buildSessionMessages(userMessage, previousGoal, previousSessionPurpose, previousTasks, progressSummary) {
        const productMission = RulesLoader.getForPhase0();
        const prompt = IntentPrompt.buildSession(
            productMission, previousGoal, previousSessionPurpose, previousTasks, progressSummary
        );

        return [
            { role: 'system', content: prompt },
            { role: 'user', content: userMessage },
        ];
    }

    /**
     * Phase0の結果をパース・検証
     * @param {Object} result - APIレスポンスのパース結果
     * @returns {Object} 検証済みのPhase0結果
     */
    function parseResult(result) {
        console.log('[IntentCrew] Phase0結果パース');

        // goal
        if (!result.goal || typeof result.goal !== 'string') {
            console.warn('[IntentCrew] goalが未設定、フォールバック');
            result.goal = '不明';
        }
        console.log('[IntentCrew] Goal: ' + result.goal.substring(0, 100));

        // sessionPurpose
        if (!result.sessionPurpose || typeof result.sessionPurpose !== 'string') {
            console.warn('[IntentCrew] sessionPurposeが未設定、goalをフォールバック');
            result.sessionPurpose = result.goal;
        }
        console.log('[IntentCrew] sessionPurpose: ' + result.sessionPurpose.substring(0, 150));

        // asIs
        if (!Array.isArray(result.asIs)) {
            result.asIs = [];
        }
        console.log('[IntentCrew] As-is: ' + result.asIs.length + '項目');

        // gap
        if (!result.gap) result.gap = '';

        // tasks
        if (!Array.isArray(result.tasks) || result.tasks.length === 0) {
            console.warn('[IntentCrew] tasksが空、デフォルトタスク生成');
            result.tasks = [
                {
                    id: 'task_default',
                    name: 'ユーザーのGoalの解像度を上げるために具体的な状況を聞く',
                    why: 'Goalの記述が抽象的なため、具体的なシーンを確認する必要がある',
                    doneWhen: 'ユーザーが具体的な場面を1つ以上語れた時',
                    priority: 1,
                },
            ];
        }

        // tasks: id/priority補完
        result.tasks.forEach((task, i) => {
            if (!task.id) task.id = `task_${i + 1}`;
            if (!task.priority) task.priority = i + 1;
            if (!task.name) task.name = `タスク${i + 1}`;
            if (!task.why) task.why = '';
            if (!task.doneWhen) task.doneWhen = '';
        });

        console.log('[IntentCrew] タスク: ' + result.tasks.length + '件');
        result.tasks.forEach(t => {
            console.log(`  [${t.id}] p${t.priority}: ${t.name}`);
        });

        return result;
    }

    return { buildInitialMessages, buildSessionMessages, parseResult };
})();
