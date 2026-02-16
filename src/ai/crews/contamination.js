/* ===================================================
   Crew: コンタミ検知（完全独立）
   責務: How/What混入の意味的検知
   入力: ユーザー発言のみ
   =================================================== */

const ContaminationCrew = (() => {
    'use strict';

    async function execute(userMessage, callAPI, signal) {
        try {
            return await callAPI([
                { role: 'system', content: ContaminationPrompt.get() },
                { role: 'user', content: userMessage },
            ], signal);
        } catch (e) {
            console.warn('[ContaminationCrew] 失敗、スキップ:', e.message);
            return { detected: false, items: [] };
        }
    }

    return { execute };
})();
