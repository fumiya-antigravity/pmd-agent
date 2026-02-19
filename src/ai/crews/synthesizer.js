/* ===================================================
   Role C — Synthesizer (CLARIX v3)
   
   責務: confirmed_insights を整形し、スライダーUI用データを生成する。
   LLMを使わない純粋なJavaScriptロジック。
   
   外部設計 §5.3 準拠
   =================================================== */

const Synthesizer = (() => {
    'use strict';

    /**
     * confirmed_insights を整形してスライダー用データを返す
     * @param {Array} insights - confirmed_insights テーブルのレコード配列
     * @param {string} originalMessage - anchor.original_message (ジョハリの窓判定用)
     * @returns {Array} 整形済みインサイト配列
     */
    function run(insights, originalMessage = '') {
        if (!insights || insights.length === 0) return [];

        // ルール1: layer順にソート (value > consequence > attribute)
        const layerOrder = { value: 0, consequence: 1, attribute: 2 };
        const sorted = [...insights].sort((a, b) => {
            const layerDiff = (layerOrder[a.layer] ?? 99) - (layerOrder[b.layer] ?? 99);
            if (layerDiff !== 0) return layerDiff;
            return (b.strength || 0) - (a.strength || 0); // 同一layerはstrength降順
        });

        // ルール2: 上位5件に絞る (Miller's Law: 7±2の中央値)
        const top = sorted.slice(0, 5);

        // ルール3: primary/supplementary タグ付け
        top.forEach(insight => {
            insight.tag = (insight.strength || 0) >= 70 ? 'primary' : 'supplementary';
        });

        // ルール3.5: ジョハリの窓 — ユーザーが自覚していなかったinsightにフラグ
        if (originalMessage) {
            const lowerOriginal = originalMessage.toLowerCase();
            top.forEach(insight => {
                // insightのlabelのキーワードが元メッセージに含まれていなければblind spot
                const keywords = insight.label.split(/[、。\s,.\-]+/).filter(k => k.length >= 2);
                const foundInOriginal = keywords.some(k => lowerOriginal.includes(k.toLowerCase()));
                insight.johari_blind_spot = !foundInOriginal;
            });
        }

        // ルール4: スライダー初期値 = strength（フロントエンドで使用）
        // （strengthをそのまま返す）

        return top.map(insight => ({
            id: insight.id,
            label: insight.label,
            layer: insight.layer,
            strength: insight.strength,
            tag: insight.tag,
            johari_blind_spot: insight.johari_blind_spot || false,
            slider_value: insight.strength, // フロントエンド用初期値
        }));
    }

    return { run };
})();
