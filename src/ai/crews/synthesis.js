/* ===================================================
   Crew: Phase2 — コード統合 + パーソナリティdiffマージ
   責務:
   1. Phase1の各タスクFBを5観点にマッピング
   2. パーソナリティ分析メタタスクの結果をdiffマージ
   3. session_progressとuser_contextの更新データ生成

   ※ APIコールなし — 全てコードロジック
   =================================================== */

const SynthesisCrew = (() => {
    'use strict';

    // 5観点定義
    const ASPECT_KEYS = ['background', 'problem', 'target', 'impact', 'urgency'];

    // 観点マッピングのキーワード（タスク名/why/doneWhenから推定）
    const ASPECT_KEYWORDS = {
        background: ['背景', '前提', '経緯', '環境', 'as-is', '現状', 'context', '状況'],
        problem: ['課題', '困り', '問題', '非効率', '無駄', '障害', 'ペイン', '苦し', 'しんどい'],
        target: ['対象', 'ターゲット', 'ユーザー', 'ペルソナ', '利用者', '顧客', '誰が'],
        impact: ['効果', 'インパクト', 'before/after', '改善', '成果', 'KPI', '定量', 'メリット'],
        urgency: ['なぜ今', '緊急', 'タイミング', '期限', 'deadline', '急ぐ', '競合'],
    };

    /**
     * Phase1の結果を統合して5観点にマッピングする
     * @param {Object} phase0Result - Phase0の結果 { goal, tasks, asIs, gap, ... }
     * @param {Array} phase1Results - Phase1の各タスクの結果 [ { type, id, name, response } ]
     * @returns {Object} { aspectData, resolvedItems, accumulatedFacts }
     */
    function synthesize(phase0Result, phase1Results) {
        console.log('[SynthesisCrew] === Phase2 統合開始 ===');

        // 通常タスクとメタタスクを分離
        const taskResults = phase1Results.filter(r => r.type === 'task');
        const metaResult = phase1Results.find(r => r.type === 'meta');

        console.log(`[SynthesisCrew] タスクFB: ${taskResults.length}件, メタタスク: ${metaResult ? 'あり' : 'なし'}`);

        // 1. 各タスクの完了条件チェック
        const taskStatus = evaluateTaskCompletion(phase0Result.tasks, taskResults);

        // 2. タスク→観点マッピング
        const aspectData = mapTasksToAspects(phase0Result.tasks, taskResults, taskStatus);

        // 3. 解決済み項目・蓄積事実の整理
        const resolvedItems = taskStatus.filter(t => t.status === 'done').map(t => t.name);
        const accumulatedFacts = extractFacts(taskResults);

        console.log(`[SynthesisCrew] 解決済み: ${resolvedItems.length}件, 蓄積事実: ${accumulatedFacts.length}件`);
        console.log(`[SynthesisCrew] 観点マッピング完了:`, Object.keys(aspectData).map(k => `${k}=${aspectData[k].status}`).join(', '));

        return {
            aspectData,
            resolvedItems,
            accumulatedFacts,
            taskStatus,
            personalityAnalysis: metaResult?.response || null,
        };
    }

    /**
     * タスクの完了条件 vs Phase1テキストを照合
     */
    function evaluateTaskCompletion(tasks, taskResults) {
        return (tasks || []).map(task => {
            const result = taskResults.find(r => r.id === task.id);
            if (!result || !result.response) {
                return { ...task, status: 'pending', completionNote: 'Phase1のレスポンスなし' };
            }

            const text = typeof result.response === 'string'
                ? result.response
                : JSON.stringify(result.response);

            // テキスト長と doneWhen のキーワード出現をヒューリスティックにチェック
            const doneWhenWords = (task.doneWhen || '').split(/[、。\s,\.]+/).filter(w => w.length > 2);
            const matchCount = doneWhenWords.filter(w => text.includes(w)).length;
            const matchRatio = doneWhenWords.length > 0 ? matchCount / doneWhenWords.length : 0;

            let status;
            if (text.length > 200 && matchRatio > 0.3) {
                status = 'done';
            } else if (text.length > 50) {
                status = 'partial';
            } else {
                status = 'pending';
            }

            return {
                ...task,
                status,
                completionNote: `テキスト長=${text.length}, doneWhenマッチ=${Math.round(matchRatio * 100)}%`,
            };
        });
    }

    /**
     * タスクFBを5観点にマッピング
     */
    function mapTasksToAspects(tasks, taskResults, taskStatus) {
        const aspectData = {};

        for (const key of ASPECT_KEYS) {
            aspectData[key] = {
                status: 'empty',
                texts: [],       // マッピングされたテキスト群
                sources: [],     // どのタスクから来たか
                sufficient: [],  // 充足している情報
                missing: [],     // 不足している情報
            };
        }

        // 各タスクをキーワードベースで観点にマッピング
        for (const task of (tasks || [])) {
            const result = taskResults.find(r => r.id === task.id);
            if (!result?.response) continue;

            const text = typeof result.response === 'string'
                ? result.response
                : JSON.stringify(result.response);

            const matchedAspects = findMatchingAspects(task);

            // マッチした観点にテキストを追加
            if (matchedAspects.length === 0) {
                // マッチしない場合は最も近い観点にfallback
                const closest = findClosestAspect(text);
                aspectData[closest].texts.push(text);
                aspectData[closest].sources.push(task.name);
            } else {
                for (const aspect of matchedAspects) {
                    aspectData[aspect].texts.push(text);
                    aspectData[aspect].sources.push(task.name);
                }
            }
        }

        // 各観点のstatus判定
        for (const key of ASPECT_KEYS) {
            const d = aspectData[key];
            const totalText = d.texts.join('\n');
            if (totalText.length === 0) {
                d.status = 'empty';
            } else if (totalText.length < 100) {
                d.status = 'thin';
            } else {
                // テキストの具体性をヒューリスティックにチェック
                const hasConcreteDetail = /\d|具体|例えば|実際|月|件|回|人|名/.test(totalText);
                d.status = hasConcreteDetail ? 'ok' : 'thin';
            }
        }

        return aspectData;
    }

    /**
     * タスクの name/why/doneWhen からマッチする観点を特定
     */
    function findMatchingAspects(task) {
        const searchText = `${task.name || ''} ${task.why || ''} ${task.doneWhen || ''}`;
        const matched = [];
        for (const [aspect, keywords] of Object.entries(ASPECT_KEYWORDS)) {
            if (keywords.some(kw => searchText.includes(kw))) {
                matched.push(aspect);
            }
        }
        return matched;
    }

    /**
     * テキスト内容から最も近い観点を推定
     */
    function findClosestAspect(text) {
        let best = 'background';
        let bestScore = 0;
        for (const [aspect, keywords] of Object.entries(ASPECT_KEYWORDS)) {
            const score = keywords.filter(kw => text.includes(kw)).length;
            if (score > bestScore) {
                bestScore = score;
                best = aspect;
            }
        }
        return best;
    }

    /**
     * タスクFBから事実を抽出
     */
    function extractFacts(taskResults) {
        const facts = [];
        for (const result of taskResults) {
            if (!result?.response) continue;
            const text = typeof result.response === 'string'
                ? result.response
                : JSON.stringify(result.response);
            // 短い文に分割し、事実らしいものを抽出（ヒューリスティック）
            const sentences = text.split(/[。\n]/).filter(s => s.trim().length > 10 && s.trim().length < 200);
            facts.push(...sentences.slice(0, 5).map(s => s.trim()));
        }
        return facts;
    }

    // ===================================================
    // パーソナリティ diff マージ
    // ===================================================

    /**
     * Phase1メタタスクの分析結果と既存user_contextをdiffマージ
     * @param {string|null} metaAnalysis - Phase1メタタスクの自由テキスト
     * @param {Object|null} existingContext - 既存のuser_context
     * @returns {Object} 更新用のuser_contextフィールド
     */
    function mergePersonality(metaAnalysis, existingContext) {
        console.log('[SynthesisCrew] パーソナリティdiffマージ');

        if (!metaAnalysis) {
            console.log('[SynthesisCrew] メタタスク結果なし、スキップ');
            return null;
        }

        const existing = existingContext || {};
        const updates = {};

        // 1. raw_personality の累積更新
        const existingRaw = existing.raw_personality || '';
        if (!existingRaw.trim()) {
            // 初回: メタタスクの結果をそのまま使う（ただし長さ制限）
            updates.raw_personality = truncateText(metaAnalysis, 1500);
        } else {
            // 2回目以降: 既存テキスト + 今回の新情報を追記
            const newInsight = extractNewInsights(metaAnalysis, existingRaw);
            if (newInsight) {
                updates.raw_personality = truncateText(
                    existingRaw + '\n\n[' + new Date().toISOString().split('T')[0] + ' 更新]\n' + newInsight,
                    2000
                );
            }
        }

        // 2. thinking_patterns の更新
        const patterns = existing.thinking_patterns || {};
        const entryPointMatch = metaAnalysis.match(/(?:思考の入口|How|Why|What)[\s\S]{0,200}/i);
        if (entryPointMatch) {
            const newEntry = extractPatternFromText(entryPointMatch[0]);
            if (newEntry && (!patterns.entry_point || newEntry !== patterns.entry_point)) {
                patterns.entry_point = newEntry;
            }
        }

        const effectiveMatch = metaAnalysis.match(/(?:効果的|響き|有効)[\s\S]{0,200}/i);
        if (effectiveMatch) {
            const approach = extractPatternFromText(effectiveMatch[0]);
            if (approach) patterns.effective_approach = approach;
        }

        if (Object.keys(patterns).length > 0) {
            updates.thinking_patterns = patterns;
        }

        // 3. recurring_concerns の更新
        const concerns = existing.recurring_concerns || [];
        const concernPatterns = metaAnalysis.match(/(?:繰り返し|繰返し|パターン|傾向)[\s\S]{0,200}/i);
        if (concernPatterns) {
            const newConcern = extractPatternFromText(concernPatterns[0]);
            if (newConcern && !concerns.some(c => c.theme === newConcern)) {
                concerns.push({
                    theme: newConcern,
                    frequency: 1,
                    first_seen: new Date().toISOString().split('T')[0],
                });
                updates.recurring_concerns = concerns;
            }
        }

        // 4. growth_log: 変化の検出
        const growthLog = existing.growth_log || [];
        const changeMatch = metaAnalysis.match(/(?:変化|成長|改善|できるようになった|進歩)[\s\S]{0,200}/i);
        if (changeMatch) {
            const observation = extractPatternFromText(changeMatch[0]);
            if (observation) {
                growthLog.push({
                    date: new Date().toISOString().split('T')[0],
                    observation: observation,
                });
                updates.growth_log = growthLog;
            }
        }

        console.log('[SynthesisCrew] パーソナリティ更新フィールド: ' + Object.keys(updates).join(', '));
        return Object.keys(updates).length > 0 ? updates : null;
    }

    /**
     * 既存テキストにない新しい洞察を抽出
     */
    function extractNewInsights(newText, existingText) {
        const newSentences = newText.split(/[。\n]/).filter(s => s.trim().length > 15);
        const existingLower = existingText.toLowerCase();

        const novelSentences = newSentences.filter(s => {
            // 既存テキストに含まれていない文を「新情報」とする
            const keywords = s.trim().split(/\s+/).filter(w => w.length > 3);
            const overlapCount = keywords.filter(w => existingLower.includes(w.toLowerCase())).length;
            return keywords.length > 0 && (overlapCount / keywords.length) < 0.5;
        });

        return novelSentences.slice(0, 5).join('。') || null;
    }

    /**
     * テキストからパターン文字列を抽出（200文字以内の要約）
     */
    function extractPatternFromText(text) {
        const cleaned = text.replace(/[\n\r]+/g, ' ').trim();
        return cleaned.length > 200 ? cleaned.substring(0, 200) + '…' : cleaned;
    }

    /**
     * テキストを指定長で切り詰め
     */
    function truncateText(text, maxLen) {
        return text.length > maxLen ? text.substring(0, maxLen) + '\n…(以降省略)' : text;
    }

    /**
     * Layer1用のセッション進捗サマリを生成
     * @param {Object} synthesisResult - synthesize()の結果
     * @returns {string} プロンプト注入用のテキスト
     */
    function buildProgressSummary(synthesisResult) {
        if (!synthesisResult) return '';

        let summary = '';

        if (synthesisResult.resolvedItems?.length > 0) {
            summary += '## 解決済み\n';
            synthesisResult.resolvedItems.forEach(item => {
                summary += `- ${item}\n`;
            });
        }

        if (synthesisResult.accumulatedFacts?.length > 0) {
            summary += '\n## 蓄積された事実\n';
            synthesisResult.accumulatedFacts.forEach(fact => {
                summary += `- ${fact}\n`;
            });
        }

        return summary;
    }

    return { synthesize, mergePersonality, buildProgressSummary };
})();
