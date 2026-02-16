/* ===================================================
   Crew: 観点分析
   責務: フォーカス中の1観点のstatus/text/reason/advice判定
   
   プロンプト組立: AnalysisPrompt.getInitial/getSession()を使用
   コンテキスト構築: ContextBudget経由
   =================================================== */

const AnalysisCrew = (() => {
    'use strict';

    /**
     * 初回分析用プロンプトを組み立て
     * RulesLoader.getCore() + AnalysisPrompt.getInitial() を結合
     */
    function buildInitialPrompt() {
        console.log('[AnalysisCrew] 初回分析プロンプト組立');
        return RulesLoader.getCore() + '\n\n' + AnalysisPrompt.getInitial();
    }

    /**
     * セッション中の分析プロンプトを組み立て
     * RulesLoader.getCore() + AnalysisPrompt.getSession() + コンテキスト
     */
    function buildSessionPrompt(context) {
        console.log('[AnalysisCrew] セッション分析プロンプト組立');
        const { currentAspect, aspects, aspectStatus, aspectReason, aspectAdvice } = context;
        const stateCtx = ContextBudget.buildAnalysisContext(aspects, currentAspect, aspectStatus, aspectReason, aspectAdvice);
        return RulesLoader.getCore() + '\n\n' + AnalysisPrompt.getSession() + stateCtx;
    }

    /**
     * 初回分析のAPI呼出し用メッセージ配列を構築
     */
    function buildInitialMessages(overview, whyText) {
        return [
            { role: 'system', content: buildInitialPrompt() },
            { role: 'user', content: `## 概要\n${overview}\n\n## Why\n${whyText}` },
        ];
    }

    /**
     * セッション中の分析API呼出し用メッセージ配列を構築
     */
    function buildSessionMessages(userMessage, context) {
        const { conversationHistory } = context;
        const history = ContextBudget.compressHistory(conversationHistory, 10);
        return [
            { role: 'system', content: buildSessionPrompt(context) },
            ...history,
            { role: 'user', content: userMessage },
        ];
    }

    /**
     * API応答から分析結果をパース・検証
     */
    function parseResult(result) {
        console.log('[AnalysisCrew] 結果パース');

        // aspectUpdates (初回) の検証
        if (result.aspectUpdates) {
            const aspects = Object.keys(result.aspectUpdates);
            console.log('[AnalysisCrew] 初回分析: ' + aspects.length + '観点検出');
            for (const [key, val] of Object.entries(result.aspectUpdates)) {
                if (!val.reason || val.reason.length < 5) {
                    console.warn('[AnalysisCrew] ' + key + ': reason不足');
                }
                if (!val.quoted || val.quoted.length < 5) {
                    console.warn('[AnalysisCrew] ' + key + ': quoted不足');
                }
            }
        }

        // aspectUpdate (セッション) の検証
        if (result.aspectUpdate) {
            const u = result.aspectUpdate;
            console.log('[AnalysisCrew] セッション分析: ' + u.aspect + '=' + u.status);
            if (!u.reason) console.warn('[AnalysisCrew] reason未設定');
            if (!u.advice) console.warn('[AnalysisCrew] advice未設定');
        }

        return result;
    }

    return { buildInitialPrompt, buildSessionPrompt, buildInitialMessages, buildSessionMessages, parseResult };
})();
