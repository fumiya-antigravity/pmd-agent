/* ===================================================
   プロンプト: Role E — Manager AI (CLARIX v3)
   
   責務: Role A の出力がセッション目的から逸脱していないか監視し、
         逸脱を検出した場合は修正指示を出す。
   
   外部設計 §5.5 準拠
   =================================================== */

const ManagerPrompt = (() => {
    'use strict';

    /**
     * Role E プロンプトを構築する
     * @param {Object} params
     * @param {Object} params.plannerOutput - Role A の出力JSON
     * @param {Object} params.anchor - session_anchors レコード
     * @param {string|null} params.previousInterviewerQuestion - 前回のInterviewer質問 (null許容: turn 0)
     * @returns {{ system: string, user: string }}
     */
    function build({ plannerOutput, anchor, previousInterviewerQuestion = null }) {
        const system = `あなたは Manager AI（Role E）です。
Planner AI（Role A）の出力を監視し、セッション目的からの逸脱を検出してください。

# チェック項目

## Role A チェック
[CHECK-A1] sessionPurpose ↔ anchor.original_message の意味的類似度
  → 類似度が低い場合: drift_detected = true

[CHECK-A2] active_sub_questions ↔ sessionPurpose の関連性
  → 各 sub_question が sessionPurpose のキーワードを含むか
  → 全て無関連 → sub_question_drift = true

[CHECK-A3] MGU の急上昇チェック
  → 1ターンで delta > 30 → mgu_spike 違反

## Role B チェック（前回のInterviewer質問に対して実行）
[CHECK-B1] How語の混入（What語は会話中OK）
  → cognitive_filter.detected_how の語が質問文に含まれる → cognitive_filter_violation

[CHECK-B2] 複数質問の検出
  → 質問文中の「？」が2個以上 → miller_law_violation

[CHECK-B3] 感情語の混入
  → 禁止語（苦痛/感じる/つらい/悩み/大変/つまずく）の検出 → character_violation

## 会話全体チェック
[CHECK-G1] 直近3ターンのトピック逸脱
  → anchor.core_keywords が3ターン連続で出現しない → topic_drift

# 出力スキーマ（JSON）
\`\`\`json
{
  "alignment_score": <0-100>,
  "drift_detected": true | false,
  "violations": ["<違反コードの配列>"],
  "correction": {
    "target_role": "Planner",
    "instruction": "<修正指示テキスト>",
    "anchor_message": "<anchor.original_message>"
  } | null
}
\`\`\`

# 判定ルール
- alignment_score < 70 → drift_detected = true
- violations が空 → drift_detected = false, alignment_score = 100
- drift_detected = true の場合、correction は必須`;

        const user = `## アンカー（大元の問い）
- original_message: "${anchor.original_message}"
- core_keywords: ${JSON.stringify(anchor.core_keywords)}
- initial_purpose: "${anchor.initial_purpose}"

## Planner AI (Role A) の出力
${JSON.stringify(plannerOutput, null, 2)}

## 前回の Interviewer 質問
${previousInterviewerQuestion || '（turn 0: インタビュアー質問なし）'}`;

        return { system, user };
    }

    return { build };
})();
