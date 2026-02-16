/* ===================================================
   Crew: オーケストレーター
   責務: 全Crew出力の統合・ログ収集
   
   注意: status判定は全てAIに委ねる。
         コードレベルでのstatus上書きは行わない。
   =================================================== */

const OrchestratorCrew = (() => {
    'use strict';

    // ===================================================
    // 2回目バリデーション用プロンプト（セカンドオピニオン）
    // AIによるレビュー — コード側でのstatus変更は行わない
    // ===================================================

    /**
     * ok判定が甘すぎないかレビューする2回目バリデーション用プロンプトを構築
     */
    function buildValidationPrompt() {
        console.log('[OrchestratorCrew] バリデーションプロンプト組立');
        return 'あなたは厳格なシニアPdMのレビュアーです。別のAIが行ったWhy分析のstatus=ok判定が甘すぎないかレビューしてください。\n\n'
            + '## thin判定の具体例（以下はokではなくthinにすべき）\n'
            + '- 「要件定義の作成が困難である」→ 誰が？何件？どの工程で？が不明。thin\n'
            + '- 「データ管理が不十分で形だけの要件定義になる」→ 「形だけ」とは具体的に何が起こるのか不明。thin\n'
            + '- 「既存プロダクトの機能改修において要件定義を作成している」→ どのプロダクト？何人で？週何件？thin\n'
            + '- 「効率が悪い」「しんどい」→ 定量情報なし。thin\n\n'
            + '## ok判定の具体例（以下はokに値する）\n'
            + '- 「5人チームで週3件のPRD作成。Confluenceテンプレが形骸化し1PRDあたり平均8時間」→ ok\n'
            + '- 「ジュニアPdMが機能改修PRDを書く際、既存コードのビジネスロジック理解不足で正常系のみ記載。差し戻し週4件」→ ok\n\n'
            + '## 同語反復判定（以下は同語反復でありdetected=trueにすべき）\n'
            + '- background「要件定義の作成が困難」↔ problem「要件定義が形だけになる」→ 同語反復\n'
            + '- background「データ管理が不十分」↔ problem「データが正しく管理されていない」→ 同語反復\n\n'
            + '## レビュー基準\n'
            + 'textに以下の3つのうち2つ以上が欠けていたらthinに降格:\n'
            + '1. 固有名詞レベルの具体性（チーム名、ツール名、プロダクト名）\n'
            + '2. 定量情報（頻度、件数、人数、時間）\n'
            + '3. 具体的な困りごとのシーン描写（いつ、何をしている時に、どう困るか）\n\n'
            + '## JSON出力のみ\n'
            + '{"reviews":{"[観点キー]":{"originalStatus":"ok","reviewedStatus":"ok|thin","reason":"判定理由"}},'
            + '"redundancyCheck":{"detected":true,"explanation":"理由"}}';
    }

    /**
     * 2回目バリデーション結果を1回目結果に適用
     * ※ これはAI（セカンドオピニオン）の判定であり、コードレベルの上書きではない
     */
    function applyValidation(validated, valResult) {
        console.log('[OrchestratorCrew] バリデーション結果適用（AIセカンドオピニオン）');
        if (valResult.reviews) {
            for (const [key, review] of Object.entries(valResult.reviews)) {
                if (review.reviewedStatus === 'thin' && validated.aspectUpdates[key]?.status === 'ok') {
                    console.log('[OrchestratorCrew] AIレビュー: ' + key + ': ok→thin（' + review.reason + '）');
                    validated.aspectUpdates[key].status = 'thin';
                    validated.aspectUpdates[key].reason = 'AIレビュー降格: ' + review.reason;
                }
            }
        }
        if (valResult.redundancyCheck?.detected) {
            console.log('[OrchestratorCrew] AIレビュー同語反復検出: ' + valResult.redundancyCheck.explanation);
            if (validated.aspectUpdates.background?.status === 'ok') {
                validated.aspectUpdates.background.status = 'thin';
                validated.aspectUpdates.background.reason = '同語反復(AIレビュー): ' + valResult.redundancyCheck.explanation;
            }
            if (validated.aspectUpdates.problem?.status === 'ok') {
                validated.aspectUpdates.problem.status = 'thin';
                validated.aspectUpdates.problem.reason = '同語反復(AIレビュー): ' + valResult.redundancyCheck.explanation;
            }
        }
        return validated;
    }

    // ===================================================
    // relatedUpdatesフィルタリング
    // ※ AIが返したactionやnewTextに基づく最小限のフィルタのみ
    //    status判定の変更は行わない
    // ===================================================

    function filterRelatedUpdates(updates) {
        if (!Array.isArray(updates)) return [];
        const filtered = updates.filter(ru => {
            if (!ru.aspect) return false;
            if (ru.action === 'skip') {
                console.log(`[OrchestratorCrew] relatedUpdate ${ru.aspect}: skip（${ru.reason || '不明'}）`);
                return false;
            }
            if (!ru.newText?.trim()) {
                console.log(`[OrchestratorCrew] relatedUpdate ${ru.aspect}: newText空`);
                return false;
            }
            console.log(`[OrchestratorCrew] relatedUpdate ${ru.aspect}: 適用`);
            return true;
        });
        console.log(`[OrchestratorCrew] relatedUpdates適用: ${filtered.length}/${updates.length}件`);
        return filtered;
    }

    return {
        buildValidationPrompt,
        applyValidation,
        filterRelatedUpdates,
    };
})();
