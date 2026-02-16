/* ===================================================
   Crew: 横展開
   責務: ユーザー発言が他の4観点に与える影響の分析・更新
   =================================================== */

const CrossRefCrew = (() => {
    'use strict';

    async function execute(userMessage, context, analysisResult, callAPI, signal) {
        const { currentAspect, aspects, aspectStatus, conversationHistory } = context;
        const stateCtx = ContextBudget.buildCrossRefContext(aspects, currentAspect, aspectStatus);
        const history = ContextBudget.compressHistory(conversationHistory, 4);

        const analysisInfo = analysisResult?.aspectUpdate
            ? `\n## 分析Crewの結果\n観点: ${analysisResult.aspectUpdate.aspect}\n判定: ${analysisResult.aspectUpdate.status}\ntext: ${analysisResult.aspectUpdate.text || ''}`
            : '';

        return callAPI([
            { role: 'system', content: CrossRefPrompt.get() + stateCtx + analysisInfo },
            ...history,
            { role: 'user', content: userMessage },
        ], signal);
    }

    return { execute };
})();
