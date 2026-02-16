/* ===================================================
   コンテキスト予算管理
   - 各Crewに渡すトークン量を最適化
   - 履歴の要約・圧縮
   =================================================== */

const ContextBudget = (() => {
    'use strict';

    // 直近N件はフルテキスト、それ以降は要約
    const FULL_HISTORY_COUNT = 5;
    const SUMMARY_HISTORY_COUNT = 5; // 要約で保持する件数

    /**
     * 履歴を予算内に圧縮
     * @param {Array} history - 会話履歴
     * @param {number} maxItems - 最大件数
     * @returns {Array} 圧縮された履歴
     */
    function compressHistory(history, maxItems = 10) {
        if (!history || history.length <= FULL_HISTORY_COUNT) return history || [];

        const recent = history.slice(-FULL_HISTORY_COUNT);
        const older = history.slice(-(FULL_HISTORY_COUNT + SUMMARY_HISTORY_COUNT), -FULL_HISTORY_COUNT);

        // 古い履歴は要約化
        const summarized = older.map(m => ({
            role: m.role,
            content: m.content.length > 200
                ? m.content.substring(0, 200) + '…'
                : m.content,
        }));

        return [...summarized, ...recent].slice(-maxItems);
    }

    /**
     * 観点情報を対象Crew用に絞り込む
     */
    function buildAnalysisContext(aspects, currentAspect, aspectStatus, aspectReason, aspectAdvice) {
        // 分析Crew: フォーカス中の観点のフル情報 + 他観点のstatus概要
        let ctx = '\n## 観点状態\n';
        for (const [key, text] of Object.entries(aspects)) {
            const st = aspectStatus?.[key] || 'unknown';
            if (key === currentAspect) {
                ctx += `### ${key} (★フォーカス中): ${st}\n現在のtext: 「${text?.trim() || ''}」\n`;
                if (aspectReason?.[key]) ctx += `前回のreason: 「${aspectReason[key]}」\n`;
                if (aspectAdvice?.[key]) ctx += `前回のadvice: 「${aspectAdvice[key]}」\n`;
            } else {
                ctx += `### ${key}: ${st}\n現在のtext: 「${text?.trim() || '（空）'}」\n`;
            }
        }
        return ctx;
    }

    /**
     * 横展開Crew用: 全観点のフル情報
     */
    function buildCrossRefContext(aspects, currentAspect, aspectStatus) {
        let ctx = '\n## 全観点の現在状態\n';
        ctx += `フォーカス中: ${currentAspect}\n\n`;
        for (const [key, text] of Object.entries(aspects)) {
            const st = aspectStatus?.[key] || 'unknown';
            ctx += `### ${key}: ${st}\n現在のtext: 「${text?.trim() || '（空）'}」\n`;
        }
        return ctx;
    }

    /**
     * メッセージ生成Crew用: 確定結果 + 最近の履歴のみ
     */
    function buildMessageContext(aspects, currentAspect, aspectStatus) {
        let ctx = '\n## 現在の進捗概要\n';
        for (const [key, text] of Object.entries(aspects)) {
            const st = aspectStatus?.[key] || 'unknown';
            ctx += `- ${key}: ${st} (${text?.trim()?.length || 0}文字)\n`;
        }
        ctx += `\nフォーカス中: ${currentAspect}\n`;
        return ctx;
    }

    return {
        compressHistory,
        buildAnalysisContext,
        buildCrossRefContext,
        buildMessageContext,
        FULL_HISTORY_COUNT,
    };
})();
