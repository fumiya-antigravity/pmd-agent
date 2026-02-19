/* ===================================================
   プロンプト: Role A — Planner AI (CLARIX v3)
   
   責務: ユーザーの発言を分析し、Whyの理解度(MGU)、
         派生質問の明瞭度(SQC)、確認済みインサイトを算出する。
   
   外部設計 §5.1 準拠
   =================================================== */

const PlannerPrompt = (() => {
    'use strict';

    /**
     * Role A プロンプトを構築する
     * @param {Object} params
     * @param {string} params.userMessage - ユーザーの最新メッセージ
     * @param {Object|null} params.anchor - session_anchors レコード
     * @param {Object|null} params.latestGoal - 前回の goal_history レコード
     * @param {Array} params.confirmedInsights - 既存の confirmed_insights
     * @param {Array} params.history - 会話履歴 (直近N件)
     * @param {number} params.turn - 現在のターン番号
     * @param {Object|null} params.managerCorrection - Role E からの修正指示 (リトライ時)
     * @returns {{ system: string, user: string }}
     */
    function build({
        userMessage,
        anchor = null,
        latestGoal = null,
        confirmedInsights = [],
        history = [],
        turn = 0,
        managerCorrection = null,
    }) {
        const anchorSection = anchor
            ? `## アンカー（大元の問い）
- original_message: "${anchor.original_message}"
- core_keywords: ${JSON.stringify(anchor.core_keywords)}
- initial_purpose: "${anchor.initial_purpose}"`
            : '## アンカー\n（初回ターン: アンカーなし）';

        const previousState = latestGoal
            ? `## 前回の状態
- MGU (main_goal_understanding): ${latestGoal.mgu || 0}
- SQC (sub_question_clarity): ${latestGoal.sqc || 0}
- sessionPurpose: "${latestGoal.session_purpose || ''}"
- question_type: ${latestGoal.question_type || 'open'}
- active_sub_questions: ${JSON.stringify(latestGoal.active_sub_questions || [])}
- why_completeness_score: ${latestGoal.why_completeness_score || 0}`
            : '## 前回の状態\n（初回ターン: 前回状態なし）';

        const insightsSection = confirmedInsights.length > 0
            ? `## これまでに確認済みのインサイト（累積）\n${JSON.stringify(confirmedInsights, null, 2)}`
            : '## これまでに確認済みのインサイト\n（まだなし）';

        const correctionSection = managerCorrection
            ? `\n## ⚠ Manager AI (Role E) からの修正指示\n${managerCorrection.instruction}\n元メッセージ: "${managerCorrection.anchor_message || ''}"\n\n**この修正指示に従い、出力を修正してください。**`
            : '';

        const mguContext = (latestGoal?.mgu || 0) >= 60
            ? `\n## SQC算出の前提コンテキスト（MGU≥60%のため詳細提供）
- sessionPurpose: "${latestGoal?.session_purpose || ''}"
- 確認済みinsights数: ${confirmedInsights.length}
- この文脈において「何が曖昧か」を精度高く判定してください。`
            : '';

        const system = `あなたは Planner AI（Role A）です。
ユーザーの壁打ち相談を分析し、「なぜ（Why）」の核心を構造的に理解するためのJSONを出力してください。

# 重要な原則
1. **Whyを深掘りする**: ユーザーの真の動機・価値観・根本課題を特定する
2. **How/Whatは排除しない**: ユーザーが言及するHow（手段）やWhat（対象）は、
   「なぜそれを行いたいのか」を理解するための**思考のヒント**として活用する
3. **cognitive_filter**: How語とWhat語を**分類**する（排除ではない）。
   How語は最終レポートで除外、What語はレポートに含めてOK。
4. **SQCのLLMベース算出**: ユーザー回答中の曖昧語（代名詞、抽象名詞、未定義概念）を
   検出し、SQCスコアを0-100で出力する
${mguContext}

# 出力スキーマ（以下のJSONを必ず出力）
\`\`\`json
{
  "main_goal_understanding": <0-100>,    // MGU: Whyの理解度
  "sub_question_clarity": <0-100>,       // SQC: 派生質問の明瞭度
  "why_completeness_score": <0-100>,     // Why完全性スコア（MGUと同値でOK）
  "sessionPurpose": "<セッション目的（1文）>",
  "question_type": "open" | "hypothesis",
  "active_sub_questions": [
    {
      "question": "<派生質問テキスト>",
      "layer": "attribute" | "consequence" | "value",
      "status": "active" | "resolved"
    }
  ],
  "confirmed_insights": [
    {
      "label": "<インサイトの要約>",
      "layer": "attribute" | "consequence" | "value",
      "strength": <0-100>,
      "confirmation_strength": <0.0-1.0>,
      "turn": <ターン番号>
    }
  ],
  "cognitive_filter": {
    "detected_how": ["<How語1>", "<How語2>"],
    "detected_what": ["<What語1>"],
    "instruction": "<分類の説明>"
  },
  "next_question_focus": {
    "target_layer": "attribute" | "consequence" | "value",
    "focus": "<次に聞くべきことの方向性>"
  }
}
\`\`\`

# MGU 計算ガイドライン
- attribute（属性層）の解消: +5
- consequence（結果層）の解消: +10
- value（価値観層）の解消: +20
- confirmation_strength=1.0の時に上記を満額、0.7なら70%、0.3なら30%を加算
- confirmation_strength=0.0（否定・訂正）の場合: 加算なし、新しい派生質問を生成

# question_type 判定
- MGU < 60: "open"（スクリプト理論：まず広く聴く）
- MGU ≥ 60: "hypothesis"（認知的不協和：仮説を提示して揺さぶる）

# SQC による派生質問の状態遷移
- SQC ≥ 80 の派生質問: status を "resolved" に変更
- SQC < 80 かつ新しい曖昧さを検出: 新しい派生質問を status "active" で追加
- 全ての active_sub_questions が resolved になったら、MGUの更新を許可

# confirmed_insights の出力ルール
- **差分のみ出力**: 今回のターンで新たに確認された/更新されたインサイトのみ
- 累積はDB側で管理（upsert: session_id + label）
${correctionSection}`;

        const user = `${anchorSection}

${previousState}

${insightsSection}

## 会話履歴（直近）
${history.map(m => `[${m.role}] ${m.content}`).join('\n')}

## ユーザーの最新メッセージ（Turn ${turn}）
${userMessage}`;

        return { system, user };
    }

    return { build };
})();
