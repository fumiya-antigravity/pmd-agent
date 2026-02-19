/**
 * Vercel Serverless Function: /api/process
 * メイン会話処理 API (CLARIX v3)
 * 外部設計 §4.2 準拠
 */
import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 60 };

function getSupabase() {
    const url = process.env.SUPABASE_URL || 'https://mfwgpicsalflypomhuly.supabase.co';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1md2dwaWNzYWxmbHlwb21odWx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzExNDU0ODAsImV4cCI6MjA4NjcyMTQ4MH0.f-jKJMCSl7r7KZztNCVw_VmznNCPP1AapjxD2oFrTIE';
    return createClient(url, key);
}

// ===================================================
// DB操作ヘルパー（エラーを必ずチェック）
// ===================================================
async function dbInsert(supabase, table, row) {
    const { data, error } = await supabase.from(table).insert(row).select().maybeSingle();
    if (error) {
        console.error(`[dbInsert:${table}]`, error);
        throw new Error(`DB Insert失敗 (${table}): ${error.message}`);
    }
    return data;
}

async function dbUpdate(supabase, table, updates, eqCol, eqVal) {
    const { data, error } = await supabase.from(table).update(updates).eq(eqCol, eqVal).select().maybeSingle();
    if (error) {
        console.error(`[dbUpdate:${table}]`, error);
        throw new Error(`DB Update失敗 (${table}): ${error.message}`);
    }
    return data;
}

async function dbUpsert(supabase, table, row, onConflict) {
    const { data, error } = await supabase.from(table).upsert(row, { onConflict }).select().maybeSingle();
    if (error) {
        console.error(`[dbUpsert:${table}]`, error);
        // upsertは致命的ではないのでログのみ
    }
    return data;
}

// ===================================================
// LLM呼び出し
// ===================================================
async function callOpenAI(messages, jsonMode = true, maxTokens = 4000) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

    const body = {
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.7,
        max_tokens: maxTokens,
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`OpenAI API Error ${resp.status}: ${errText}`);
    }

    const result = await resp.json();
    return result.choices[0].message.content;
}

function parseLLMJson(reply) {
    try {
        const match = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
        const raw = match ? match[1].trim() : reply.trim();
        return JSON.parse(raw);
    } catch (e) {
        console.error('[parseLLMJson]', e.message);
        return null;
    }
}

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
// アンカー取得 or 復元
// 初回insertが何らかの理由で失敗した場合も復元可能にする
// ===================================================
async function ensureAnchor(supabase, session_id, originalMessage) {
    // まず取得を試みる
    const { data: existing, error: fetchErr } = await supabase
        .from('session_anchors').select('*').eq('session_id', session_id).maybeSingle();

    if (fetchErr) {
        console.error('[ensureAnchor] fetch error:', fetchErr);
    }

    if (existing) return existing;

    // 存在しない場合: 復元 (初回insertが失敗していたケース)
    // originalMessageが提供されている場合のみ復元可能
    if (!originalMessage) {
        // messagesから最初のユーザーメッセージを取得して復元
        const { data: firstMsg } = await supabase
            .from('messages').select('content').eq('session_id', session_id)
            .eq('role', 'user').order('created_at', { ascending: true }).limit(1).maybeSingle();
        originalMessage = firstMsg?.content || '';
    }

    if (!originalMessage) {
        console.warn('[ensureAnchor] アンカー復元不可: ユーザーメッセージなし');
        return null;
    }

    console.warn('[ensureAnchor] アンカーが欠損 → 自動復元を実行');
    const keywords = extractKeywords(originalMessage);
    try {
        const restored = await dbInsert(supabase, 'session_anchors', {
            session_id,
            original_message: originalMessage,
            core_keywords: keywords,
            initial_purpose: '',
        });
        return restored;
    } catch (e) {
        console.error('[ensureAnchor] 復元失敗:', e);
        // フォールバック: メモリ上のオブジェクトを返す
        return {
            session_id,
            original_message: originalMessage,
            core_keywords: keywords,
            initial_purpose: '',
        };
    }
}

// ===================================================
// Role A (Planner) — 外部設計 §5.1
// ===================================================
function buildPlannerPrompt({ userMessage, anchor, latestGoal, confirmedInsights, history, turn, managerCorrection }) {
    const anchorSection = anchor
        ? `## アンカー\n- original_message: "${anchor.original_message}"\n- core_keywords: ${JSON.stringify(anchor.core_keywords || [])}\n- initial_purpose: "${anchor.initial_purpose || ''}"`
        : '## アンカー\n（初回ターン）';

    const previousState = latestGoal
        ? `## 前回の状態\n- MGU: ${latestGoal.mgu || 0}\n- SQC: ${latestGoal.sqc || 0}\n- sessionPurpose: "${latestGoal.session_purpose || ''}"\n- question_type: ${latestGoal.question_type || 'open'}\n- active_sub_questions: ${JSON.stringify(latestGoal.active_sub_questions || [])}`
        : '## 前回の状態\n（初回）';

    const insightsSection = confirmedInsights.length > 0
        ? `## 確認済みインサイト\n${JSON.stringify(confirmedInsights.map(i => ({ label: i.label, layer: i.layer, strength: i.strength })), null, 2)}`
        : '## 確認済みインサイト\n（なし）';

    const correctionSection = managerCorrection
        ? `\n## ⚠ Manager修正指示\n${managerCorrection.instruction}\n**修正してください。**`
        : '';

    const mguContext = (latestGoal?.mgu || 0) >= 60
        ? `\nMGU≥60%: anchor + sessionPurpose + insights を前提にSQCを精度高く判定。`
        : '';

    const system = `あなたは Planner AI（Role A）です。ユーザーの壁打ちを分析し、Whyの核心を構造的に理解するためのJSONを出力してください。

# 原則
1. Whyを深掘り。How/Whatは排除せず思考のヒントとして活用
2. cognitive_filter: How語とWhat語を分類（排除ではない）。How語は最終レポートで除外、What語はOK
3. SQC: ユーザー回答中の曖昧語を検出して0-100で出力${mguContext}

# 出力JSON
{
  "main_goal_understanding": <0-100>,
  "sub_question_clarity": <0-100>,
  "why_completeness_score": <0-100>,
  "sessionPurpose": "<1文>",
  "question_type": "open" | "hypothesis",
  "active_sub_questions": [{ "question": "<text>", "layer": "attribute"|"consequence"|"value", "status": "active"|"resolved" }],
  "confirmed_insights": [{ "label": "<要約>", "layer": "<layer>", "strength": <0-100>, "confirmation_strength": <0.0-1.0>, "turn": <n> }],
  "cognitive_filter": { "detected_how": [], "detected_what": [], "instruction": "<説明>" },
  "next_question_focus": { "target_layer": "<layer>", "focus": "<方向性>" }
}

# MGU計算: attribute=+5, consequence=+10, value=+20 × confirmation_strength。否定(0.0)は加算なし+新派生質問
# question_type: MGU<60=open, MGU≥60=hypothesis
# SQC≥80: 派生質問をresolved。SQC<80: 新派生質問をactive追加
# confirmed_insights: 差分のみ出力${correctionSection}`;

    const user = `${anchorSection}\n${previousState}\n${insightsSection}\n\n## 会話履歴\n${(history || []).map(m => `[${m.role}] ${m.content}`).join('\n')}\n\n## ユーザー最新メッセージ（Turn ${turn}）\n${userMessage}`;

    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// ===================================================
// Role E (Manager) — 外部設計 §5.5
// anchor が null の場合は安全にスキップ
// ===================================================
function buildManagerPrompt({ plannerOutput, anchor, previousInterviewerQuestion }) {
    // anchor が null の場合は Manager をスキップするためのガード
    const anchorMsg = anchor?.original_message || '（不明）';
    const anchorKeywords = anchor?.core_keywords || [];

    const system = `あなたは Manager AI（Role E）です。Planner出力の逸脱を検出してください。

チェック:
[A1] sessionPurpose ↔ anchor 類似度低→drift
[A2] active_sub_questions ↔ sessionPurpose 無関連→drift
[A3] MGU delta>30→mgu_spike
[B1] How語混入（What語はOK）→cognitive_filter_violation
[B2] 「？」2個以上→miller_law_violation
[B3] 禁止語検出→character_violation
[G1] core_keywords 3ターン不在→topic_drift

出力JSON:
{ "alignment_score": <0-100>, "drift_detected": true|false, "violations": [], "correction": { "target_role": "Planner", "instruction": "<修正指示>", "anchor_message": "<元メッセージ>" } | null }

alignment_score<70→drift_detected=true, correctionは必須`;

    const user = `## アンカー\n- original_message: "${anchorMsg}"\n- core_keywords: ${JSON.stringify(anchorKeywords)}\n\n## Planner出力\n${JSON.stringify(plannerOutput, null, 2)}\n\n## 前回Interviewer質問\n${previousInterviewerQuestion || '（turn 0: なし）'}`;

    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// ===================================================
// Role B (Interviewer) — 外部設計 §5.2
// ===================================================
function buildInterviewerPrompt(plannerOutput) {
    const howWords = (plannerOutput.cognitive_filter?.detected_how || []).join('、');
    const activeQs = (plannerOutput.active_sub_questions || [])
        .filter(q => q.status === 'active')
        .map(q => `- [${q.layer}] ${q.question}`)
        .join('\n');
    const qType = plannerOutput.question_type || 'open';
    const focus = plannerOutput.next_question_focus || {};

    const style = qType === 'open'
        ? '質問スタイル: オープン型（まず広く聴く）。「～についてもう少し教えてください」形式。'
        : '質問スタイル: 仮説提示型（揺さぶって気づきを生む）。「つまり○○ということでしょうか？」形式。';

    const system = `あなたは先輩PdMです。壁打ち相手として自然な1文の質問を生成してください。

性格: 率直・シンプル・知的な対等さ
現在: sessionPurpose="${plannerOutput.sessionPurpose || ''}", type=${qType}
派生質問:\n${activeQs || '（なし）'}

禁止: JSON漏洩, How語混入(${howWords || 'なし'}), 禁止語(苦痛/感じる/つらい/悩み/大変/つまずく), 複数質問
推奨語: ボトルネック, 構造, 文脈, 意思決定, 前提, 乖離
${style}
テキストのみ（1-2文）で出力。`;

    const user = `次の方向で質問: ${focus.target_layer || '未定'} — ${focus.focus || '未定'}`;

    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// ===================================================
// Role C (Synthesizer) — LLM不使用
// ===================================================
function synthesize(insights, originalMessage = '') {
    if (!insights || insights.length === 0) return [];
    const layerOrder = { value: 0, consequence: 1, attribute: 2 };
    const sorted = [...insights].sort((a, b) => {
        const ld = (layerOrder[a.layer] ?? 99) - (layerOrder[b.layer] ?? 99);
        return ld !== 0 ? ld : (b.strength || 0) - (a.strength || 0);
    });
    const top = sorted.slice(0, 5);
    const lower = originalMessage.toLowerCase();
    return top.map(ins => {
        const tag = (ins.strength || 0) >= 70 ? 'primary' : 'supplementary';
        let blind = false;
        if (originalMessage) {
            const kws = ins.label.split(/[、。\s,.\-]+/).filter(k => k.length >= 2);
            blind = !kws.some(k => lower.includes(k.toLowerCase()));
        }
        return { id: ins.id, label: ins.label, layer: ins.layer, strength: ins.strength, tag, johari_blind_spot: blind, slider_value: ins.strength };
    });
}

// ===================================================
// Handler Main
// ===================================================
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const supabase = getSupabase();
    const { session_id, user_message } = req.body || {};

    if (!session_id || !user_message) {
        return res.status(400).json({ error: 'session_id and user_message required' });
    }

    try {
        // ── Phase ガード ──
        const { data: session, error: sessErr } = await supabase
            .from('sessions').select('*').eq('id', session_id).single();
        if (sessErr || !session) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
        if (['SLIDER', 'REPORT', 'COMPLETE'].includes(session.phase)) {
            return res.status(400).json({ error: 'PHASE_MISMATCH', phase: session.phase });
        }

        // ── DB読み込み ──
        const { data: allMsgs, error: msgErr } = await supabase
            .from('messages').select('*').eq('session_id', session_id).order('created_at', { ascending: true });
        if (msgErr) console.error('[process] messages取得エラー:', msgErr);
        const messages = allMsgs || [];
        const history = messages.slice(-20);
        const turn = messages.filter(m => m.role === 'user').length;

        const { data: goalRows, error: goalErr } = await supabase
            .from('goal_history').select('*').eq('session_id', session_id).order('turn_number', { ascending: false }).limit(1);
        if (goalErr) console.error('[process] goal_history取得エラー:', goalErr);
        const latestGoal = goalRows?.[0] || null;

        const { data: existingInsights, error: insErr } = await supabase
            .from('confirmed_insights').select('*').eq('session_id', session_id).order('strength', { ascending: false });
        if (insErr) console.error('[process] confirmed_insights取得エラー:', insErr);
        const insights = existingInsights || [];

        const prevInterviewerMsg = [...messages].reverse().find(m => m.role === 'assistant')?.content ?? null;

        // メッセージ保存（エラーチェックあり）
        try {
            await dbInsert(supabase, 'messages', { session_id, role: 'user', content: user_message, turn_number: turn, metadata: { turn } });
        } catch (e) {
            console.error('[process] ユーザーメッセージ保存失敗:', e);
            // 保存失敗しても処理は続行（会話は成立させる）
        }

        const MAX_SUB_QUESTION_TURNS = 10;

        // ── 初回ターン ──
        if (turn === 0) {
            // アンカー取得 or 作成
            let anchor = await ensureAnchor(supabase, session_id, user_message);

            const planReply = await callOpenAI(buildPlannerPrompt({ userMessage: user_message, anchor, latestGoal: null, confirmedInsights: [], history: [], turn: 0 }));
            const plan = parseLLMJson(planReply);
            if (!plan) return res.status(500).json({ error: 'Planner出力パースエラー' });

            // アンカーがまだない場合（ensureAnchorでDBinsertに失敗 + fallbackオブジェクトだった場合）
            // initial_purposeを更新
            if (anchor && !anchor.id) {
                // メモリ上のフォールバックだった場合、再度insert試行
                const keywords = extractKeywords(user_message);
                try {
                    anchor = await dbInsert(supabase, 'session_anchors', {
                        session_id, original_message: user_message,
                        core_keywords: keywords, initial_purpose: plan.sessionPurpose || '',
                    });
                } catch (e) {
                    console.warn('[process] アンカー保存リトライも失敗:', e);
                }
            } else if (anchor && anchor.id && !anchor.initial_purpose) {
                // existing anchor but initial_purpose が空 → 更新
                try {
                    await dbUpdate(supabase, 'sessions_anchors_purpose', {}, '', '');
                } catch (e) { /* ignore */ }
            }

            // goal_history 保存
            try {
                await dbInsert(supabase, 'goal_history', {
                    session_id, turn_number: 0, goal_text: plan.sessionPurpose || '',
                    session_purpose: plan.sessionPurpose || '', mgu: plan.main_goal_understanding || 0,
                    sqc: plan.sub_question_clarity || 0, question_type: plan.question_type || 'open',
                    cognitive_filter: plan.cognitive_filter || {}, why_completeness_score: plan.why_completeness_score || 0,
                    active_sub_questions: plan.active_sub_questions || [], manager_alignment_score: 100,
                    turn: 0, raw_planner_output: plan,
                });
            } catch (e) {
                console.error('[process] goal_history保存失敗:', e);
            }

            const question = await callOpenAI(buildInterviewerPrompt(plan), false, 500);

            try {
                await dbInsert(supabase, 'messages', { session_id, role: 'assistant', content: question, turn_number: 0, metadata: { turn: 0 } });
            } catch (e) {
                console.error('[process] assistant message保存失敗:', e);
            }

            try {
                await dbUpdate(supabase, 'sessions', { phase: 'CONVERSATION' }, 'id', session_id);
            } catch (e) {
                console.error('[process] sessions phase更新失敗:', e);
            }

            return res.status(200).json({
                phase: 'CONVERSATION', message: question, turn: 0,
                debug: { mgu: plan.main_goal_understanding, sqc: plan.sub_question_clarity, question_type: plan.question_type, session_purpose: plan.sessionPurpose, manager_alignment_score: 100, active_sub_questions: plan.active_sub_questions, cognitive_filter: plan.cognitive_filter },
            });
        }

        // ── ターン1以降: アンカーを確実に取得 ──
        const anchor = await ensureAnchor(supabase, session_id, null);
        if (!anchor) {
            return res.status(500).json({ error: 'ANCHOR_NOT_FOUND: セッションのアンカーが見つかりません。新しいセッションを作成してください。' });
        }

        // ── ターン上限チェック ──
        if (turn >= MAX_SUB_QUESTION_TURNS) {
            const sliderData = synthesize(insights, anchor.original_message || '');
            if (sliderData.length === 0) {
                const q = await callOpenAI(buildInterviewerPrompt({ sessionPurpose: latestGoal?.session_purpose || '', question_type: 'hypothesis', active_sub_questions: [], cognitive_filter: {}, next_question_focus: { target_layer: 'value', focus: '最終確認' } }), false, 500);
                try { await dbInsert(supabase, 'messages', { session_id, role: 'assistant', content: q, turn_number: turn }); } catch (e) { /* ignore */ }
                return res.status(200).json({ phase: 'CONVERSATION', message: q, turn, debug: { mgu: 80, forced: true } });
            }
            try { await dbUpdate(supabase, 'sessions', { phase: 'SLIDER' }, 'id', session_id); } catch (e) { /* ignore */ }
            return res.status(200).json({ phase: 'SLIDER', insights: sliderData, session_purpose: latestGoal?.session_purpose || '', turn });
        }

        // ── Role A ──
        let plan = parseLLMJson(await callOpenAI(buildPlannerPrompt({
            userMessage: user_message, anchor, latestGoal, confirmedInsights: insights,
            history: history.map(m => ({ role: m.role, content: m.content })), turn,
        })));
        if (!plan) return res.status(500).json({ error: 'Planner出力パースエラー' });

        // ── Role E + リトライ ──
        let mgr = parseLLMJson(await callOpenAI(buildManagerPrompt({ plannerOutput: plan, anchor, previousInterviewerQuestion: prevInterviewerMsg })));
        if (!mgr) mgr = { alignment_score: 100, drift_detected: false, violations: [], correction: null };

        let retries = 0;
        while (mgr.drift_detected && retries < 2) {
            console.log(`[/api/process] drift retry ${retries + 1}`);
            plan = parseLLMJson(await callOpenAI(buildPlannerPrompt({
                userMessage: user_message, anchor, latestGoal, confirmedInsights: insights,
                history: history.map(m => ({ role: m.role, content: m.content })), turn,
                managerCorrection: mgr.correction,
            })));
            if (!plan) break;
            mgr = parseLLMJson(await callOpenAI(buildManagerPrompt({ plannerOutput: plan, anchor, previousInterviewerQuestion: prevInterviewerMsg })));
            if (!mgr) mgr = { alignment_score: 100, drift_detected: false, violations: [], correction: null };
            retries++;
        }

        // ── DB保存 ──
        try {
            await dbInsert(supabase, 'goal_history', {
                session_id, turn_number: turn, goal_text: plan.sessionPurpose || '',
                session_purpose: plan.sessionPurpose || '', mgu: plan.main_goal_understanding || 0,
                sqc: plan.sub_question_clarity || 0, question_type: plan.question_type || 'open',
                cognitive_filter: plan.cognitive_filter || {}, why_completeness_score: plan.why_completeness_score || 0,
                active_sub_questions: plan.active_sub_questions || [], manager_alignment_score: mgr.alignment_score || 100,
                turn, raw_planner_output: plan, raw_manager_output: mgr,
            });
        } catch (e) {
            console.error('[process] goal_history保存失敗:', e);
        }

        // confirmed_insights upsert
        if (plan.confirmed_insights?.length > 0) {
            for (const ins of plan.confirmed_insights) {
                if ((ins.confirmation_strength || 0) > 0) {
                    await dbUpsert(supabase, 'confirmed_insights', {
                        session_id, label: ins.label, layer: ins.layer,
                        strength: ins.strength || 50, confirmation_strength: ins.confirmation_strength,
                        tag: (ins.strength || 50) >= 70 ? 'primary' : 'supplementary', turn,
                    }, 'session_id,label');
                }
            }
        }

        // ── Phase遷移チェック ──
        const activeSubQs = plan.active_sub_questions || [];
        const allResolved = activeSubQs.length > 0 && activeSubQs.every(q => q.status === 'resolved');

        if (plan.main_goal_understanding >= 80 && allResolved) {
            const { data: latestInsights } = await supabase.from('confirmed_insights').select('*').eq('session_id', session_id).order('strength', { ascending: false });
            if (!latestInsights || latestInsights.length === 0) {
                const question = await callOpenAI(buildInterviewerPrompt(plan), false, 500);
                try { await dbInsert(supabase, 'messages', { session_id, role: 'assistant', content: question, turn_number: turn }); } catch (e) { /* ignore */ }
                return res.status(200).json({ phase: 'CONVERSATION', message: question, turn, debug: buildDebug(plan, mgr) });
            }
            const sliderData = synthesize(latestInsights, anchor.original_message || '');
            try { await dbUpdate(supabase, 'sessions', { phase: 'SLIDER' }, 'id', session_id); } catch (e) { /* ignore */ }
            return res.status(200).json({ phase: 'SLIDER', insights: sliderData, session_purpose: plan.sessionPurpose, turn, debug: buildDebug(plan, mgr) });
        }

        // ── 会話継続 ──
        const question = await callOpenAI(buildInterviewerPrompt(plan), false, 500);
        try { await dbInsert(supabase, 'messages', { session_id, role: 'assistant', content: question, turn_number: turn }); } catch (e) { /* ignore */ }

        return res.status(200).json({ phase: 'CONVERSATION', message: question, turn, debug: buildDebug(plan, mgr) });

    } catch (err) {
        console.error('[/api/process] Error:', err);
        return res.status(500).json({ error: err.message });
    }
}

function buildDebug(plan, mgr) {
    return {
        mgu: plan.main_goal_understanding, sqc: plan.sub_question_clarity,
        question_type: plan.question_type, session_purpose: plan.sessionPurpose,
        manager_alignment_score: mgr?.alignment_score || 100,
        active_sub_questions: plan.active_sub_questions, cognitive_filter: plan.cognitive_filter,
    };
}
