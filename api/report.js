/**
 * Vercel Serverless Function: /api/report
 * レポート生成 API (CLARIX v3)
 * 外部設計 §4.5 準拠
 */
import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 60 };

function getSupabase() {
    const url = process.env.SUPABASE_URL || 'https://mfwgpicsalflypomhuly.supabase.co';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1md2dwaWNzYWxmbHlwb21odWx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzExNDU0ODAsImV4cCI6MjA4NjcyMTQ4MH0.f-jKJMCSl7r7KZztNCVw_VmznNCPP1AapjxD2oFrTIE';
    return createClient(url, key);
}

async function callOpenAI(messages, jsonMode = false, maxTokens = 8000) {
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

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { session_id, slider_weights = {} } = req.body || {};
        if (!session_id) return res.status(400).json({ error: 'session_id required' });

        const supabase = getSupabase();

        // Phase ガード
        const { data: session } = await supabase
            .from('sessions').select('*').eq('id', session_id).single();
        if (!session || session.phase !== 'SLIDER') {
            return res.status(400).json({ error: 'PHASE_MISMATCH', message: 'レポート生成はSLIDERフェーズのみ' });
        }

        // スライダー値保存
        for (const [insightId, weight] of Object.entries(slider_weights)) {
            await supabase.from('confirmed_insights')
                .update({ slider_weight: weight })
                .eq('id', insightId);
        }

        // データ収集
        const { data: insights } = await supabase.from('confirmed_insights').select('*').eq('session_id', session_id).order('strength', { ascending: false });
        const { data: anchor } = await supabase.from('session_anchors').select('*').eq('session_id', session_id).single();
        const { data: goalRows } = await supabase.from('goal_history').select('*').eq('session_id', session_id).order('turn_number', { ascending: false }).limit(1);
        const latestGoal = goalRows?.[0] || null;
        const { data: msgs } = await supabase.from('messages').select('*').eq('session_id', session_id).order('created_at', { ascending: true });

        // insights にスライダー重みをマージ
        const weightedInsights = (insights || []).map(ins => ({
            ...ins,
            slider_weight: slider_weights[ins.id] ?? ins.strength,
        }));

        const insightsText = weightedInsights.map((ins, i) => {
            const w = ins.slider_weight ?? ins.strength;
            const blind = ins.tag === 'primary' ? '' : ' (補助)';
            return `${i + 1}. [${ins.layer}] ${ins.label} (重み: ${w}%)${blind}`;
        }).join('\n');

        const userMsgs = (msgs || []).filter(m => m.role === 'user').map(m => `- ${m.content.substring(0, 100)}`).join('\n');

        // Role D プロンプト
        const system = `あなたは Reporter AI（Role D）です。Whyレポートを生成してください。

構成: 1.セッション概要 2.Why構造マップ(attribute→consequence→value) 3.重要インサイト 4.盲点の発見 5.推奨ネクストアクション

ルール:
- Markdown形式（h2から開始）
- ユーザーの言葉を引用
- How語はレポートに含めない、What語はOK`;

        const user = `元の問い: "${anchor?.original_message || ''}"\nセッション目的: "${latestGoal?.session_purpose || ''}"\n\nインサイト:\n${insightsText}\n\n会話要約:\n${userMsgs}`;

        const reportMarkdown = await callOpenAI(
            [{ role: 'system', content: system }, { role: 'user', content: user }],
            false, 8000
        );

        // 保存
        await supabase.from('reports').upsert({
            session_id,
            report_markdown: reportMarkdown,
            session_purpose: latestGoal?.session_purpose || '',
        }, { onConflict: 'session_id' });

        await supabase.from('sessions').update({ phase: 'REPORT' }).eq('id', session_id);

        return res.status(200).json({
            phase: 'REPORT',
            report_markdown: reportMarkdown,
        });
    } catch (err) {
        console.error('[/api/report] Error:', err);
        return res.status(500).json({ error: err.message });
    }
}
