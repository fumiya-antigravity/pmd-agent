/* ===================================================
   パイプライン v3: Crewオーケストレーション型
   
   設計思想:
   - 各Crewがプロンプト組立と結果パースを担当
   - pipeline.jsはCrewの呼出し順序と結果統合のみを管理
   - API呼出し回数は旧版と同じ（1-2回）
   - プロンプトの重複を完全排除（RulesLoader/Promptモジュール経由）
   - 判定は全てAIに委ねる。コードレベルでのstatus上書きは行わない
   - 全API通信のリクエスト/レスポンスをプロセスログとして記録
   =================================================== */

const AIApi = (() => {
    'use strict';

    const API_URL = 'http://localhost:8888/api/chat';

    // ===================================================
    // プロセスログ管理
    // ===================================================
    let _processLog = [];

    function clearProcessLog() { _processLog = []; }
    function getProcessLog() { return _processLog; }

    function addLog(step, label, messages, response, usage) {
        // 循環参照防止: responseから内部プロパティ(_processLog, _usage)を除外してコピー
        let safeResponse = {};
        try {
            const { _processLog: _pl, _usage: _u, ...rest } = response || {};
            safeResponse = JSON.parse(JSON.stringify(rest));
        } catch (e) {
            safeResponse = { _error: 'シリアライズ失敗: ' + e.message };
        }
        _processLog.push({
            step,
            label,
            timestamp: new Date().toLocaleTimeString('ja-JP'),
            request: {
                messageCount: messages.length,
                systemPrompt: messages.find(m => m.role === 'system')?.content || '',
                userMessage: messages.find(m => m.role === 'user')?.content || '',
                historyCount: messages.filter(m => m.role !== 'system' && m.role !== 'user').length,
            },
            response: safeResponse,
            usage: usage || {},
        });
    }

    // ===================================================
    // PHASE_CHECK: 観点チェック用プロンプト（このフェーズは単純なので直書き維持）
    // ===================================================
    const PHASE_CHECK = `## タスク: 観点チェック
全観点の網羅性と品質を診断せよ。

## JSON出力
{
  "thinking": "各観点の評価詳細",
  "aspectResults": {
    "[観点キー]": {"status": "ok|thin|empty", "feedback": "評価コメント"}
  },
  "suggestedAspects": [{"key": "英語キー", "label": "日本語名", "emoji": "絵文字", "reason": "提案理由"}],
  "allApproved": true|false,
  "message": "総合フィードバック（400文字以内）"
}`;

    // ===================================================
    // API呼出し（共通基盤）
    // ===================================================
    async function callAPI(messages, signal) {
        console.log('[callAPI] リクエスト送信: messages=', messages.length, '件');
        const resp = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages }),
            signal,
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: 'Unknown error' }));
            console.error('[callAPI] HTTPエラー:', resp.status, err);
            throw new Error(err.detail || err.error || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        const reply = data.reply;
        console.log('[callAPI] token使用量:', JSON.stringify(data.usage || {}));

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
                    console.warn('[callAPI] JSONパース失敗、フォールバック');
                    return { _parsed: { message: reply, thinking: null }, _usage: data.usage || {} };
                }
            }
        }

        // デバッグログ
        console.log('[callAPI] === AI応答構造 ===');
        console.log('[callAPI] キー:', Object.keys(parsed));
        if (parsed.aspectUpdates) {
            console.log('[callAPI] aspectUpdates:');
            for (const [k, v] of Object.entries(parsed.aspectUpdates)) {
                console.log(`  ${k}: status=${v.status}, text="${(v.text || '').substring(0, 50)}"`);
            }
        }
        if (parsed.aspectUpdate) {
            console.log(`[callAPI] aspectUpdate: aspect=${parsed.aspectUpdate.aspect}, status=${parsed.aspectUpdate.status}`);
        }
        if (parsed.crossCheck) {
            console.log('[callAPI] crossCheck:', JSON.stringify(parsed.crossCheck));
        }
        if (parsed.contamination?.detected) {
            console.log('[callAPI] contamination:', JSON.stringify(parsed.contamination.items));
        }
        console.log('[callAPI] message:', (parsed.message || '').substring(0, 100));
        console.log('[callAPI] nextAspect:', parsed.nextAspect || 'null');

        // usageを一緒に返す（addLog用）
        parsed._usage = data.usage || {};
        return parsed;
    }

    // ===================================================
    // パイプライン: 初回分析（API 1回 + バリデーション1回）
    // ===================================================
    async function analyzeInitialInput(overview, whyText, signal) {
        console.log('[Pipeline] === 初回分析開始 ===');
        clearProcessLog();

        // ① AnalysisCrewがプロンプトを組立て → 1回のAPI呼出し
        const messages = AnalysisCrew.buildInitialMessages(overview, whyText);
        const result = await callAPI(messages, signal);
        const usage1 = result._usage; delete result._usage;
        addLog(1, 'AnalysisCrew — 初回分析', messages, result, usage1);
        console.log('[Pipeline] ① AnalysisCrew完了（API 1回目）');

        // ② AnalysisCrewが結果をパース・検証
        AnalysisCrew.parseResult(result);

        // ③ ok判定が1つ以上 OR FB品質違反あり → 2回目バリデーション（AIセカンドオピニオン）
        const okAspects = result.aspectUpdates
            ? Object.entries(result.aspectUpdates).filter(([, v]) => v.status === 'ok')
            : [];
        const hasFBViolations = result._fbViolations && result._fbViolations.length > 0;

        if (okAspects.length > 0 || hasFBViolations) {
            const triggerReason = hasFBViolations ? `FB品質違反${result._fbViolations.length}件` : `ok判定${okAspects.length}件`;
            console.log('[Pipeline] ③ 2回目バリデーション: ' + triggerReason + 'を再評価');
            try {
                const valPrompt = OrchestratorCrew.buildValidationPrompt();

                // 違反情報をプロンプトに追加
                let violationSection = '';
                if (hasFBViolations) {
                    violationSection = '\n\n## ⚠️ コードレベル品質違反（必ず修正せよ）\n';
                    for (const av of result._fbViolations) {
                        violationSection += `\n### ${av.aspect}:\n`;
                        for (const v of av.violations) {
                            violationSection += `- **${v.type}** [${v.field}]: ${v.detail}\n`;
                        }
                    }
                    violationSection += '\n上記の違反がある観点は、修正後のreason/advice/exampleをrevisionsに含めよ。\n';
                }

                const valMessages = [
                    { role: 'system', content: valPrompt },
                    {
                        role: 'user', content: '## ユーザー原文\n## 概要\n' + overview + '\n\n## Why\n' + whyText
                            + '\n\n## 1回目AIの判定結果\n' + JSON.stringify(result.aspectUpdates, null, 2) + violationSection
                    },
                ];
                const valResult = await callAPI(valMessages, signal);
                const usage2 = valResult._usage; delete valResult._usage;
                const label = hasFBViolations ? 'OrchestratorCrew — FB品質補正' : 'OrchestratorCrew — AIセカンドオピニオン';
                addLog(2, label, valMessages, valResult, usage2);

                console.log('[Pipeline] 2回目バリデーション結果:', JSON.stringify(valResult));
                OrchestratorCrew.applyValidation(result, valResult);
            } catch (e) {
                console.warn('[Pipeline] 2回目バリデーション失敗（1回目結果を使用）:', e.message);
            }
        }

        // ④ relatedUpdatesフィルタリング
        result.relatedUpdates = OrchestratorCrew.filterRelatedUpdates(result.relatedUpdates);

        // 最終結果ログ
        if (result.aspectUpdates) {
            console.log('[Pipeline] === 初回分析最終結果 ===');
            for (const [k, v] of Object.entries(result.aspectUpdates)) {
                console.log('  ' + k + ': status=' + v.status);
            }
        }

        // プロセスログを結果に付与（UI表示用）
        result._processLog = getProcessLog();

        console.log('[Pipeline] === 初回分析完了 ===');
        return result;
    }

    // ===================================================
    // パイプライン: 壁打ちチャット（API 1回 + 条件付き検証1回）
    // ===================================================
    async function chat(userMessage, context, signal) {
        console.log('[Pipeline] === チャット開始 ===');
        clearProcessLog();

        // ① AnalysisCrewがプロンプト組立て → 1回のAPI呼出し
        const messages = AnalysisCrew.buildSessionMessages(userMessage, context);
        const result = await callAPI(messages, signal);
        const usage1 = result._usage; delete result._usage;
        addLog(1, 'AnalysisCrew — 壁打ち分析', messages, result, usage1);
        console.log('[Pipeline] ① AnalysisCrew完了（API 1回目）');

        // ② AnalysisCrewが結果をパース
        AnalysisCrew.parseResult(result);

        // ③ VerifyCrew: thin判定時 または FB品質違反時に検証（API 2回目）
        const hasFBViolations = result._fbViolations && result._fbViolations.length > 0;
        const verifyMessages = VerifyCrew.buildMessages(result, userMessage, hasFBViolations);
        if (verifyMessages) {
            try {
                const verifyResult = await callAPI(verifyMessages, signal);
                const usage2 = verifyResult._usage; delete verifyResult._usage;
                const label = hasFBViolations ? 'VerifyCrew — FB品質補正' : 'VerifyCrew — thin検証';
                addLog(2, label, verifyMessages, verifyResult, usage2);
                VerifyCrew.merge(result, verifyResult);
                console.log(`[Pipeline] ③ ${label}完了（API 2回目）`);
            } catch (e) {
                console.warn('[Pipeline] VerifyCrew失敗、スキップ:', e.message);
            }
        }

        // ④ relatedUpdatesフィルタリング
        result.relatedUpdates = OrchestratorCrew.filterRelatedUpdates(result.relatedUpdates);

        // プロセスログを結果に付与（UI表示用）
        result._processLog = getProcessLog();

        console.log('[Pipeline] === チャット完了 ===');
        return result;
    }

    // ===================================================
    // パイプライン: 観点チェック（API 1回）
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
