/**
 * Vercel Serverless Function: /api/chat
 * Node.js Runtime — maxDuration 60s（Edge Runtime の 25s 制限を回避）
 */
export const config = {
    maxDuration: 60,
};

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { messages, jsonMode = true, maxTokens } = req.body || {};

        if (!messages?.length) {
            return res.status(400).json({ error: 'messages required' });
        }

        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
        }

        const openaiBody = {
            model: 'gpt-4o-mini',
            messages,
            temperature: 0.7,
            max_tokens: maxTokens || 4000,
        };

        // jsonMode=false の場合、response_format を外す（Phase1 自由テキスト用）
        if (jsonMode !== false && jsonMode !== 'false' && jsonMode !== 0) {
            openaiBody.response_format = { type: 'json_object' };
        }

        const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(openaiBody),
        });

        if (!openaiResp.ok) {
            const errBody = await openaiResp.text();
            console.error(`[OpenAI Error] ${openaiResp.status}: ${errBody}`);
            return res.status(openaiResp.status).json({
                error: `OpenAI API error: ${openaiResp.status}`,
                detail: errBody,
            });
        }

        const result = await openaiResp.json();
        const reply = result.choices[0].message.content;
        const usage = result.usage || {};

        // デバッグログ
        console.log(`[AI] model=${result.model} tokens=${usage.total_tokens || '?'}`);

        return res.status(200).json({
            reply,
            model: result.model,
            usage,
        });
    } catch (err) {
        console.error('[Server Error]', err);
        return res.status(500).json({ error: err.message });
    }
}
