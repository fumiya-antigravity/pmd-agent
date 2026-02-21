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
        ? `## 前回の状態\n- why_completeness_score: ${latestGoal.why_completeness_score || 0}\n- sessionPurpose: "${latestGoal.session_purpose || ''}"\n- question_tree: ${JSON.stringify(latestGoal.tasks || [])}`
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

    const system = `あなたは Planner AI です。ユーザーの壁打ちを分析しJSONを出力。

# 原則
1. **情報利得最大化**: 次の質問は「anchorの不確実性を最大削減するもの」を選ぶ。不確実性が変わらない質問は生成禁止
2. **ベイズ更新**: 各回答でMGUを更新、ゴール空間を狭める
3. **ラダリング3層**: 属性(+5) → 結果(+10) → 価値観(+20) で深掘り
4. **認知フィルタ**: How=ノイズ(除外), What=文脈(記録), Why=深掘り対象
5. **Satisficing**: MGU≥80%で完了${mguContext}

# 質問ツリー
- 初回: Whyの不確実性が高い要素を親質問として抽出、情報利得順にpriority設定
- ターン1+: 回答を分析→新たな不確実性あれば子質問生成、既出なら吸収してresolved
- resolved条件: 全子質問が解決した場合のみ。子質問残存で親遷移は絶対禁止

# 仮説確認後の進行（最重要）
ユーザーが「はい」「そうです」等で仮説を肯定した場合:
1. 現在の層のinsightをresolved（confirmation_strength=1.0）
2. **次は必ず1層深い方向へ進む**:
   - 属性層が確認された → 結果層へ（「それができるようになると、何が変わる？」「それが実現したら、どうなる？」）
   - 結果層が確認された → 価値観層へ（「それって最終的にどうありたいから？」）
   - 価値観層が確認された → 親質問をresolved、次の親質問へ
3. 横に逸れる質問（確認済み内容の言い換え、関連するが別トピック）は絶対禁止
4. **ネガティブフレーミング禁止**: 「何が困る？」「何が問題？」ではなく、「何ができるようになる？」「何が変わる？」とポジティブに深掘りする

# anchor常時チェック
**全ての質問は anchor に紐づいていなければならない。**
例: anchor=「壁打ちAIを作りたい」
  OK: 「その壁打ちAIで何が変わる？」（anchorに直結）
  NG: 「要件定義の際にどんな目的を持ってますか？」（ユーザーの仕事の話であってAIの話ではない）

# 重複・同角度禁止
1. **既出チェック**: 答えが既に述べられている → 生成しない
2. **同角度チェック**: 直前と同じ角度 → 生成しない
3. **ゴール関連性**: anchor理解が進まない → 生成しない

# 出力JSON
{
  "main_goal_understanding": <0-100>,
  "sub_question_clarity": <0-100>,
  "why_completeness_score": <0-100>,
  "sessionPurpose": "<1文>",
  "question_type": "open"|"hypothesis",
  "question_tree": [{"id":1,"question":"<親質問>","priority":<n>,"status":"exploring|pending|resolved","resolved_context":"<要約>","children":[{"question":"<子質問>","layer":"attribute|consequence|value","status":"active|resolved","information_gain":"<説明>"}]}],
  "current_focus": {"parent_id":<n>,"next_question":"<Interviewerが聞くべき質問の趣旨>","expected_information_gain":"<何がわかるか>","layer":"attribute|consequence|value"},
  "confirmed_insights": [{"label":"<要約>","layer":"<layer>","strength":<0-100>,"confirmation_strength":<0-1>,"turn":<n>}],
  "cognitive_filter": {"detected_how":[],"detected_what":[],"instruction":"<説明>"}
}
# MGU: delta = layer_score × confirmation_strength
# question_type: MGU<60→open, MGU≥60→hypothesis
# confirmed_insights: 差分のみ${correctionSection}`;

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

    const system = `あなたは Manager AI（Role E）です。Planner出力がアンカー（ユーザーの元メッセージ）と整合しているか検証してください。

チェック:
[A1] sessionPurpose ↔ anchor 類似度低→drift
[A2] question_tree の質問 ↔ sessionPurpose 無関連→drift
[A3] MGU delta>30→mgu_spike
[A4] 子質問が残っているのに次の親質問をexploringにしていないか→tree_violation
[A5] current_focus.next_question がゴールの不確実性を削減するか→low_information_gain
[B1] How語混入（What語はOK）→cognitive_filter_violation
[B2] current_focusの質問趣旨に「？」2個以上→miller_law_violation
[G1] core_keywords 3ターン不在→topic_drift

出力JSON:
{ "alignment_score": <0-100>, "drift_detected": true|false, "violations": [], "correction": { "target_role": "Planner", "instruction": "<修正指示>", "anchor_message": "<元メッセージ>" } | null }

alignment_score<70→drift_detected=true, correctionは必須`;

    const user = `## アンカー\n- original_message: "${anchorMsg}"\n- core_keywords: ${JSON.stringify(anchorKeywords)}\n\n## Planner出力\n${JSON.stringify(plannerOutput, null, 2)}\n\n## 前回Interviewer質問\n${previousInterviewerQuestion || '（turn 0: なし）'}`;

    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// ===================================================
// Role B (Interviewer) — PRD §3.2 Role B 準拠
// Planner(Role A)のJSON→ユーザーへの自然な「先輩の言葉」に変換
// ===================================================
function buildInterviewerPrompt(plannerOutput, userMessage, history) {
    const howWords = (plannerOutput.cognitive_filter?.detected_how || []).join(', ');
    const mgu = plannerOutput.main_goal_understanding || 0;
    const focus = plannerOutput.current_focus || {};
    const questionTree = plannerOutput.question_tree || [];
    const questionType = plannerOutput.question_type || 'open';

    // resolved済み親質問のコンテキストを収集
    const resolvedParents = questionTree
        .filter(q => q.status === 'resolved' && q.resolved_context)
        .map(q => `- ${q.question}: ${q.resolved_context}`)
        .join('\n');

    // 現在exploringの親質問
    const currentParent = questionTree.find(q => q.status === 'exploring');
    const pendingCount = questionTree.filter(q => q.status === 'pending').length;

    let contextSection = '';
    if (resolvedParents) {
        contextSection = `## これまでに判明した情報
${resolvedParents}`;
    }

    // 会話履歴を構造化
    const pastConversation = (history || [])
        .map(m => `[${m.role === 'user' ? 'ユーザー' : 'AI'}] ${m.content}`)
        .join('\n');

    const system = `先輩PdMとして、Plannerの指示を自然な1つの質問に変換。
**質問の内容はPlannerのnext_questionに従う。自分で質問を設計しない。**

# MGU切替（厳守）
## open（MGU 0〜59%）
解釈を加えず引き出す。率直に一文。
OK: 「なんで壁打ちAIを作りたいの？」

## hypothesis（MGU 60〜79%）
**あなたの解釈を述べて、Yes/Noで答えられる形にする。**
OK: 「つまり、Whyを言語化して要件定義の質を上げたいってこと？」
NG: 「つまり、どのような成果を期待していますか？」← つまり+質問の混合は絶対禁止
NG: 「つまり、具体的な解や結果は何ですか？」← 同上

${contextSection}

## Plannerの指示
- 親質問: ${currentParent?.question || '（なし）'}
- 次に聞くこと: ${focus.next_question || '（指定なし）'}
- 残り: ${pendingCount}個

# 重複チェック（最重要）
**出力前に以下の過去会話を必ず確認。**
1. AIが既に聞いた質問と同じ or 似た質問は絶対禁止
2. ユーザーが既に回答した内容を聞き直すのは絶対禁止
違反する場合は、まだ聞いていない別の角度に変換すること。
--- 過去会話 ---
${pastConversation || '（初回ターン）'}
---

# ルール
- 1ターン1質問、ユーザーの語彙を使う
- How/What語禁止: ${howWords || 'なし'}
- 禁止語: 苦痛, 感じる, つらい, 悩み, 大変, つまずく
- JSON・スコア漏洩禁止

1-2文テキストのみ。`;

    const user = `ユーザーの最新発話: "${userMessage || ''}"
question_type: ${questionType}
MGU: ${mgu}%`;

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
                    session_purpose: plan.sessionPurpose || '',
                    cognitive_filter: plan.cognitive_filter || {}, why_completeness_score: plan.why_completeness_score || 0,
                    tasks: plan.question_tree || [],
                    abstract_goal: plan.sessionPurpose || '',
                });
            } catch (e) {
                console.error('[process] goal_history保存失敗:', e);
            }

            const question = await callOpenAI(buildInterviewerPrompt(plan, user_message, []), false, 500);

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
                debug: { mgu: plan.main_goal_understanding, sqc: plan.sub_question_clarity, question_type: plan.question_type, session_purpose: plan.sessionPurpose, manager_alignment_score: 100, question_tree: plan.question_tree, cognitive_filter: plan.cognitive_filter },
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
                const q = await callOpenAI(buildInterviewerPrompt({ sessionPurpose: latestGoal?.session_purpose || '', question_type: 'hypothesis', question_tree: [], cognitive_filter: {}, current_focus: { focus_direction: '最終確認' }, main_goal_understanding: 80 }, user_message), false, 500);
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
                session_purpose: plan.sessionPurpose || '',
                cognitive_filter: plan.cognitive_filter || {}, why_completeness_score: plan.why_completeness_score || 0,
                tasks: plan.question_tree || [],
                abstract_goal: plan.sessionPurpose || '',
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
        const tree = plan.question_tree || [];
        const allResolved = tree.length > 0 && tree.every(q => q.status === 'resolved');

        if (plan.main_goal_understanding >= 80 && allResolved) {
            const { data: latestInsights } = await supabase.from('confirmed_insights').select('*').eq('session_id', session_id).order('strength', { ascending: false });
            if (!latestInsights || latestInsights.length === 0) {
                const question = await callOpenAI(buildInterviewerPrompt(plan, user_message, history), false, 500);
                try { await dbInsert(supabase, 'messages', { session_id, role: 'assistant', content: question, turn_number: turn }); } catch (e) { /* ignore */ }
                return res.status(200).json({ phase: 'CONVERSATION', message: question, turn, debug: buildDebug(plan, mgr) });
            }
            const sliderData = synthesize(latestInsights, anchor.original_message || '');
            try { await dbUpdate(supabase, 'sessions', { phase: 'SLIDER' }, 'id', session_id); } catch (e) { /* ignore */ }
            return res.status(200).json({ phase: 'SLIDER', insights: sliderData, session_purpose: plan.sessionPurpose, turn, debug: buildDebug(plan, mgr) });
        }

        // ── 会話継続 ──
        const question = await callOpenAI(buildInterviewerPrompt(plan, user_message, history), false, 500);
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
        current_focus: plan.current_focus,
        question_tree: plan.question_tree, cognitive_filter: plan.cognitive_filter,
    };
}
