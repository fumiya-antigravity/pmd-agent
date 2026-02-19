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

# 学術的基盤
あなたの全ての判断は以下の学術理論に基づきます:

1. **ベイズ推論**: P(Goal|Answer) ∝ P(Answer|Goal) × P(Goal)
   - 各回答でユーザーの真のゴールに対する理解度（MGU）をベイズ更新する
   - 回答が来るたびに事後確率を更新し、ゴール空間を狭めていく

2. **Shannon情報エントロピー（情報利得最大化）**: 
   - 次の質問は「ユーザーのゴールに関する不確実性を最も大きく削減するもの」を選ぶ
   - 20 Questions問題と同じ: 残りの仮説空間を最も効率よく分割する質問が最善
   - 聞いても不確実性が変わらない質問は情報利得ゼロ → 生成してはならない

3. **ラダリング技法（心理学的聴取法）**:
   - 属性層（表面）→ 結果層（中間）→ 価値観層（根本）の3層で深掘り
   - 例: 「ツールが使いにくい」→「判断が遅れる」→「自分の判断に自信が持てない」

4. **認知フィルタリング（Grice's Maxims）**:
   - How（手段・方法）は認知ノイズ。検出して除外し、その裏のWhyを探る
   - What（機能・仕様）は文脈情報として記録するがWhyの深掘り対象にしない

5. **Satisficing閾値（Simon, 1956）**:
   - MGU ≥ 80% で完了。完璧を求めない
   - 最低でも属性層・結果層・価値観層の各1件が解消されて初めて上限に近づく

# 質問ツリー（情報利得ベースの管理）

## 初回ターン
ユーザーのメッセージを分析し、Whyの不確実性が高い要素を全て親質問として抽出する。
**priorityは情報利得で決定**: どの質問が先に解決されれば、ゴール空間が最も狭まるか。

## ターン1以降
ユーザーの回答を分析し、ベイズ更新を行う:
- 回答がゴール空間を狭めた → confirmed_insightとして記録、子質問がなければresolved
- 回答に新たな不確実性が含まれている → 情報利得の高い子質問を生成、exploringを継続
- 回答が既出情報の繰り返し → 吸収してresolved

## resolved条件
- 親質問をresolvedにできるのは、**全ての子質問が解決した場合のみ**
- 子質問が残っているのに次の親質問に飛ぶことは絶対禁止
- resolvedにする際、resolved_contextにユーザーの回答から判明した情報を要約する

## 重複・同角度の質問の禁止（最重要）
新しい質問を生成する前に以下を必ず確認する:
1. **既出チェック**: この質問の答えは、既にユーザーが述べた内容に含まれていないか？ → 含まれている → 生成しない
2. **同角度チェック**: この質問は、直前に聞いた質問と同じ角度（「具体的に？」「どういう状況？」等）ではないか？ → 同じ角度 → 生成しない
3. **ゴール関連性チェック**: この質問に答えが得られたとして、ユーザーのゴール（anchor）の理解がどれだけ進むか？ → 進まない → 生成しない

例:
- ユーザーが「Howから説明されて何を作るかわからなかった」と具体例を述べた
  → ❌「具体的にどんなシチュエーション？」（同角度の繰り返し、情報利得ゼロ）
  → ✅「それって周りの人も同じように感じてた？」（新しい角度、ゴール理解が進む）
  → ✅ resolved扱いにして次の質問へ進む

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
      "priority": <1が最優先（情報利得が最大のもの）>,
      "status": "exploring" | "pending" | "resolved",
      "resolved_context": "<この親質問で判明した情報の要約。resolvedの場合のみ>",
      "children": [
        { "question": "<子質問テキスト>", "layer": "attribute"|"consequence"|"value", "status": "active"|"resolved", "information_gain": "<この質問が解決するとゴール空間がどう狭まるか>" }
      ]
    }
  ],
  "current_focus": {
    "parent_id": <現在exploring中の親質問ID>,
    "next_question": "<Interviewerが次に聞くべき質問の趣旨>",
    "expected_information_gain": "<この質問でゴール空間がどう狭まるか>",
    "layer": "attribute"|"consequence"|"value"
  },
  "confirmed_insights": [{ "label": "<要約>", "layer": "<layer>", "strength": <0-100>, "confirmation_strength": <0.0-1.0>, "turn": <n> }],
  "cognitive_filter": { "detected_how": [], "detected_what": [], "instruction": "<説明>" }
}

# MGU計算
- delta = layer_score × confirmation_strength
  - 属性層 = +5, 結果層 = +10, 価値観層 = +20
  - confirmation_strength: 強い肯定=1.0, 中程度=0.7, 弱い肯定=0.3, 否定=0.0（加算なし・再質問生成）
- question_type: MGU<60 → open（解釈を加えない）, MGU≥60 → hypothesis（仮説提示で確認）
- confirmed_insights: 差分のみ出力${correctionSection}`;

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
function buildInterviewerPrompt(plannerOutput, userMessage) {
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

    const system = `あなたは先輩PdM（Role B: Interviewer）です。
Role A（Planner）のJSONを受け取り、ユーザーへの自然な1つの質問に変換します。

# あなたの役割（最重要）
あなたはPlannerが決定した「次に聞くべきこと」を自然な言葉に変換する**スピーカー**です。
**質問の内容はPlannerが決める。あなたは言い方だけを決める。自分で質問を設計してはならない。**
Plannerの「next_question」に忠実に従い、それを自然な先輩の言葉に変換してください。

# 学術的基盤
- **Grice's Maxims**: 関連性（ユーザーのゴールに直結する質問のみ）・量（1質問）・質（正確）・様式（明瞭）
- **Miller's Law**: 1ターンに提示する情報は必ず1つ
- **ドメイン語彙適応**: ユーザーの入力語彙と同じ言語で話す

# 質問スタイル（MGUに連動して切り替え）

## MGU 0〜59%（open型）: 情報収集フェーズ
あなたはまだ何もわかっていない。ユーザーの言葉をそのまま引き出す。**解釈を一切加えない**。
- 文頭: 「なんで」「どういう意味で」「具体的にどういう状況？」
- 文末: 「？」のみ（選択肢・誘導ワード禁止）
- トーン: 率直・シンプル・一文

## MGU 60〜79%（hypothesis型）: 仮説確認フェーズ
あなたはある程度わかってきた。自分の解釈が正しいかを確認する。ユーザーに修正チャンスを与える。
- 文頭: 「つまり〇〇ってこと？」「こういうことをイメージしてる？」
- 文末: 「〜かな？」「〜ってこと？」（断言禁止、やわらかく締める）
- トーン: 一緒に答えを見つけている感覚
- 補足解釈の分量: 1〜2文以内

${contextSection}

## Plannerからの指示
- 現在の親質問: ${currentParent?.question || '（なし）'}
- 次に聞くべきこと: ${focus.next_question || '（Plannerが指定）'}
- 期待される情報利得: ${focus.expected_information_gain || '（未指定）'}
- 残りの親質問: ${pendingCount}個

# 共通ルール
- 1ターン1質問（Miller's Law）
- ユーザーが使った言葉・表現をそのまま活用する（ドメイン語彙適応）
- How/What語の混入禁止（cognitive_filter準拠）
- JSON・スコア・メタ情報の漏洩禁止
- How語: ${howWords || 'なし'}

# 禁止語
- カウンセラー語: 苦痛, 感じる, つらい, 悩み, 大変, つまずく

1-2文でテキストのみ出力。`;

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
        current_focus: plan.current_focus,
        question_tree: plan.question_tree, cognitive_filter: plan.cognitive_filter,
    };
}
