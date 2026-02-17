/* ===================================================
   パイプライン v5: Phase0ループアーキテクチャ

   設計思想:
   - Planner AI (Phase0) でWhy特化の壁打ち計画を生成
   - State Machine: current_task_index + cognitive_filter + why_completeness_score
   - DB: AI→プログラム→DB→AI（AIへの伝言ゲーム排除）
   - 将来: Interviewer + Critic Gatekeeper で自律ループ
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
    // PHASE_CHECK: 観点チェック用プロンプト（維持）
    // ===================================================
    const PHASE_CHECK = `## 全観点レビュー
下記の5観点テキストを俯瞰し、status再評価と所見を返せ。
{
  "overview": {"overallStatus": "ready|needs_work", "summary": "全体所見"},
  "aspectResults": {"<key>": {"status": "ok|thin|empty", "feedback": "改善点"}},
  "suggestedAspects": [{"key": "英語キー", "label": "日本語名", "emoji": "絵文字", "reason": "提案理由"}],
  "allApproved": true|false,
  "message": "総合フィードバック（400文字以内）"
}`;

    // ===================================================
    // Planner結果 → UI用フィードバック生成
    // ===================================================
    function buildPhase0FeedbackResult(phase0Result) {
        const tasks = phase0Result.tasks || [];
        const score = phase0Result.why_completeness_score || 0;

        // 現在のタスクインデックスに基づいて表示するタスクを決定
        // Turn1: 最初のタスクのみ表示
        // Turn2+: done/retryの判定結果 + 次タスク
        const activeTasks = tasks.filter(t => t.status !== 'done');
        const retryTasks = activeTasks.filter(t => t.status === 'retry');
        const pendingTasks = activeTasks.filter(t => t.status === 'pending' || t.status === 'new');

        let message = '';

        // Why解像度スコア表示
        message += `**Why解像度: ${score}%**\n\n`;

        if (retryTasks.length > 0) {
            // retryタスク（前回の回答が不十分）
            message += 'もう少し深掘りさせてください。\n\n';
            retryTasks.forEach(t => {
                message += `**${t.name}**`;
                if (t.retryReason) {
                    message += `\n（${t.retryReason}）`;
                }
                message += '\n\n';
            });
        } else if (pendingTasks.length > 0) {
            // 次のペンディングタスク（1つだけ表示 — North Star Injectorの思想）
            const nextTask = pendingTasks[0];
            message += `**${nextTask.name}**\n`;
            if (nextTask.why) message += `→ ${nextTask.why}\n`;
            message += '\n';
            if (pendingTasks.length > 1) {
                message += `（他${pendingTasks.length - 1}件の深掘りポイントもあります）\n`;
            }
        } else {
            message += 'Whyの深掘りが完了しました。次のフェーズに進む準備ができています。\n';
        }

        if (!message.trim()) {
            message = 'もう少し詳しく教えてください。';
        }

        // thinking: 内部情報（折りたたみ表示）
        const thinking = [
            `abstractGoal: ${phase0Result.abstractGoal || '未特定'}`,
            `sessionPurpose: ${phase0Result.sessionPurpose || '未設定'}`,
            `why_completeness_score: ${score}%`,
            `cognitive_filter: ${(phase0Result.cognitive_filter?.detected_how_what || []).join(', ')}`,
        ].join('\n');

        return {
            message: message.trim(),
            thinking,
            // レガシーUI互換（空値）
            aspectUpdates: {},
            contamination: { detected: false, items: [] },
            crossCheck: { redundancy: { detected: false, pairs: [] }, logicChain: { connected: true } },
            // Planner詳細
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
        };
    }

    // ===================================================
    // パイプライン: 初回分析 (Planner Turn1)
    // ===================================================
    async function analyzeInitialInput(overview, whyText, sessionId, signal) {
        console.log('[Pipeline v6] === 初回分析開始 ===');
        clearProcessLog();

        const userMessage = `## 概要\n${overview}\n\n## Why\n${whyText}`;
        const turnNumber = 1;

        // === Planner AI: 壁打ち計画生成 ===
        console.log('[Pipeline v6] Planner: cognitive_filter → current_state → core_purpose → tasks');
        const plannerMessages = IntentCrew.buildInitialMessages(userMessage);
        const plannerRaw = await callAPI(plannerMessages, signal);
        const usage = plannerRaw._usage; delete plannerRaw._usage;
        const plan = IntentCrew.parseResult(plannerRaw);
        addLog(1, 'Planner — 壁打ち計画生成', plannerMessages, plan, usage);

        // State Machine: 計画全体をDB保存
        try {
            await SupabaseClient.saveGoalHistory(sessionId, turnNumber, {
                goal: plan.goal,
                sessionPurpose: plan.sessionPurpose,
                tasks: plan.tasks,
                asIs: plan.asIs,
                gap: plan.gap,
                assumptions: plan.assumptions,
                // State Machine用
                cognitive_filter: plan.cognitive_filter,
                current_task_index: 0,
                why_completeness_score: plan.why_completeness_score,
                abstractGoal: plan.abstractGoal,
            });
            console.log('[Pipeline v6] State保存成功: index=0, score=' + plan.why_completeness_score + '%');
        } catch (e) { console.warn('[Pipeline] State保存失敗:', e.message); }

        // Planner結果からUI用フィードバックを生成
        const finalResult = buildPhase0FeedbackResult(plan);
        finalResult._processLog = getProcessLog();

        console.log('[Pipeline v6] === 初回分析完了 ===');
        return finalResult;
    }

    // ===================================================
    // パイプライン: 壁打ちチャット (Planner Turn2+ State Machine)
    // ===================================================
    async function chat(userMessage, context, signal) {
        console.log('[Pipeline v6] === チャット開始 ===');
        clearProcessLog();

        const sessionId = context?.sessionId;

        // --- State Machine: 前回のPlan全体を読込 ---
        const prevState = sessionId ? await loadLatestGoal(sessionId) : null;
        console.log('[Pipeline v6] 前回State:', prevState ? `turn=${prevState.turn_number}, index=${prevState.current_task_index || 0}` : 'なし');

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

        // ターン番号
        const turnNumber = prevState ? (prevState.turn_number || 0) + 1 : 1;

        // === Planner AI: Turn2+ — status判定 + 再計画 ===
        console.log('[Pipeline v6] Planner Turn2+: status判定 + 再計画');
        const plannerMessages = IntentCrew.buildSessionMessages(userMessage, prevPlan);
        const plannerRaw = await callAPI(plannerMessages, signal);
        const usage = plannerRaw._usage; delete plannerRaw._usage;
        const plan = IntentCrew.parseResult(plannerRaw);
        addLog(1, 'Planner — status判定+再計画', plannerMessages, plan, usage);

        // State Machine: current_task_indexを更新
        const prevIndex = prevPlan?.current_task_index || 0;
        let newIndex = prevIndex;
        if (plan.tasks && plan.tasks[prevIndex]?.status === 'done') {
            newIndex = prevIndex + 1;
            console.log('[Pipeline v6] タスク完了: index ' + prevIndex + ' → ' + newIndex);
        } else if (plan.tasks && plan.tasks[prevIndex]?.status === 'retry') {
            console.log('[Pipeline v6] タスクretry: index ' + prevIndex + ' に留まる');
        }

        if (plan.sessionPurposeUpdated) {
            console.log('[Pipeline v6] sessionPurpose更新: ' + plan.sessionPurpose);
        }
        if (plan.rawGoalUpdated) {
            console.log('[Pipeline v6] Goal更新: ' + plan.goal);
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
                    // State Machine用
                    cognitive_filter: plan.cognitive_filter,
                    current_task_index: newIndex,
                    why_completeness_score: plan.why_completeness_score,
                    abstractGoal: plan.abstractGoal,
                });
                console.log('[Pipeline v6] State保存成功: index=' + newIndex + ', score=' + plan.why_completeness_score + '%');
            } catch (e) { console.warn('[Pipeline] State保存失敗:', e.message); }
        }

        // Planner結果からUI用フィードバックを生成
        const finalResult = buildPhase0FeedbackResult(plan);
        finalResult._processLog = getProcessLog();

        console.log('[Pipeline v6] === チャット完了 ===');
        return finalResult;
    }

    // ===================================================
    // Layer読込ヘルパー
    // ===================================================
    async function loadLatestGoal(sessionId) {
        try {
            return await SupabaseClient.getLatestGoal(sessionId);
        } catch (e) {
            console.warn('[Pipeline] Goal読込失敗:', e.message);
            return null;
        }
    }

    async function loadLatestProgress(sessionId) {
        try {
            const progress = await SupabaseClient.getLatestProgress(sessionId);
            return progress?.synthesis_result || null;
        } catch (e) {
            console.warn('[Pipeline] Progress読込失敗:', e.message);
            return null;
        }
    }

    // ===================================================
    // 観点チェック（維持 — v3と同じ）
    // ===================================================
    async function checkAspects(aspects, signal) {
        clearProcessLog();
        let info = '';
        for (const [key, text] of Object.entries(aspects)) {
            info += `### ${key}\n${text || '（空欄）'}\n\n`;
        }
        const messages = [
            { role: 'system', content: RulesLoader.getCore() + '\n\n' + PHASE_CHECK },
            { role: 'user', content: `## 観点チェック\n\n${info}` },
        ];
        const result = await callAPI(messages, signal);
        const usage = result._usage; delete result._usage;
        addLog(1, '観点チェック', messages, result, usage);
        result._processLog = getProcessLog();
        return result;
    }

    return { analyzeInitialInput, chat, checkAspects, getProcessLog };
})();
