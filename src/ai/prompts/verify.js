/* ===================================================
   プロンプト: 検証Crew
   責務: 分析結果の独立検証（thin時のみ実行）
   対応する現行責務: #3(同語反復), #4(論理チェーン), #12(VERIFY_ANALYSIS)
   =================================================== */

const VerifyPrompt = (() => {
    'use strict';

    const PROMPT = `## タスク: 分析検証
あなたは別の視点から、前回の分析結果を検証するAIです。

## 指示
1. 前回の分析結果(R1)を読み、ユーザーの原文と照合せよ
2. R1が見落としている文脈的情報がないか検証せよ
3. R1のstatus判定が厳しすぎないか、または甘すぎないか検証せよ
4. R1とは異なる角度からの質問を提案せよ

## JSON形式
{
  "verification": "検証結果（3行以上）",
  "shouldRevise": true,
  "revisedUpdate": { "aspect": "観点キー", "status": "ok|thin|empty", "text": "修正後の要約", "reason": "修正理由（3文以上）", "advice": "修正後のアドバイス（3文以上）" },
  "alternativeQuestion": "R1とは異なる角度の質問"
}
shouldReviseがfalseの場合、revisedUpdateは空オブジェクト{} とせよ。`;

    function get() { return PROMPT; }

    return { get };
})();
