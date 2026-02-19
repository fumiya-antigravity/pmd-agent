/**
 * Vercel Serverless Function: /api/process/resume
 * スライダー → 会話に戻る API (CLARIX v3)
 * 外部設計 §4.4 準拠
 */
import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 10 };

function getSupabase() {
    return createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
    );
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { session_id } = req.body || {};
        if (!session_id) return res.status(400).json({ error: 'session_id required' });

        const supabase = getSupabase();
        const { data: session, error: sessErr } = await supabase
            .from('sessions').select('*').eq('id', session_id).single();

        if (sessErr || !session) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
        if (session.phase !== 'SLIDER') {
            return res.status(400).json({ error: 'PHASE_MISMATCH', message: 'resume はSLIDERフェーズでのみ可能' });
        }

        // MGU はリセットしない。次の process 呼び出しで Role A が再計算
        await supabase.from('sessions').update({ phase: 'CONVERSATION' }).eq('id', session_id);

        return res.status(200).json({ phase: 'CONVERSATION' });
    } catch (err) {
        console.error('[/api/process/resume] Error:', err);
        return res.status(500).json({ error: err.message });
    }
}
