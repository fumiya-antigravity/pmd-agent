/* ===================================================
   パイプライン v4: 多段収集・コード統合アーキテクチャ

   設計思想:
   - Phase0: Goal特定+タスク分解 (APIコール1回)
   - Phase1: タスク駆動FB収集+メタタスク (並列APIコール)
   - Phase2: コード統合+パーソナリティdiffマージ (APIなし)
   - Phase3: 最終構造化 (APIコール1回)

   3層Context:
   - Layer3: プロダクト方向性 (RulesLoader — 不変)
   - Layer2: Goal + パーソナリティ (DB永続 — 動的進化)
   - Layer1: セッション進捗 (DB蓄積)
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

        _processLog.push({
            step,
            label,
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
    // API呼出し（共通基盤）— v3から転用、レスポンスパース含む
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

        // jsonMode=false の場合、テキストとして返す
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

    /**
     * テキスト応答を安全に取得
     */
    function getResponseText(result) {
        if (result._text) return result._text;
        if (typeof result === 'string') return result;
        return JSON.stringify(result);
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
    // パイプライン: 初回分析 (Phase0 → 1 → 2 → 3)
    // ===================================================
    async function analyzeInitialInput(overview, whyText, sessionId, signal) {
        console.log('[Pipeline v4] === 初回分析開始 ===');
        clearProcessLog();

        const userMessage = `## 概要\n${overview}\n\n## Why\n${whyText}`;

        // --- Layer読込 ---
        const personality = await loadPersonality();
        const turnNumber = 1;

        // === Phase 0: Goal特定 + タスク分解 ===
        console.log('[Pipeline v4] Phase0: Goal特定');
        const phase0Messages = IntentCrew.buildInitialMessages(userMessage, personality);
        const phase0Raw = await callAPI(phase0Messages, signal);
        const usage0 = phase0Raw._usage; delete phase0Raw._usage;
        const phase0Result = IntentCrew.parseResult(phase0Raw);
        addLog(1, 'Phase0 — Goal特定+タスク分解', phase0Messages, phase0Result, usage0);

        // Goal履歴をDB保存
        try {
            await SupabaseClient.saveGoalHistory(sessionId, turnNumber, {
                goal: phase0Result.goal,
                tasks: phase0Result.tasks,
                asIs: phase0Result.asIs,
                gap: phase0Result.gap,
                assumptions: phase0Result.assumptions,
            });
        } catch (e) { console.warn('[Pipeline] Goal保存失敗:', e.message); }

        // === Phase 1: 並列FB収集 ===
        console.log('[Pipeline v4] Phase1: 並列FB収集');
        const layer3 = RulesLoader.getCore();
        const phase1Prompts = PerspectivePrompts.buildAll(
            phase0Result, layer3, personality, null, userMessage
        );

        const phase1Results = await runPhase1Parallel(phase1Prompts, signal);

        // === Phase 2: コード統合 ===
        console.log('[Pipeline v4] Phase2: コード統合');
        const synthesisResult = SynthesisCrew.synthesize(phase0Result, phase1Results);

        // パーソナリティdiffマージ
        const existingContext = await loadUserContext();
        const personalityUpdates = SynthesisCrew.mergePersonality(
            synthesisResult.personalityAnalysis, existingContext
        );
        if (personalityUpdates) {
            try {
                await SupabaseClient.upsertUserContext(personalityUpdates);
                console.log('[Pipeline v4] パーソナリティ更新完了');
            } catch (e) { console.warn('[Pipeline] パーソナリティ保存失敗:', e.message); }
        }

        // セッション進捗をDB保存
        try {
            await SupabaseClient.saveSessionProgress(sessionId, turnNumber, {
                resolvedItems: synthesisResult.resolvedItems,
                accumulatedFacts: synthesisResult.accumulatedFacts,
                synthesisResult: synthesisResult.aspectData,
            });
        } catch (e) { console.warn('[Pipeline] 進捗保存失敗:', e.message); }

        addLog(2, 'Phase2 — コード統合', [], synthesisResult, {});

        // === Phase 3: 最終構造化 ===
        console.log('[Pipeline v4] Phase3: 最終構造化');
        const phase3Result = await runPhase3(
            phase0Result, synthesisResult, userMessage, layer3, signal
        );

        // レガシー互換: aspectUpdatesを結果に含める
        const finalResult = buildFinalResult(phase0Result, synthesisResult, phase3Result);
        finalResult._processLog = getProcessLog();

        console.log('[Pipeline v4] === 初回分析完了 ===');
        return finalResult;
    }

    // ===================================================
    // パイプライン: 壁打ちチャット (Phase0 → 1 → 2 → 3)
    // ===================================================
    async function chat(userMessage, context, signal) {
        console.log('[Pipeline v4] === チャット開始 ===');
        clearProcessLog();

        const sessionId = context?.sessionId;
        const conversationHistory = context?.conversationHistory || [];

        // --- Layer読込 ---
        const personality = await loadPersonality();
        const latestGoal = sessionId ? await loadLatestGoal(sessionId) : null;
        const latestProgress = sessionId ? await loadLatestProgress(sessionId) : null;
        const progressSummary = latestProgress
            ? SynthesisCrew.buildProgressSummary(latestProgress)
            : '';

        // ターン番号
        const turnNumber = latestGoal ? (latestGoal.turn_number || 0) + 1 : 1;

        // === Phase 0: Goal更新判定 ===
        console.log('[Pipeline v4] Phase0: Goal更新判定');
        const phase0Messages = IntentCrew.buildSessionMessages(
            userMessage, personality,
            latestGoal?.goal_text, latestGoal?.tasks, progressSummary
        );
        const phase0Raw = await callAPI(phase0Messages, signal);
        const usage0 = phase0Raw._usage; delete phase0Raw._usage;
        const phase0Result = IntentCrew.parseResult(phase0Raw);
        addLog(1, 'Phase0 — Goal更新判定', phase0Messages, phase0Result, usage0);

        if (phase0Result.goalUpdated) {
            console.log('[Pipeline v4] Goal更新: ' + phase0Result.goal);
        }

        // Goal履歴をDB保存
        if (sessionId) {
            try {
                await SupabaseClient.saveGoalHistory(sessionId, turnNumber, {
                    goal: phase0Result.goal,
                    goalUpdated: phase0Result.goalUpdated || false,
                    updateReason: phase0Result.updateReason || '',
                    tasks: phase0Result.tasks,
                    asIs: phase0Result.asIs,
                    gap: phase0Result.gap,
                    assumptions: phase0Result.assumptions,
                });
            } catch (e) { console.warn('[Pipeline] Goal保存失敗:', e.message); }
        }

        // === Phase 1: 並列FB収集 ===
        console.log('[Pipeline v4] Phase1: 並列FB収集');
        const layer3 = RulesLoader.getCore();
        const phase1Prompts = PerspectivePrompts.buildAll(
            phase0Result, layer3, personality, progressSummary, userMessage
        );
        const phase1Results = await runPhase1Parallel(phase1Prompts, signal);

        // === Phase 2: コード統合 ===
        console.log('[Pipeline v4] Phase2: コード統合');
        const synthesisResult = SynthesisCrew.synthesize(phase0Result, phase1Results);

        // パーソナリティdiffマージ
        const existingContext = await loadUserContext();
        const personalityUpdates = SynthesisCrew.mergePersonality(
            synthesisResult.personalityAnalysis, existingContext
        );
        if (personalityUpdates) {
            try {
                await SupabaseClient.upsertUserContext(personalityUpdates);
            } catch (e) { console.warn('[Pipeline] パーソナリティ保存失敗:', e.message); }
        }

        // セッション進捗をDB保存
        if (sessionId) {
            try {
                await SupabaseClient.saveSessionProgress(sessionId, turnNumber, {
                    resolvedItems: synthesisResult.resolvedItems,
                    accumulatedFacts: synthesisResult.accumulatedFacts,
                    synthesisResult: synthesisResult.aspectData,
                });
            } catch (e) { console.warn('[Pipeline] 進捗保存失敗:', e.message); }
        }

        addLog(2, 'Phase2 — コード統合', [], synthesisResult, {});

        // === Phase 3: 最終構造化 ===
        console.log('[Pipeline v4] Phase3: 最終構造化');
        const phase3Result = await runPhase3(
            phase0Result, synthesisResult, userMessage, layer3, signal, conversationHistory
        );

        const finalResult = buildFinalResult(phase0Result, synthesisResult, phase3Result);
        finalResult._processLog = getProcessLog();

        console.log('[Pipeline v4] === チャット完了 ===');
        return finalResult;
    }

    // ===================================================
    // Phase1: 並列APIコール実行
    // ===================================================
    async function runPhase1Parallel(prompts, signal) {
        console.log(`[Pipeline v4] Phase1順次実行: ${prompts.length}件`);

        // Vercel Edge Function タイムアウト回避のため順次実行
        const results = [];
        for (const p of prompts) {
            try {
                const raw = await callAPI(p.messages, signal, { jsonMode: false, maxTokens: 1500 });
                const usage = raw._usage || {}; delete raw._usage;
                const responseText = raw._text || (typeof raw === 'string' ? raw : JSON.stringify(raw));
                addLog(
                    10 + results.length,
                    `Phase1 — ${p.name}`,
                    p.messages, { summary: responseText.substring(0, 200) }, usage
                );
                results.push({
                    type: p.type,
                    id: p.id,
                    name: p.name,
                    response: responseText,
                });
            } catch (e) {
                console.warn(`[Phase1] ${p.name}失敗:`, e.message);
                results.push({ type: p.type, id: p.id, name: p.name, response: null });
            }
        }

        return results;
    }

    // ===================================================
    // Phase3: 最終構造化
    // ===================================================
    async function runPhase3(phase0Result, synthesisResult, userMessage, layer3, signal, conversationHistory) {
        // Phase2の統合結果を元に、5観点の構造化FBを生成
        const aspectSummary = Object.entries(synthesisResult.aspectData)
            .map(([key, data]) => {
                return `### ${key} (status: ${data.status})
テキスト: ${data.texts.join('\n').substring(0, 500)}
元タスク: ${data.sources.join(', ')}`;
            }).join('\n\n');

        // 会話履歴セクション（あれば）
        let conversationSection = '';
        if (conversationHistory && conversationHistory.length > 0) {
            const recentHistory = conversationHistory.slice(-6).map(h =>
                `[${h.role}] ${(h.content || '').substring(0, 200)}`
            ).join('\n');
            conversationSection = `
## 直近の会話履歴
${recentHistory}
`;
        }

        const phase3Prompt = `## プロダクト方向性
${layer3}

## タスク: 最終構造化

以下の分析素材を基に、ユーザーへのフィードバックを構造化せよ。
**分析は完了済。あなたの仕事は素材を整形し、わかりやすく伝えること。**

## Goal
${phase0Result.goal}
${conversationSection}
## 分析素材（Phase2統合結果）
${aspectSummary}

## JSON出力
{
  "aspectUpdates": {
    "<aspect_key>": {
      "status": "ok|thin|empty",
      "text": "蓄積事実+推論+残存課題",
      "quoted": "ユーザー原文の引用",
      "reason": "引用参照→充足分析→不足分析→判定結論",
      "advice": "具体的アクション→対象特定→思考誘発",
      "example": "状況設定→記述例→思考の呼び水"
    }
  },
  "message": "フィードバック（共感→質問、300文字以内）",
  "nextAspect": "次に深掘りすべき観点キー or null"
}`;

        const messages = [
            { role: 'system', content: phase3Prompt },
            { role: 'user', content: userMessage },
        ];

        const result = await callAPI(messages, signal);
        const usage = result._usage; delete result._usage;
        addLog(20, 'Phase3 — 最終構造化', messages, result, usage);

        return result;
    }

    // ===================================================
    // 最終結果の組み立て（レガシーUI互換）
    // ===================================================
    function buildFinalResult(phase0Result, synthesisResult, phase3Result) {
        // Phase3のaspectUpdatesを使う
        const result = {
            aspectUpdates: phase3Result.aspectUpdates || {},
            message: phase3Result.message || '',
            nextAspect: phase3Result.nextAspect || null,
            thinking: phase3Result.thinking || `Goal: ${phase0Result.goal}\nタスク: ${(phase0Result.tasks || []).map(t => t.name).join(', ')}`,
            // レガシーUI互換: これらがないとapp.jsでエラー
            contamination: { detected: false, items: [] },
            crossCheck: { redundancy: { detected: false, pairs: [] }, logicChain: { connected: true } },
            // v4追加情報
            _v4: {
                goal: phase0Result.goal,
                tasks: phase0Result.tasks,
                taskStatus: synthesisResult.taskStatus,
                resolvedItems: synthesisResult.resolvedItems,
            },
        };

        // aspectUpdate（単一観点のセッション用互換）
        if (phase3Result.aspectUpdate) {
            result.aspectUpdate = phase3Result.aspectUpdate;
        }

        return result;
    }

    // ===================================================
    // Layer読込ヘルパー
    // ===================================================
    async function loadPersonality() {
        try {
            const ctx = await SupabaseClient.getUserContext();
            return ctx?.raw_personality || null;
        } catch (e) {
            console.warn('[Pipeline] パーソナリティ読込失敗:', e.message);
            return null;
        }
    }

    async function loadUserContext() {
        try {
            return await SupabaseClient.getUserContext();
        } catch (e) {
            console.warn('[Pipeline] UserContext読込失敗:', e.message);
            return null;
        }
    }

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
