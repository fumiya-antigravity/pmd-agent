/**
 * Vercel Edge Function: /api/chat
 * WHY_SESSION / DEEP_DIVE のAI呼び出しエンドポイント
 */
export const config = { runtime: 'edge' };

export default async function handler(req) {
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: corsHeaders(),
        });
    }

    if (req.method !== 'POST') {
        return jsonResponse(405, { error: 'Method not allowed' });
    }

    try {
        const body = await req.json();
        const { messages, jsonMode = true, maxTokens } = body;

        if (!messages?.length) {
            return jsonResponse(400, { error: 'messages required' });
        }

        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            return jsonResponse(500, { error: 'OPENAI_API_KEY not configured' });
        }

        const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages,
                temperature: 0.7,
                max_tokens: maxTokens || 4000,
                ...(jsonMode !== false ? { response_format: { type: 'json_object' } } : {}),
            }),
        });

        if (!openaiResp.ok) {
            const errBody = await openaiResp.text();
            console.error(`[OpenAI Error] ${openaiResp.status}: ${errBody}`);
            return jsonResponse(openaiResp.status, {
                error: `OpenAI API error: ${openaiResp.status}`,
                detail: errBody,
            });
        }

        const result = await openaiResp.json();
        const reply = result.choices[0].message.content;

        // デバッグログ
        try {
            const parsed = JSON.parse(reply);
            const hasRelated = 'relatedUpdates' in parsed;
            const relatedCount = (parsed.relatedUpdates || []).length;
            console.log(`[AI Response] relatedUpdates: ${hasRelated}, count: ${relatedCount}`);
            if (parsed.aspectUpdate) {
                console.log(`[AI Response] aspectUpdate: aspect=${parsed.aspectUpdate.aspect}, status=${parsed.aspectUpdate.status}`);
            }
        } catch {
            console.log(`[AI Response] JSON parse failed, raw length: ${reply.length}`);
        }

        return jsonResponse(200, {
            reply,
            model: result.model,
            usage: result.usage || {},
        });
    } catch (err) {
        console.error('[Server Error]', err);
        return jsonResponse(500, { error: err.message });
    }
}

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
    };
}

function jsonResponse(status, data) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...corsHeaders(),
        },
    });
}
