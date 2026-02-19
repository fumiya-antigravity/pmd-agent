/* ===================================================
   Pipeline v3 — CLARIX パイプライン
   
   A→E→B フロー + Phase遷移 + セッション復元
   
   外部設計 §4-5 準拠
   =================================================== */

const ClarixPipeline = (() => {
    'use strict';

    const API_URL = '/api/chat';
    const MAX_SUB_QUESTION_TURNS = 10;

    // ===================================================
    // API呼出し（共通基盤）
    // ===================================================
    async function callLLM(messages, options = {}) {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages,
                jsonMode: options.jsonMode !== false,
                maxTokens: options.maxTokens || 4000,
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`LLM API Error ${response.status}: ${errText}`);
        }

        const result = await response.json();
        return result.reply;
    }

    /**
     * JSON応答をパースする（LLMのMarkdown装飾などを除去）
     */
    function parseLLMJson(reply) {
        try {
            // ```json ... ``` の中身を抽出
            const match = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
            const raw = match ? match[1].trim() : reply.trim();
            return JSON.parse(raw);
        } catch (e) {
            console.error('[parseLLMJson] パースエラー:', e.message, reply.substring(0, 200));
            return null;
        }
    }

    // ===================================================
    // キーワード抽出（形態素解析の代わりにシンプル実装）
    // ===================================================
    function extractKeywords(text) {
        return text
            .replace(/[。、！？\s\n\r]+/g, ' ')
            .split(' ')
            .filter(w => w.length >= 2)
            .filter(w => !['ですが', 'について', 'それは', 'あれは', 'これは',
                'なので', 'ところ', 'という', 'のです', 'します',
                'になり', 'ている', 'ません'].includes(w));
    }

    // ===================================================
    // Role A (Planner) 呼び出し
    // ===================================================
    async function callRoleA(params) {
        const prompts = PlannerPrompt.build(params);
        const reply = await callLLM([
            { role: 'system', content: prompts.system },
            { role: 'user', content: prompts.user },
        ]);
        const parsed = parseLLMJson(reply);
        if (!parsed) {
            throw new Error('Role A の出力をパースできませんでした');
        }
        return parsed;
    }

    // ===================================================
    // Role E (Manager) 呼び出し
    // ===================================================
    async function callRoleE(plannerOutput, anchor, previousInterviewerQuestion) {
        const prompts = ManagerPrompt.build({
            plannerOutput,
            anchor,
            previousInterviewerQuestion,
        });
        const reply = await callLLM([
            { role: 'system', content: prompts.system },
            { role: 'user', content: prompts.user },
        ]);
        const parsed = parseLLMJson(reply);
        if (!parsed) {
            // Manager失敗時はpassとして扱う（UX優先）
            console.warn('[callRoleE] パースエラー、passとして進行');
            return { alignment_score: 100, drift_detected: false, violations: [], correction: null };
        }
        return parsed;
    }

    // ===================================================
    // Role B (Interviewer) 呼び出し
    // ===================================================
    async function callRoleB(plannerOutput) {
        const prompts = InterviewerV3Prompt.build(plannerOutput);
        const reply = await callLLM([
            { role: 'system', content: prompts.system },
            { role: 'user', content: prompts.user },
        ], { jsonMode: false, maxTokens: 500 });
        return reply;
    }

    // ===================================================
    // Role D (Reporter) 呼び出し
    // ===================================================
    async function callRoleD({ insights, sessionPurpose, history, anchor }) {
        const prompts = ReporterPrompt.build({ insights, sessionPurpose, history, anchor });
        const reply = await callLLM([
            { role: 'system', content: prompts.system },
            { role: 'user', content: prompts.user },
        ], { jsonMode: false, maxTokens: 8000 });
        return reply;
    }

    // ===================================================
    // メインパイプライン: handleProcess
    // 外部設計 §4.2 サーバー側処理フロー準拠
    // ===================================================
    async function handleProcess(sessionId, userMessage) {
        console.log(`[Pipeline] handleProcess 開始: session=${sessionId}`);

        // ── Phase ガード ──
        const session = await SupabaseClient.getSession(sessionId);
        if (!session) {
            return { error: true, code: 'SESSION_NOT_FOUND', message: 'セッションが見つかりません' };
        }
        if (session.phase === 'SLIDER' || session.phase === 'REPORT' || session.phase === 'COMPLETE') {
            return { error: true, code: 'PHASE_MISMATCH', message: `現在のフェーズ(${session.phase})では処理できません` };
        }

        // ── DB読み込み ──
        const latestGoal = await SupabaseClient.getLatestGoal(sessionId);
        const anchor = await SupabaseClient.getSessionAnchor(sessionId);
        const allMessages = await SupabaseClient.getMessages(sessionId, 50);
        const history = allMessages.slice(-20); // 直近20件
        const existingInsights = await SupabaseClient.getConfirmedInsights(sessionId);
        const turn = allMessages.filter(m => m.role === 'user').length;
        const prevInterviewerMsg = [...allMessages].reverse().find(m => m.role === 'assistant')?.content ?? null;

        // メッセージ保存
        await SupabaseClient.saveMessage(sessionId, 'user', userMessage, { turn });

        // ── 初回ターン（turn 0）──
        if (turn === 0 && !anchor) {
            console.log('[Pipeline] 初回ターン処理');
            const plan = await callRoleA({
                userMessage,
                anchor: null,
                latestGoal: null,
                confirmedInsights: [],
                history: [],
                turn: 0,
            });

            // core_keywords: ユーザー発言の全キーワードを保持（What/Howも含む）
            const allKeywords = extractKeywords(userMessage);
            await SupabaseClient.createSessionAnchor(sessionId, {
                original_message: userMessage,
                core_keywords: allKeywords,
                initial_purpose: plan.sessionPurpose || '',
            });

            // Goal History 保存
            await SupabaseClient.saveGoalHistory(sessionId, 0, {
                sessionPurpose: plan.sessionPurpose,
                mgu: plan.main_goal_understanding,
                sqc: plan.sub_question_clarity,
                question_type: plan.question_type,
                cognitive_filter: plan.cognitive_filter,
                why_completeness_score: plan.why_completeness_score,
                active_sub_questions: plan.active_sub_questions,
                manager_alignment_score: 100,
                turn: 0,
                raw_planner_output: plan,
                raw_manager_output: null,
            });

            // Role B で質問生成
            const question = await callRoleB(plan);
            await SupabaseClient.saveMessage(sessionId, 'assistant', question, { turn: 0 });
            await SupabaseClient.updateSession(sessionId, { phase: 'CONVERSATION' });

            return {
                phase: 'CONVERSATION',
                message: question,
                turn: 0,
                debug: {
                    mgu: plan.main_goal_understanding,
                    sqc: plan.sub_question_clarity,
                    question_type: plan.question_type,
                    session_purpose: plan.sessionPurpose,
                    manager_alignment_score: 100,
                    active_sub_questions: plan.active_sub_questions,
                    cognitive_filter: plan.cognitive_filter,
                },
            };
        }

        // ── Turn 1+ ──
        console.log(`[Pipeline] Turn ${turn} 処理`);

        // 派生質問の上限チェック
        if (turn >= MAX_SUB_QUESTION_TURNS) {
            console.log(`[Pipeline] 派生質問ターン上限(${MAX_SUB_QUESTION_TURNS})に到達。Phase 0.5へ強制遷移`);
            // MGU を 80 に強制設定して Phase 0.5 へ
            const forcedPlan = {
                main_goal_understanding: 80,
                sub_question_clarity: 80,
                why_completeness_score: 80,
                sessionPurpose: latestGoal?.session_purpose || '',
                question_type: 'hypothesis',
                active_sub_questions: (latestGoal?.active_sub_questions || []).map(q => ({ ...q, status: 'resolved' })),
                confirmed_insights: [],
                cognitive_filter: latestGoal?.cognitive_filter || {},
                next_question_focus: { target_layer: 'value', focus: '最終確認' },
            };

            await SupabaseClient.saveGoalHistory(sessionId, turn, {
                sessionPurpose: forcedPlan.sessionPurpose,
                mgu: 80, sqc: 80,
                question_type: 'hypothesis',
                active_sub_questions: forcedPlan.active_sub_questions,
                manager_alignment_score: 100,
                turn,
                raw_planner_output: forcedPlan,
            });

            // Phase 0.5 遷移
            const sliderData = Synthesizer.run(existingInsights, anchor?.original_message || '');
            if (sliderData.length === 0) {
                // insights 0 件ガード: 会話継続
                const question = await callRoleB(forcedPlan);
                await SupabaseClient.saveMessage(sessionId, 'assistant', question, { turn });
                return { phase: 'CONVERSATION', message: question, turn, debug: { mgu: 80, forced: true } };
            }

            await SupabaseClient.updateSession(sessionId, { phase: 'SLIDER' });
            return { phase: 'SLIDER', insights: sliderData, session_purpose: forcedPlan.sessionPurpose, turn };
        }

        // Role A 呼び出し
        let plan = await callRoleA({
            userMessage,
            anchor,
            latestGoal,
            confirmedInsights: existingInsights,
            history: history.map(m => ({ role: m.role, content: m.content })),
            turn,
        });

        // Role E チェック + リトライ
        let mgr = await callRoleE(plan, anchor, prevInterviewerMsg);
        let retries = 0;
        while (mgr.drift_detected && retries < 2) {
            console.log(`[Pipeline] Role E drift detected (retry ${retries + 1})`);
            plan = await callRoleA({
                userMessage,
                anchor,
                latestGoal,
                confirmedInsights: existingInsights,
                history: history.map(m => ({ role: m.role, content: m.content })),
                turn,
                managerCorrection: mgr.correction,
            });
            mgr = await callRoleE(plan, anchor, prevInterviewerMsg);
            retries++;
        }

        if (mgr.drift_detected) {
            // 3回リトライしても逸脱 → UX優先で警告だけ出して続行
            console.warn('[Pipeline] Role E: 3回リトライ後も逸脱。UX優先で続行。');
        }

        // DB保存: goal_history
        await SupabaseClient.saveGoalHistory(sessionId, turn, {
            sessionPurpose: plan.sessionPurpose,
            mgu: plan.main_goal_understanding,
            sqc: plan.sub_question_clarity,
            question_type: plan.question_type,
            cognitive_filter: plan.cognitive_filter,
            why_completeness_score: plan.why_completeness_score,
            active_sub_questions: plan.active_sub_questions,
            manager_alignment_score: mgr.alignment_score || 100,
            turn,
            raw_planner_output: plan,
            raw_manager_output: mgr,
        });

        // DB保存: confirmed_insights (差分 upsert)
        if (plan.confirmed_insights && plan.confirmed_insights.length > 0) {
            for (const insight of plan.confirmed_insights) {
                if (insight.confirmation_strength > 0) {
                    await SupabaseClient.upsertConfirmedInsight(sessionId, {
                        ...insight,
                        turn,
                    });
                }
            }
        }

        // 全派生質問解消チェック
        const activeSubQs = plan.active_sub_questions || [];
        const allResolved = activeSubQs.length > 0 && activeSubQs.every(q => q.status === 'resolved');

        // MGU ≥ 80 かつ全派生質問解消 → Phase 0.5 へ
        if (plan.main_goal_understanding >= 80 && allResolved) {
            // 最新 insights を再取得
            const allInsights = await SupabaseClient.getConfirmedInsights(sessionId);

            // insights 0件ガード
            if (allInsights.length === 0) {
                console.log('[Pipeline] MGU≥80だがinsights 0件。会話継続。');
                const question = await callRoleB(plan);
                await SupabaseClient.saveMessage(sessionId, 'assistant', question, { turn });
                return {
                    phase: 'CONVERSATION',
                    message: question,
                    turn,
                    debug: buildDebug(plan, mgr),
                };
            }

            // Role C で整形
            const sliderData = Synthesizer.run(allInsights, anchor?.original_message || '');
            await SupabaseClient.updateSession(sessionId, { phase: 'SLIDER' });

            console.log(`[Pipeline] Phase 0.5 へ遷移 (MGU=${plan.main_goal_understanding})`);
            return {
                phase: 'SLIDER',
                insights: sliderData,
                session_purpose: plan.sessionPurpose,
                turn,
                debug: buildDebug(plan, mgr),
            };
        }

        // 会話継続: Role B で質問生成
        const question = await callRoleB(plan);
        await SupabaseClient.saveMessage(sessionId, 'assistant', question, { turn });

        return {
            phase: 'CONVERSATION',
            message: question,
            turn,
            debug: buildDebug(plan, mgr),
        };
    }

    // ===================================================
    // handleReport: スライダー値 → レポート生成
    // 外部設計 §4.5 準拠
    // ===================================================
    async function handleReport(sessionId, sliderWeights) {
        console.log(`[Pipeline] handleReport 開始: session=${sessionId}`);

        const session = await SupabaseClient.getSession(sessionId);
        if (!session || session.phase !== 'SLIDER') {
            return { error: true, code: 'PHASE_MISMATCH', message: 'レポート生成はSLIDERフェーズでのみ可能です' };
        }

        // スライダー値を DB に保存
        for (const [insightId, weight] of Object.entries(sliderWeights)) {
            await SupabaseClient.updateInsightSliderWeight(insightId, weight);
        }

        // データ収集
        const insights = await SupabaseClient.getConfirmedInsights(sessionId);
        const anchor = await SupabaseClient.getSessionAnchor(sessionId);
        const latestGoal = await SupabaseClient.getLatestGoal(sessionId);
        const history = await SupabaseClient.getMessages(sessionId, 50);

        // insights にスライダー重みをマージ
        const weightedInsights = insights.map(ins => ({
            ...ins,
            slider_weight: sliderWeights[ins.id] ?? ins.strength,
        }));

        // Role D でレポート生成
        const reportMarkdown = await callRoleD({
            insights: weightedInsights,
            sessionPurpose: latestGoal?.session_purpose || '',
            history,
            anchor,
        });

        // レポート保存
        await SupabaseClient.createReport(sessionId, reportMarkdown, latestGoal?.session_purpose || '');
        await SupabaseClient.updateSession(sessionId, { phase: 'REPORT' });

        console.log(`[Pipeline] レポート生成完了`);
        return {
            phase: 'REPORT',
            report_markdown: reportMarkdown,
        };
    }

    // ===================================================
    // セッション復元
    // 外部設計 §7 準拠
    // ===================================================
    async function restoreSession(sessionId) {
        const session = await SupabaseClient.getSession(sessionId);
        if (!session) return null;

        switch (session.phase) {
            case 'WELCOME':
                return { phase: 'WELCOME', session };

            case 'CONVERSATION': {
                const messages = await SupabaseClient.getMessages(sessionId, 50);
                const latestGoal = await SupabaseClient.getLatestGoal(sessionId);
                return {
                    phase: 'CONVERSATION',
                    session,
                    messages,
                    debug: latestGoal ? {
                        mgu: latestGoal.mgu,
                        sqc: latestGoal.sqc,
                        question_type: latestGoal.question_type,
                        session_purpose: latestGoal.session_purpose,
                    } : null,
                };
            }

            case 'SLIDER': {
                const insights = await SupabaseClient.getConfirmedInsights(sessionId);
                const anchor = await SupabaseClient.getSessionAnchor(sessionId);
                const latestGoal = await SupabaseClient.getLatestGoal(sessionId);
                const sliderData = Synthesizer.run(insights, anchor?.original_message || '');
                return {
                    phase: 'SLIDER',
                    session,
                    insights: sliderData,
                    session_purpose: latestGoal?.session_purpose || '',
                };
            }

            case 'REPORT':
            case 'COMPLETE': {
                const report = await SupabaseClient.getReport(sessionId);
                return {
                    phase: session.phase,
                    session,
                    report_markdown: report?.report_markdown || '',
                };
            }

            default:
                return { phase: session.phase, session };
        }
    }

    // ===================================================
    // ヘルパー
    // ===================================================
    function buildDebug(plan, mgr) {
        return {
            mgu: plan.main_goal_understanding,
            sqc: plan.sub_question_clarity,
            question_type: plan.question_type,
            session_purpose: plan.sessionPurpose,
            manager_alignment_score: mgr?.alignment_score || 100,
            active_sub_questions: plan.active_sub_questions,
            cognitive_filter: plan.cognitive_filter,
        };
    }

    // ===================================================
    // Public API
    // ===================================================
    return {
        handleProcess,
        handleReport,
        restoreSession,
        extractKeywords,
    };
})();
