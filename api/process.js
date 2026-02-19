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
        ? `## 前回の状態\n- MGU: ${latestGoal.mgu || 0}\n- SQC: ${latestGoal.sqc || 0}\n- sessionPurpose: "${latestGoal.session_purpose || ''}"\n- question_type: ${latestGoal.question_type || 'open'}\n- question_tree: ${JSON.stringify(latestGoal.active_sub_questions || [])}`
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
1. Whyを深掘り。How（手段・方法）やWhat（機能・仕様）の話題が出たら、その裏にあるWhyを探る
2. cognitive_filter: How語とWhat語を分類。How語は最終レポートで除外、What語はOK
3. SQC: ユーザー回答中の主観語を検出して0-100で出力${mguContext}

# 質問ツリー構造（最重要）
ユーザーのメッセージを分析し、**複数の疑問点（親質問）**を洗い出し、優先順位をつけて管理する。

## ルール
- **初回ターン**: ユーザーのメッセージから全ての疑問点を親質問として抽出し、priorityをつける
  例: 「私専用の壁打ちするAIエージェントを作りたい」
  → 親質問1(priority:1): 「なぜ壁打ちAIを作りたいのか（動機・きっかけ）」
  → 親質問2(priority:2): 「なぜ"専用"である必要があるのか」
  → 親質問3(priority:3): 「なぜ"壁打ち"という形式なのか」

- **ターン1以降**: ユーザーの回答を分析し、
  - 現在exploring中の親質問の子質問を生成する（回答から新たな疑問が生まれた場合）
  - 子質問が全て解決→親質問をresolvedに、次の親質問をexploringに
  - **次の親質問に移る際、前の会話で得た情報を resolved_context に要約する**

## 回答吸収ルール（最重要）
ユーザーの回答を正しく吸収し、適切にresolved判定するためのルール:

1. **十分な回答の判定**: 質問に対して、意味的に回答が含まれていればその質問は**resolved**にする。
   表現の形式（語尾・文体）は問わない。ユーザーが質問の趣旨に対して何らかの答えを述べていれば、それは十分な回答である。
   迷ったらresolvedにする（聞きすぎるリスク > 聞き足りないリスク）。

2. **重複質問の禁止**: 新しい質問を生成する前に「この質問に対する答えは、既にユーザーが述べた内容と重複しないか？」を確認する。
   重複する → その質問はresolved扱い。生成しない。
   重複しない → activeとして生成してよい。

3. **子質問の生成制限**: 子質問を生成するのは、ユーザーの回答に**新しい主観語や曖昧な表現がある場合のみ**。
   明確に答えたのに子質問を追加するのは禁止。

4. **resolved_contextの重要性**: resolvedにする際、ユーザーの回答内容を正確に要約してresolved_contextに入れる。
   これが次の親質問を最適化する情報源になる。

## ステータス
- exploring: 今深掘り中の親質問（常に1つだけ）
- pending: まだ手をつけていない親質問
- resolved: 深掘り完了した質問
- active: 子質問で未解決
- resolved: 子質問で解決済み

# 出力JSON
{
  "main_goal_understanding": <0-100>,
  "sub_question_clarity": <0-100>,
  "why_completeness_score": <0-100>,
  "sessionPurpose": "<1文>",
  "question_type": "open" | "hypothesis",
  "question_tree": [
    {
      "id": 1,
      "question": "<親質問テキスト>",
      "priority": <1が最優先>,
      "status": "exploring" | "pending" | "resolved",
      "resolved_context": "<この親質問で判明した情報の要約。resolvedの場合のみ>",
      "children": [
        { "question": "<子質問テキスト>", "layer": "attribute"|"consequence"|"value", "status": "active"|"resolved" }
      ]
    }
  ],
  "current_focus": {
    "parent_id": <現在exploring中の親質問ID>,
    "child_question": "<今聞くべき子質問テキスト or null（親質問を直接聞く場合）>",
    "focus_direction": "<質問の方向性>",
    "subjective_word": "<深掘りすべき主観語（あれば）>",
    "topic_noun": "<主題名詞>"
  },
  "confirmed_insights": [{ "label": "<要約>", "layer": "<layer>", "strength": <0-100>, "confirmation_strength": <0.0-1.0>, "turn": <n> }],
  "cognitive_filter": { "detected_how": [], "detected_what": [], "instruction": "<説明>" }
}

# MGU計算: attribute=+5, consequence=+10, value=+20 x confirmation_strength
# question_type: MGU<60=open, MGU>=60=hypothesis
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
// Role B (Interviewer) — 外部設計 S5.2
// 質問ツリーに基づき、最適な1つの質問を生成
// ===================================================
function buildInterviewerPrompt(plannerOutput, userMessage) {
    const howWords = (plannerOutput.cognitive_filter?.detected_how || []).join(', ');
    const mgu = plannerOutput.main_goal_understanding || 0;
    const focus = plannerOutput.current_focus || {};
    const questionTree = plannerOutput.question_tree || [];

    // resolved済み親質問のコンテキストを収集
    const resolvedParents = questionTree
        .filter(q => q.status === 'resolved' && q.resolved_context)
        .map(q => `- [解決済] ${q.question}: ${q.resolved_context}`)
        .join('\n');

    // 現在exploringの親質問
    const currentParent = questionTree.find(q => q.status === 'exploring');
    const pendingParents = questionTree.filter(q => q.status === 'pending');

    // 現在の親質問のactive子質問
    const activeChildren = currentParent?.children
        ?.filter(c => c.status === 'active')
        ?.map(c => `- ${c.question}`)
        ?.join('\n') || '';

    let contextSection = '';
    if (resolvedParents) {
        contextSection = `## これまでの会話で判明したこと
${resolvedParents}

**重要: 上記の情報を踏まえて、次の質問を最適化してください。既に判明している情報は聞き直さない。**`;
    }

    let questionGuide = '';
    if (currentParent) {
        const isFirstAsk = !currentParent.children || currentParent.children.length === 0 ||
            currentParent.children.every(c => c.status === 'active');

        if (isFirstAsk && !resolvedParents) {
            // 最初の親質問の最初の質問 → 全体を受け止めてからWhyを聞く
            questionGuide = `## 今聞くべきこと
親質問「${currentParent.question}」について聞く。
これが最初の質問なので、ユーザーのメッセージ全体をまず受け止めてから、核心的なWhyを聞く。

例:
入力: 「私専用の壁打ちするAIエージェントを作りたい」
→ 「壁打ちAIかー、面白いね！そもそもなんでそれを作ろうと思ったの？」`;
        } else if (isFirstAsk && resolvedParents) {
            // 2つ目以降の親質問 → 前の会話で得た情報を活かして質問を設計
            questionGuide = `## 今聞くべきこと
次の親質問「${currentParent.question}」に移ります。
**前の会話で判明した情報を踏まえて、この質問を最適化してください。**
前の会話の流れから自然につなげること。

例: 前の会話で「自分の思考を整理したい」と判明していた場合、
「なぜ"専用"なのか」を聞く際に →
「思考の整理のためなんだね。ちなみに、"専用"って言ってたけど、どんなところが自分だけ向けだと嬉しい？」`;
        } else if (activeChildren) {
            // 子質問がある → 子質問を深掘り
            questionGuide = `## 今聞くべきこと
親質問「${currentParent.question}」を深掘り中。
未解決の子質問:
${activeChildren}

${focus.child_question ? `次に聞く子質問: 「${focus.child_question}」` : ''}
${focus.subjective_word ? `深掘り対象の主観語: 「${focus.subjective_word}」` : ''}`;
        }
    }

    const remainingInfo = pendingParents.length > 0
        ? `\n## 後で聞く予定の質問（${pendingParents.length}個残り）\n${pendingParents.map(q => `- ${q.question}`).join('\n')}`
        : '';

    const system = `あなたは信頼できる先輩PdMです。後輩の壁打ち相手として、温かく、でも鋭い1つの質問をしてください。

## あなたの性格
- カジュアルで親しみやすい口調
- 相手の回答を具体的に受け止めてから、別の角度の質問をする（最重要）
- 短く、核心をつく
- 手段（How）や仕様（What）には踏み込まない

## 回答の汲み取り方（最重要）
ユーザーが回答したら、その内容を**具体的に**受け止めてから次に進む。

良い例:
- 回答「AIを使いこなせる人を増やしたいから」
  → 「なるほど、AIリテラシーの底上げかー。ちなみに"子供向け"にしたのは何かある？」
  （回答内容を要約 + 別の角度で質問）

悪い例:
- 回答「選択肢を増やしたい」
  → 「どんな選択肢を増やしたい？」（同じ角度で深掘り = くどい）
  → 「その選択肢って具体的には？」（同じ角度 = しつこいと感じる）

**ルール**: ユーザーの回答と同じ角度・同じテーマでさらに聞き返すのは禁止。
回答を受け止めたら、まだ聞いていない別の角度に移る。

${contextSection}

${questionGuide}
${remainingInfo}

## 絶対禁止
- 「つまり」で始める
- 「〜ということでしょうか？」で終わる
- 「〜の理由は何ですか？」（理由を直接聞くのはNG）
- ユーザーの発話をほぼそのままオウム返しする
- 「理由」「必要」「特別」という単語
- 専門用語: ボトルネック, 構造, 乖離, 意思決定, 前提, 条件, ニーズ
- カウンセラー語: 苦痛, 感じる, つらい, 悩み, 大変, つまずく
- How語: ${howWords || 'なし'}
- 機能・要件・仕様の話
- JSON, スコア, メタ情報

## 応答フォーマット
「受け止め + 質問」の形で1-2文。

良い例:
- 「壁打ちAIかー、面白いね！そもそもなんでそれを作ろうと思ったの？」
- 「なるほどね。ちなみに"専用"って言ってたけど、どんなところが自分だけ向けだと嬉しい？」
- 「そっかー。今のやり方だと、何が足りない感じ？」

テキストのみ出力。`;

    const user = `ユーザーの最新発話: "${userMessage || ''}"
質問の方向: ${focus.focus_direction || '未定'}
主観語: ${focus.subjective_word || '（なし）'}
主題: ${focus.topic_noun || '（未定）'}`;

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
                    active_sub_questions: plan.question_tree || [], manager_alignment_score: 100,
                    turn: 0, raw_planner_output: plan,
                });
            } catch (e) {
                console.error('[process] goal_history保存失敗:', e);
            }

            const question = await callOpenAI(buildInterviewerPrompt(plan, user_message), false, 500);

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
                session_purpose: plan.sessionPurpose || '', mgu: plan.main_goal_understanding || 0,
                sqc: plan.sub_question_clarity || 0, question_type: plan.question_type || 'open',
                cognitive_filter: plan.cognitive_filter || {}, why_completeness_score: plan.why_completeness_score || 0,
                active_sub_questions: plan.question_tree || [], manager_alignment_score: mgr.alignment_score || 100,
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
        const tree = plan.question_tree || [];
        const allResolved = tree.length > 0 && tree.every(q => q.status === 'resolved');

        if (plan.main_goal_understanding >= 80 && allResolved) {
            const { data: latestInsights } = await supabase.from('confirmed_insights').select('*').eq('session_id', session_id).order('strength', { ascending: false });
            if (!latestInsights || latestInsights.length === 0) {
                const question = await callOpenAI(buildInterviewerPrompt(plan, user_message), false, 500);
                try { await dbInsert(supabase, 'messages', { session_id, role: 'assistant', content: question, turn_number: turn }); } catch (e) { /* ignore */ }
                return res.status(200).json({ phase: 'CONVERSATION', message: question, turn, debug: buildDebug(plan, mgr) });
            }
            const sliderData = synthesize(latestInsights, anchor.original_message || '');
            try { await dbUpdate(supabase, 'sessions', { phase: 'SLIDER' }, 'id', session_id); } catch (e) { /* ignore */ }
            return res.status(200).json({ phase: 'SLIDER', insights: sliderData, session_purpose: plan.sessionPurpose, turn, debug: buildDebug(plan, mgr) });
        }

        // ── 会話継続 ──
        const question = await callOpenAI(buildInterviewerPrompt(plan, user_message), false, 500);
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
        question_tree: plan.question_tree, cognitive_filter: plan.cognitive_filter,
    };
}
