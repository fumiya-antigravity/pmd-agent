/* ===================================================
   Crew: メッセージ生成
   責務: ユーザー向けフィードバック生成
   =================================================== */

const MessageCrew = (() => {
    'use strict';

    async function execute(crewResults, context, callAPI, signal) {
        const { currentAspect, aspects, aspectStatus, conversationHistory } = context;
        const progressCtx = ContextBudget.buildMessageContext(aspects, currentAspect, aspectStatus);
        const history = ContextBudget.compressHistory(conversationHistory, 3);

        const inputSummary = `## Crew結果サマリ
### 観点分析結果
${JSON.stringify(crewResults.analysis?.aspectUpdate || crewResults.analysis?.aspectUpdates || {}, null, 0)}

### 横展開結果
${JSON.stringify(crewResults.crossRef?.relatedUpdates || [], null, 0)}

### コンタミ検知結果
${JSON.stringify(crewResults.contamination || { detected: false, items: [] }, null, 0)}

### オーケストレーター結果
${JSON.stringify(crewResults.orchestrator || { approved: true }, null, 0)}

### 現在フォーカス中: ${currentAspect}
### 全観点のstatus
${Object.entries(aspectStatus || {}).map(([k, v]) => `${k}: ${v}`).join(', ')}`;

        return callAPI([
            { role: 'system', content: MessagePrompt.get() + progressCtx },
            ...history,
            { role: 'user', content: inputSummary },
        ], signal);
    }

    return { execute };
})();
