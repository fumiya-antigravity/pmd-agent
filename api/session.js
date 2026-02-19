/**
 * Vercel Serverless Function: /api/session
 * セッション作成 API (CLARIX v3)
 * 外部設計 §4.1 準拠
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
        const supabase = getSupabase();
        const { data, error } = await supabase
            .from('sessions')
            .insert({ title: '新しい壁打ち', phase: 'WELCOME' })
            .select()
            .single();

        if (error) {
            console.error('[/api/session] DB Error:', error);
            return res.status(500).json({ error: error.message });
        }

        return res.status(200).json({
            session_id: data.id,
            phase: 'WELCOME',
        });
    } catch (err) {
        console.error('[/api/session] Error:', err);
        return res.status(500).json({ error: err.message });
    }
}
