/* ===================================================
   パイプライン v7: Planner + Interviewer アーキテクチャ

   設計思想:
   - Planner AI（裏方）: Why特化の壁打ち計画をJSON生成 → UIに出さない
   - Interviewer AI（表舞台）: PlannerのJSONを基に自然な会話テキスト生成
   - State Machine: current_task_index + cognitive_filter + why_completeness_score
   - DB: AI→プログラム→DB→AI（AIへの伝言ゲーム排除）
   =================================================== */

const Pipeline = (() => {
    'use strict';

    const API_URL = '/api/chat';

    // ===================================================
    // プロセスログ管理
    // ===================================================
    let _processLog = [];
    function clearProcessLog() { _processLog = []; }
    function getProcessLog() { return _processLog; }

    function addLog(step, label, messages, response, usage) {
        const systemContent = (messages.find(m => m.role === 'system')?.content || '');
        const userContent = (messages.find(m => m.role === 'user')?.content || '');
        const historyMessages = messages.filter(m => m.role !== 'system' && m.role !== 'user');

        _processLog.push({
            step,
            label,
            request: {
                messageCount: messages.length,
                systemPrompt: systemContent,
                userMessage: userContent,
                historyCount: historyMessages.length,
            },
            response: response || {},
            usage: usage || {},
            inputTokens: usage?.prompt_tokens || 0,
            outputTokens: usage?.completion_tokens || 0,
            totalTokens: usage?.total_tokens || 0,
            systemPromptLength: systemContent.length,
            userMessageLength: userContent.length,
            responseKeys: response ? Object.keys(response).filter(k => !k.startsWith('_')) : [],
            timestamp: new Date().toISOString(),
        });

        console.log(`[Pipeline] Step${step} [${label}] tokens:${usage?.total_tokens || '?'}`);
    }

    // ===================================================
    // スライダー回答パーサー
    // ===================================================
    /**
     * ユーザーのスライダー回答テキストを構造化オブジェクトに変換
     * 例: "[回答] 仮説A: 80%, 仮説B: 20%" → { "仮説A": 80, "仮説B": 20 }
     */
    function parseSliderAnswer(text) {
        if (!text || !text.startsWith('[回答]')) return null;
        const result = {};
        const pattern = /([^:,\[\]]+):\s*(\d+)%/g;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const label = match[1].trim();
            if (label && label !== '回答') {
                result[label] = parseInt(match[2], 10);
            }
        }
        return Object.keys(result).length > 0 ? result : null;
    }

    // ===================================================
    // API呼出し（共通基盤）
    // ===================================================
    async function callAPI(messages, signal, options = {}) {
        console.log('[callAPI] リクエスト送信: messages=', messages.length, '件, jsonMode=', options.jsonMode !== false);
        const resp = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages,
                jsonMode: options.jsonMode !== false,
                maxTokens: options.maxTokens || 2000,
            }),
            signal,
        });
        if (!resp.ok) {
            const errorText = await resp.text().catch(() => '(レスポンス読取失敗)');
            console.error(`[callAPI] HTTPエラー: status=${resp.status}, body=${errorText.substring(0, 500)}`);
            let errObj;
            try { errObj = JSON.parse(errorText); } catch { errObj = null; }
            const message = errObj?.detail || errObj?.error || `HTTP ${resp.status}: ${errorText.substring(0, 200)}`;
            throw new Error(message);
        }
        const data = await resp.json();
        const reply = data.reply;
        console.log('[callAPI] token使用量:', JSON.stringify(data.usage || {}));

        if (options.jsonMode === false) {
            const text = typeof reply === 'object' ? JSON.stringify(reply) : (reply || '');
            return { _text: text, _usage: data.usage || {} };
        }

        let parsed;
        if (typeof reply === 'object' && reply !== null) {
            parsed = reply;
        } else {
            try {
                parsed = JSON.parse(reply);
            } catch {
                const match = reply?.match(/\{[\s\S]*\}/);
                if (match) {
                    try { parsed = JSON.parse(match[0]); } catch { /* fall through */ }
                }
                if (!parsed) {
                    console.log('[callAPI] テキストレスポンスとして処理');
                    return { _text: reply, _usage: data.usage || {} };
                }
            }
        }

        parsed._usage = data.usage || {};
        return parsed;
    }

    // ===================================================
    // Planner結果 + Interviewerテキスト → UI用フィードバック生成
    // ===================================================
    function buildPhase0FeedbackResult(phase0Result, interviewerText) {
        const score = phase0Result.why_completeness_score || 0;
        const tasks = phase0Result.tasks || [];
        const currentIndex = phase0Result.current_task_index || 0;

        // 完了判定: tasksの末尾が status:"completed" か、scoreが80以上か
        const lastTask = tasks[tasks.length - 1];
        const isCompleted = lastTask?.status === 'completed' || score >= 80;

        // Interviewerの自然テキストをそのままmessageに
        const message = interviewerText || 'もう少し詳しく教えてください。';

        // thinking: Plannerの裏情報（折りたたみ表示用）
        const tasksSummary = tasks.map(t => {
            const icon = t.status === 'done' ? '✓' : t.status === 'completed' ? '🎯' : t.status === 'retry' ? '↻' : '…';
            return `  ${icon} [step ${t.step}] ${t.name}`;
        }).join('\n');

        const thinking = [
            `abstractGoal: ${phase0Result.abstractGoal || '未特定'}`,
            `sessionPurpose: ${phase0Result.sessionPurpose || '未設定'}`,
            `why_completeness_score: ${score}%`,
            `cognitive_filter: ${(phase0Result.cognitive_filter?.detected_how_what || []).join(', ')}`,
            `current_task_index: ${currentIndex}`,
            `assumptions: ${(phase0Result.assumptions || []).join(' / ')}`,
            `completed: ${isCompleted}`,
            `--- タスク一覧 ---`,
            tasksSummary,
        ].join('\n');

        // completionData: 完了時にUIへ渡す構造化サマリー
        const doneTasks = tasks.filter(t => t.status === 'done');
        const completionData = isCompleted ? {
            sessionPurpose: phase0Result.sessionPurpose || phase0Result.abstractGoal || '',
            abstractGoal: phase0Result.abstractGoal || '',
            why_completeness_score: score,
            doneTasks: doneTasks.map(t => ({
                step: t.step,
                question: t.name,
                options: t.options || [],
                result: t.result || {},
            })),
        } : null;

        return {
            message: message.trim(),
            thinking,
            // レガシーUI互換（空値）
            aspectUpdates: {},
            contamination: { detected: false, items: [] },
            crossCheck: { redundancy: { detected: false, pairs: [] }, logicChain: { connected: true } },
            // Planner詳細（デバッグ用・折りたたみ内）
            _v4: {
                goal: phase0Result.goal,
                abstractGoal: phase0Result.abstractGoal,
                sessionPurpose: phase0Result.sessionPurpose,
                tasks: phase0Result.tasks,
                asIs: phase0Result.asIs,
                assumptions: phase0Result.assumptions,
                cognitive_filter: phase0Result.cognitive_filter,
                why_completeness_score: score,
            },
            // アキネーター形式対応: 完了なら空配列、未完了は現在タスクのoptions
            uiOptions: isCompleted ? [] : (tasks[currentIndex] || {}).options || [],
            uiQuestionType: isCompleted ? null : (tasks[currentIndex] || {}).question_type || 'scale',
            // 完了フラグ＋サマリー
            isCompleted,
            completionData,
        };
    }

    // ===================================================
    // パイプライン: 初回分析 (Planner Turn1)
    // ===================================================
    async function analyzeInitialInput(overview, whyText, sessionId, signal) {
        console.log('[Pipeline v7] === 初回分析開始 ===');
        clearProcessLog();

        const userMessage = `## 概要\n${overview}\n\n## Why\n${whyText}`;
        const turnNumber = 1;

        // === Step 1: Planner AI — 壁打ち計画生成（裏方） ===
        console.log('[Pipeline v7] Step1: Planner — cognitive_filter → current_state → core_purpose → tasks');
        const plannerMessages = IntentCrew.buildInitialMessages(userMessage);
        const plannerRaw = await callAPI(plannerMessages, signal);
        const plannerUsage = plannerRaw._usage; delete plannerRaw._usage;
        const plan = IntentCrew.parseResult(plannerRaw);
        plan.current_task_index = 0;
        addLog(1, 'Planner — 壁打ち計画生成', plannerMessages, plan, plannerUsage);

        // State Machine: 計画全体をDB保存
        try {
            await SupabaseClient.saveGoalHistory(sessionId, turnNumber, {
                goal: plan.goal,
                sessionPurpose: plan.sessionPurpose,
                tasks: plan.tasks,
                asIs: plan.asIs,
                gap: plan.gap,
                assumptions: plan.assumptions,
                cognitive_filter: plan.cognitive_filter,
                current_task_index: 0,
                why_completeness_score: plan.why_completeness_score,
                abstractGoal: plan.abstractGoal,
            });
            console.log('[Pipeline v7] State保存成功: index=0, score=' + plan.why_completeness_score + '%');
        } catch (e) { console.warn('[Pipeline] State保存失敗:', e.message); }

        // === Step 2: Interviewer AI — 自然な会話テキスト生成（表舞台） ===
        console.log('[Pipeline v7] Step2: Interviewer — 自然な会話テキスト生成');
        const interviewerMessages = InterviewerCrew.buildInitialMessages(plan, userMessage);
        const interviewerRaw = await callAPI(interviewerMessages, signal, { jsonMode: false, maxTokens: 1000 });
        const interviewerUsage = interviewerRaw._usage; delete interviewerRaw._usage;
        const interviewerText = interviewerRaw._text || '';
        addLog(2, 'Interviewer — 会話テキスト生成', interviewerMessages, { text: interviewerText }, interviewerUsage);

        // Interviewer結果からUI用フィードバックを生成
        const finalResult = buildPhase0FeedbackResult(plan, interviewerText);
        finalResult._processLog = getProcessLog();

        console.log('[Pipeline v7] === 初回分析完了 ===');
        return finalResult;
    }

    // ===================================================
    // パイプライン: 壁打ちチャット (Planner Turn2+ State Machine)
    // ===================================================
    async function chat(userMessage, context, signal) {
        console.log('[Pipeline v7] === チャット開始 ===');
        clearProcessLog();

        const sessionId = context?.sessionId;

        // --- State Machine: 前回のPlan全体を読込 ---
        const prevState = sessionId ? await loadLatestGoal(sessionId) : null;
        console.log('[Pipeline v7] 前回State:', prevState ? `turn=${prevState.turn_number}, index=${prevState.current_task_index || 0}` : 'なし');

        // 前回のPlanをprevPlanオブジェクトに組み立て（DB→AI伝達）
        const prevPlan = prevState ? {
            rawGoal: prevState.goal_text || '',
            sessionPurpose: prevState.session_purpose || '',
            tasks: prevState.tasks || [],
            cognitive_filter: prevState.cognitive_filter || {},
            why_completeness_score: prevState.why_completeness_score || 0,
            current_task_index: prevState.current_task_index || 0,
            asIs: prevState.as_is || [],
            assumptions: prevState.assumptions || [],
        } : null;

        // === スライダー回答のパースと構造化 ===
        if (prevPlan && userMessage && userMessage.startsWith('[回答]')) {
            const sliderResult = parseSliderAnswer(userMessage);
            const taskIdx = prevPlan.current_task_index || 0;
            if (sliderResult && prevPlan.tasks[taskIdx]) {
                prevPlan.tasks[taskIdx].result = sliderResult;
                console.log('[Pipeline v7] スライダー回答を構造化:', JSON.stringify(sliderResult));
            }
        }

        // ターン番号
        const turnNumber = prevState ? (prevState.turn_number || 0) + 1 : 1;

        // === Step 1: Planner AI — status判定 + 再計画（裏方） ===
        console.log('[Pipeline v7] Step1: Planner — status判定 + 再計画');
        const plannerMessages = IntentCrew.buildSessionMessages(userMessage, prevPlan);
        const plannerRaw = await callAPI(plannerMessages, signal);
        const plannerUsage = plannerRaw._usage; delete plannerRaw._usage;
        const plan = IntentCrew.parseResult(plannerRaw);
        addLog(1, 'Planner — status判定+再計画', plannerMessages, plan, plannerUsage);

        // State Machine: current_task_indexを更新
        const prevIndex = prevPlan?.current_task_index || 0;
        let newIndex = prevIndex;
        if (plan.tasks && plan.tasks[prevIndex]?.status === 'done') {
            newIndex = prevIndex + 1;
            console.log('[Pipeline v7] タスク完了: index ' + prevIndex + ' → ' + newIndex);
        } else if (plan.tasks && plan.tasks[prevIndex]?.status === 'retry') {
            console.log('[Pipeline v7] タスクretry: index ' + prevIndex + ' に留まる');
        }

        plan.current_task_index = newIndex;

        if (plan.sessionPurposeUpdated) {
            console.log('[Pipeline v7] sessionPurpose更新: ' + plan.sessionPurpose);
        }
        if (plan.rawGoalUpdated) {
            console.log('[Pipeline v7] Goal更新: ' + plan.goal);
        }

        // State Machine: Plan全体をDB保存
        if (sessionId) {
            try {
                await SupabaseClient.saveGoalHistory(sessionId, turnNumber, {
                    goal: plan.goal,
                    sessionPurpose: plan.sessionPurpose,
                    goalUpdated: plan.rawGoalUpdated || false,
                    updateReason: '',
                    sessionPurposeUpdated: plan.sessionPurposeUpdated || false,
                    sessionPurposeUpdateReason: plan.sessionPurposeUpdateReason || '',
                    tasks: plan.tasks,
                    asIs: plan.asIs,
                    gap: plan.gap,
                    assumptions: plan.assumptions,
                    cognitive_filter: plan.cognitive_filter,
                    current_task_index: newIndex,
                    why_completeness_score: plan.why_completeness_score,
                    abstractGoal: plan.abstractGoal,
                });
                console.log('[Pipeline v7] State保存成功: index=' + newIndex + ', score=' + plan.why_completeness_score + '%');
            } catch (e) { console.warn('[Pipeline] State保存失敗:', e.message); }
        }

        // === Step 2: Interviewer AI — 自然な会話テキスト生成（表舞台） ===
        console.log('[Pipeline v7] Step2: Interviewer — 自然な会話テキスト生成');
        const interviewerMessages = InterviewerCrew.buildSessionMessages(plan, userMessage);
        const interviewerRaw = await callAPI(interviewerMessages, signal, { jsonMode: false, maxTokens: 1000 });
        const interviewerUsage = interviewerRaw._usage; delete interviewerRaw._usage;
        const interviewerText = interviewerRaw._text || '';
        addLog(2, 'Interviewer — 会話テキスト生成', interviewerMessages, { text: interviewerText }, interviewerUsage);

        // Interviewer結果からUI用フィードバックを生成
        const finalResult = buildPhase0FeedbackResult(plan, interviewerText);
        finalResult._processLog = getProcessLog();

        console.log('[Pipeline v7] === チャット完了 ===');
        return finalResult;
    }

    // ===================================================
    // DB読込ヘルパー
    // ===================================================
    async function loadLatestGoal(sessionId) {
        try {
            return await SupabaseClient.getLatestGoal(sessionId);
        } catch (e) {
            console.warn('[Pipeline] Goal読込失敗:', e.message);
            return null;
        }
    }

    return { analyzeInitialInput, chat, getProcessLog };
})();
