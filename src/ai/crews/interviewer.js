/* ===================================================
   Crew: Interviewer AI — 壁打ちインタビュアー
   責務: PlannerのJSON計画を受け取り、自然な会話テキストを生成

   - InterviewerPrompt でsystemプロンプトを動的構築
   - callAPIはtextモード（jsonMode: false）で呼出し
   =================================================== */

const InterviewerCrew = (() => {
    'use strict';

    /**
     * Turn1用: Planner結果から初回質問メッセージを構築
     * @param {Object} plan - IntentCrew.parseResult()の出力
     * @param {string} userMessage - ユーザーの元入力
     * @returns {Array} メッセージ配列
     */
    function buildInitialMessages(plan, userMessage) {
        const systemPrompt = InterviewerPrompt.buildFromPlan(plan);
        return [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
        ];
    }

    /**
     * Turn2+用: Planner結果 + ユーザー回答からメッセージを構築
     * @param {Object} plan - IntentCrew.parseResult()の出力（status判定済み）
     * @param {string} userMessage - ユーザーの新しい発言
     * @returns {Array} メッセージ配列
     */
    function buildSessionMessages(plan, userMessage) {
        const systemPrompt = InterviewerPrompt.buildFromPlanWithHistory(plan, userMessage);
        return [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
        ];
    }

    return { buildInitialMessages, buildSessionMessages };
})();
