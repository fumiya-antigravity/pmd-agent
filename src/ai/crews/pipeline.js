/* ===================================================
   パイプライン v5: Phase0ループアーキテクチャ

   設計思想:
   - Phase0のみでWhyの深掘り質問を生成
   - Phase0結果をmessageに変換してUIに直接フィードバック
   - ユーザー回答 → Phase0再実行 → の繰り返し

   三層GOAL構造:
   - Layer1: プロダクト使命 (RulesLoader.getProductMission() — 不変)
   - Layer2: sessionPurpose (Phase0で設定・更新 — 方向性の心臓部)
   - Layer3: プロンプトアクション (各API呼出し単位 — 変動)
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
    // Phase0結果 → UI用フィードバック生成
    // ===================================================
    function buildPhase0FeedbackResult(phase0Result) {
        // Phase0のtasksから自然言語の深掘り質問を生成
        const activeTasks = (phase0Result.tasks || [])
            .filter(t => t.status !== 'done')
            .sort((a, b) => (a.priority || 99) - (b.priority || 99));

        let message = '';

        // retryタスクがある場合（的外れ検知）
        const retryTasks = activeTasks.filter(t => t.status === 'retry');
        const pendingTasks = activeTasks.filter(t => t.status !== 'retry');

        if (retryTasks.length > 0) {
            message += 'もう少し深掘りさせてください。\n\n';
            retryTasks.forEach(t => {
                message += `**${t.name}**`;
                if (t.retryReason) {
                    message += `\n（${t.retryReason}）`;
                }
                message += '\n\n';
            });
        }

        if (pendingTasks.length > 0) {
            if (retryTasks.length > 0) {
                message += 'また、以下も聞かせてください。\n\n';
            } else {
                message += 'いくつか深掘りしたいポイントがあります。\n\n';
            }
            pendingTasks.slice(0, 3).forEach(t => {
                message += `**${t.name}**\n`;
                if (t.why) message += `→ ${t.why}\n`;
                message += '\n';
            });
            if (pendingTasks.length > 3) {
                message += `（他${pendingTasks.length - 3}件の深掘りポイントもあります）\n`;
            }
        }

        if (!message) {
            message = 'もう少し詳しく教えてください。';
        }

        // thinking: Goal + sessionPurposeの要約
        const thinking = `Goal: ${phase0Result.goal || '未特定'}\nsessionPurpose: ${phase0Result.sessionPurpose || '未設定'}`;

        return {
            message: message.trim(),
            thinking,
            // レガシーUI互換（空値）
            aspectUpdates: {},
            contamination: { detected: false, items: [] },
            crossCheck: { redundancy: { detected: false, pairs: [] }, logicChain: { connected: true } },
            // Phase0詳細
            _v4: {
                goal: phase0Result.goal,
                sessionPurpose: phase0Result.sessionPurpose,
                tasks: phase0Result.tasks,
                asIs: phase0Result.asIs,
                gap: phase0Result.gap,
                assumptions: phase0Result.assumptions,
            },
        };
    }

    // ===================================================
    // パイプライン: 初回分析 (Phase0のみ)
    // ===================================================
    async function analyzeInitialInput(overview, whyText, sessionId, signal) {
        console.log('[Pipeline v5] === 初回分析開始 ===');
        clearProcessLog();

        const userMessage = `## 概要\n${overview}\n\n## Why\n${whyText}`;
        const turnNumber = 1;

        // === Phase 0: Goal特定 + sessionPurpose + タスク分解 ===
        console.log('[Pipeline v5] Phase0: Goal特定 + sessionPurpose');
        const phase0Messages = IntentCrew.buildInitialMessages(userMessage);
        const phase0Raw = await callAPI(phase0Messages, signal);
        const usage0 = phase0Raw._usage; delete phase0Raw._usage;
        const phase0Result = IntentCrew.parseResult(phase0Raw);
        addLog(1, 'Phase0 — Goal特定+sessionPurpose+タスク分解', phase0Messages, phase0Result, usage0);

        // Goal+sessionPurpose履歴をDB保存
        try {
            await SupabaseClient.saveGoalHistory(sessionId, turnNumber, {
                goal: phase0Result.goal,
                sessionPurpose: phase0Result.sessionPurpose,
                tasks: phase0Result.tasks,
                asIs: phase0Result.asIs,
                gap: phase0Result.gap,
                assumptions: phase0Result.assumptions,
            });
        } catch (e) { console.warn('[Pipeline] Goal保存失敗:', e.message); }

        // Phase0結果からUI用フィードバックを生成
        const finalResult = buildPhase0FeedbackResult(phase0Result);
        finalResult._processLog = getProcessLog();

        console.log('[Pipeline v5] === 初回分析完了 ===');
        return finalResult;
    }

    // ===================================================
    // パイプライン: 壁打ちチャット (Phase0ループ)
    // ===================================================
    async function chat(userMessage, context, signal) {
        console.log('[Pipeline v5] === チャット開始 ===');
        clearProcessLog();

        const sessionId = context?.sessionId;

        // --- 前回の状態読込 ---
        const latestGoal = sessionId ? await loadLatestGoal(sessionId) : null;
        const latestProgress = sessionId ? await loadLatestProgress(sessionId) : null;
        const progressSummary = latestProgress
            ? SynthesisCrew.buildProgressSummary(latestProgress)
            : '';

        // 前回のsessionPurposeを取得
        const previousSessionPurpose = latestGoal?.session_purpose || latestGoal?.goal_text || '';

        // ターン番号
        const turnNumber = latestGoal ? (latestGoal.turn_number || 0) + 1 : 1;

        // === Phase 0: sessionPurpose更新判定 + タスク再分解 ===
        console.log('[Pipeline v5] Phase0: sessionPurpose更新判定');
        const phase0Messages = IntentCrew.buildSessionMessages(
            userMessage,
            latestGoal?.goal_text, previousSessionPurpose,
            latestGoal?.tasks, progressSummary
        );
        const phase0Raw = await callAPI(phase0Messages, signal);
        const usage0 = phase0Raw._usage; delete phase0Raw._usage;
        const phase0Result = IntentCrew.parseResult(phase0Raw);
        addLog(1, 'Phase0 — sessionPurpose更新判定', phase0Messages, phase0Result, usage0);

        if (phase0Result.sessionPurposeUpdated) {
            console.log('[Pipeline v5] sessionPurpose更新: ' + phase0Result.sessionPurpose);
        }
        if (phase0Result.goalUpdated) {
            console.log('[Pipeline v5] Goal更新: ' + phase0Result.goal);
        }

        // Goal+sessionPurpose履歴をDB保存
        if (sessionId) {
            try {
                await SupabaseClient.saveGoalHistory(sessionId, turnNumber, {
                    goal: phase0Result.goal,
                    sessionPurpose: phase0Result.sessionPurpose,
                    goalUpdated: phase0Result.goalUpdated || false,
                    updateReason: phase0Result.updateReason || '',
                    sessionPurposeUpdated: phase0Result.sessionPurposeUpdated || false,
                    sessionPurposeUpdateReason: phase0Result.sessionPurposeUpdateReason || '',
                    tasks: phase0Result.tasks,
                    asIs: phase0Result.asIs,
                    gap: phase0Result.gap,
                    assumptions: phase0Result.assumptions,
                });
            } catch (e) { console.warn('[Pipeline] Goal保存失敗:', e.message); }
        }

        // Phase0結果からUI用フィードバックを生成
        const finalResult = buildPhase0FeedbackResult(phase0Result);
        finalResult._processLog = getProcessLog();

        console.log('[Pipeline v5] === チャット完了 ===');
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
