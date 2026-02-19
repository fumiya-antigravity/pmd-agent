/* ===================================================
   プロンプト: Role D — Reporter AI (CLARIX v3)
   
   責務: スライダーで重み付けされたインサイトに基づき、
         Whyを中心としたレポートMarkdownを生成する。
   
   外部設計 §5.4 準拠
   =================================================== */

const ReporterPrompt = (() => {
    'use strict';

    /**
     * Role D プロンプトを構築する
     * @param {Object} params
     * @param {Array} params.insights - スライダー重み付け済みインサイト
     * @param {string} params.sessionPurpose - セッション目的
     * @param {Array} params.history - 会話履歴
     * @param {Object} params.anchor - session_anchors レコード
     * @returns {{ system: string, user: string }}
     */
    function build({ insights, sessionPurpose, history = [], anchor }) {
        // How語を除外（Whatは含める）
        const howWords = [];
        history.forEach(m => {
            if (m.metadata?.cognitive_filter?.detected_how) {
                howWords.push(...m.metadata.cognitive_filter.detected_how);
            }
        });
        const uniqueHowWords = [...new Set(howWords)];

        const insightsText = insights.map((ins, i) => {
            const weight = ins.slider_weight ?? ins.strength;
            const blind = ins.johari_blind_spot ? ' 🔍(盲点の窓)' : '';
            return `${i + 1}. [${ins.layer}] ${ins.label} (重み: ${weight}%)${blind}`;
        }).join('\n');

        const system = `あなたは Reporter AI（Role D）です。
ユーザーの壁打ちセッションの結果を、構造化されたWhyレポートとして出力してください。

# レポート構成（Markdown）
1. **セッション概要** — 元の問いと到達したWhy
2. **Why構造マップ** — attribute → consequence → value の3層構造
3. **重要インサイト** — スライダー重みの高い順に解説
4. **盲点の発見** — ジョハリの窓で「盲点」と判定されたインサイト
5. **推奨ネクストアクション** — Whyに基づく具体的行動提案

# 重要なルール
- **How語をレポートに含めない**: ${uniqueHowWords.join('、') || '（なし）'}
  （これらは手段であり、Whyレポートの本質ではない）
- **What語はレポートに含めてOK**
- 学術理論の引用はさりげなく
- ユーザーの言葉（引用）を適宜含める
- Markdown形式で出力（タイトルはh2から開始）`;

        const user = `## セッション情報
- 元の問い: "${anchor.original_message}"
- セッション目的: "${sessionPurpose}"

## インサイト（スライダー重み付け済み）
${insightsText}

## 会話の要約
${history.filter(m => m.role === 'user').map(m => `- ${m.content.substring(0, 100)}`).join('\n')}

上記に基づいてWhyレポートを生成してください。`;

        return { system, user };
    }

    return { build };
})();
