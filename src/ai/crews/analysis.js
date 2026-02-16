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
     * FB品質のコードレベル検証
     * プロンプトだけでは制御できない品質問題をコード側で検出する
     */
    function validateFBQuality(update) {
        const violations = [];
        if (!update) return violations;

        const status = update.status;
        const reason = update.reason || '';
        const advice = update.advice || '';
        const example = update.example || '';

        // ① reason自己矛盾: 肯定語でthin判定しているのに不足分析がない
        if (status === 'thin') {
            const positiveWords = ['示された', '明確になった', '具体的に説明', '判明した', '追加された',
                '浮き彫りになった', '明らかになった', '情報が追加', '具体的に述べ', '具体性が加わ'];
            const deficitWords = ['不足', '不明', '欠けて', '特定されていない', '曖昧', 'まだ',
                '足りて', '描かれていない', '示されていない', '不十分'];
            const hasPositive = positiveWords.some(p => reason.includes(p));
            const hasDeficit = deficitWords.some(p => reason.includes(p));
            if (hasPositive && !hasDeficit) {
                violations.push({
                    type: 'SELF_CONTRADICTION',
                    detail: `reasonに肯定的評価（${positiveWords.filter(p => reason.includes(p)).join('、')}）があるがthin判定。不足点が具体的に指摘されていない。充足分析の後に「一方で〜が不足」と明記せよ`,
                    field: 'reason'
                });
            }
        }

        // ② advice禁止パターン
        const adviceProhibited = [
            { pattern: '考えてみてください', fix: '具体的な問いかけや選択肢で思考を誘発せよ' },
            { pattern: '振り返ってみてください', fix: '何をどの観点で振り返るか具体化せよ' },
            { pattern: 'ことが重要です', fix: '重要性の指摘ではなく具体的アクションを示せ' },
            { pattern: 'について考えて', fix: '何をどう考えるか、問いかけの形で示せ' },
            { pattern: '具体的な事例を挙げて', fix: 'AI自身がたたき台例を先に提示し、ユーザーに置き換えを促せ' },
        ];
        const adviceMatched = adviceProhibited.filter(p => advice.includes(p.pattern));
        if (adviceMatched.length > 0) {
            violations.push({
                type: 'GENERIC_ADVICE',
                detail: `禁止パターン: 「${adviceMatched.map(m => m.pattern).join('」「')}」→ ${adviceMatched.map(m => m.fix).join('; ')}`,
                field: 'advice'
            });
        }

        // ③ example指示文パターン（記述例でなく指示になっている）
        const exampleProhibited = [
            { pattern: 'を明記する', fix: '明記すべき内容そのものを書け' },
            { pattern: 'が考えられます', fix: '推測ではなく具体的な記述例を提示せよ' },
            { pattern: 'を考えてみて', fix: '考えさせるのではなくたたき台の文章を先に提示せよ' },
            { pattern: 'を具体的に', fix: '「具体的に」ではなく具体的な文章そのものを書け' },
            { pattern: 'を挙げてみて', fix: '挙げるべき例そのものをAIが先に示せ' },
            { pattern: 'を思い出してみて', fix: '思い出す対象の具体例をAIが先に示せ' },
            { pattern: 'を思い出して', fix: '思い出す対象の具体例をAIが先に示せ' },
        ];
        const exampleMatched = exampleProhibited.filter(p => example.includes(p.pattern));
        if (exampleMatched.length > 0) {
            violations.push({
                type: 'DIRECTIVE_EXAMPLE',
                detail: `指示文パターン: 「${exampleMatched.map(m => m.pattern).join('」「')}」→ ${exampleMatched.map(m => m.fix).join('; ')}`,
                field: 'example'
            });
        }

        // ④ 分析不在reason: 分析ではなく作業宣言や関連性の言及だけで終わっている
        if (reason) {
            const noAnalysisPatterns = [
                '追加します', '追加する', '関連しているため', '関連している',
                '情報を追加', 'について追記', '具体性を高めるため'
            ];
            const analysisIndicators = [
                '不足', '不明', '欠けて', '特定されて', '曖昧', '具体的に述べ',
                '一方で', 'ただし', 'しかし', '層が', '描かれて', 'ため、status'
            ];
            const hasNoAnalysis = noAnalysisPatterns.some(p => reason.includes(p));
            const hasAnalysis = analysisIndicators.some(p => reason.includes(p));
            if (hasNoAnalysis && !hasAnalysis) {
                violations.push({
                    type: 'NO_ANALYSIS_REASON',
                    detail: 'reasonが作業宣言（「追加します」「関連しているため」）に留まり、充足分析・不足分析が含まれていない。ユーザーの発言の何が充足し何が不足かを分析せよ',
                    field: 'reason'
                });
            }
        }

        return violations;
    }

    /**
     * API応答から分析結果をパース・検証
     */
    function parseResult(result) {
        console.log('[AnalysisCrew] 結果パース');
        let allViolations = [];

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
                // FB品質検証
                const v = validateFBQuality(val);
                if (v.length > 0) {
                    console.warn(`[AnalysisCrew] ${key}: FB品質違反 ${v.length}件: ${v.map(x => x.type).join(', ')}`);
                    allViolations.push({ aspect: key, violations: v });
                }
            }
        }

        // aspectUpdate (セッション) の検証
        if (result.aspectUpdate) {
            const u = result.aspectUpdate;
            console.log('[AnalysisCrew] セッション分析: ' + u.aspect + '=' + u.status);
            if (!u.reason) console.warn('[AnalysisCrew] reason未設定');
            if (!u.advice) console.warn('[AnalysisCrew] advice未設定');
            // FB品質検証
            const v = validateFBQuality(u);
            if (v.length > 0) {
                console.warn(`[AnalysisCrew] ${u.aspect}: FB品質違反 ${v.length}件: ${v.map(x => x.type).join(', ')}`);
                allViolations.push({ aspect: u.aspect, violations: v });
            }
        }

        // relatedUpdates（横展開）の検証 — 品質は横展開でも同じ基準で担保する
        if (result.relatedUpdates && Array.isArray(result.relatedUpdates)) {
            for (const ru of result.relatedUpdates) {
                if (ru.action === 'skip') continue;
                const ruAsUpdate = {
                    status: ru.newStatus || 'thin',
                    reason: ru.reason || '',
                    advice: ru.advice || '',
                    example: ru.example || '',
                };
                const v = validateFBQuality(ruAsUpdate);
                if (v.length > 0) {
                    console.warn(`[AnalysisCrew] relatedUpdate ${ru.aspect}: FB品質違反 ${v.length}件: ${v.map(x => x.type).join(', ')}`);
                    allViolations.push({ aspect: `related:${ru.aspect}`, violations: v });
                }
            }
        }

        // 違反を結果に付与（pipeline.jsで活用）
        if (allViolations.length > 0) {
            result._fbViolations = allViolations;
            console.warn(`[AnalysisCrew] FB品質違反合計: ${allViolations.reduce((s, a) => s + a.violations.length, 0)}件`);
        }

        return result;
    }

    return { buildInitialPrompt, buildSessionPrompt, buildInitialMessages, buildSessionMessages, parseResult };
})();
