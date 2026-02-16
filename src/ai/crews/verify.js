/* ===================================================
   Crew: 検証（thin時のみ実行）
   責務: 分析結果の独立検証
   =================================================== */

const VerifyCrew = (() => {
    'use strict';

    /**
     * 検証用プロンプトを組み立て
     */
    function buildPrompt() {
        console.log('[VerifyCrew] 検証プロンプト組立');
        return RulesLoader.getCore() + '\n\n' + VerifyPrompt.get();
    }

    /**
     * 検証用API呼出しメッセージ配列を構築
     * thin判定時のみ呼ぶ
     */
    function buildMessages(analysisResult, userMessage) {
        if (analysisResult.aspectUpdate?.status !== 'thin') return null;

        const verifyUser = `## 前回の分析結果(R1)\n${JSON.stringify(analysisResult.aspectUpdate)}\n\n## ユーザーの原文\n${userMessage}`;
        return [
            { role: 'system', content: buildPrompt() },
            { role: 'user', content: verifyUser },
        ];
    }

    /**
     * 検証結果を分析結果にマージ
     */
    function merge(analysisResult, verifyResult) {
        if (!verifyResult) return analysisResult;
        console.log('[VerifyCrew] 検証結果マージ: shouldRevise=' + verifyResult.shouldRevise);

        if (verifyResult.shouldRevise && verifyResult.revisedUpdate?.status) {
            const r = { ...analysisResult };
            r.aspectUpdate = { ...r.aspectUpdate };
            r.aspectUpdate.status = verifyResult.revisedUpdate.status;
            if (verifyResult.revisedUpdate.text) r.aspectUpdate.text = verifyResult.revisedUpdate.text;
            if (verifyResult.revisedUpdate.reason) r.aspectUpdate.reason = verifyResult.revisedUpdate.reason;
            if (verifyResult.revisedUpdate.advice) r.aspectUpdate.advice = verifyResult.revisedUpdate.advice;
            r.thinking = (r.thinking || '') + '\n[検証結果] ' + (verifyResult.verification || '');
            return r;
        }

        if (verifyResult.alternativeQuestion && !verifyResult.shouldRevise) {
            analysisResult.message = (analysisResult.message || '') + '\n\n' + verifyResult.alternativeQuestion;
        }
        return analysisResult;
    }

    return { buildPrompt, buildMessages, merge };
})();
