"""
PdM Assistant — Backend Server
静的ファイル配信 + OpenAI API Proxy
"""
import http.server
import json
import os
import urllib.request
import urllib.error

# .env読み込み
def load_env():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, val = line.split('=', 1)
                    os.environ[key.strip()] = val.strip()

load_env()

OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY', '')
OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
MODEL = 'gpt-4o-mini'

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
}


class APIHandler(http.server.SimpleHTTPRequestHandler):
    """静的ファイル配信 + /api/chat エンドポイント"""

    def _send_cors_headers(self):
        for key, val in CORS_HEADERS.items():
            self.send_header(key, val)

    def do_OPTIONS(self):
        """CORS preflight — 必ず空bodyで返す"""
        self.send_response(204)
        self._send_cors_headers()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        """静的ファイル配信（/ → index_v2.html にリダイレクト）"""
        if self.path == '/' or self.path == '/index.html':
            self.path = '/index_v2.html'
        super().do_GET()

    def do_POST(self):
        if self.path == '/api/chat':
            self.handle_chat()
        else:
            self.send_error(404)

    def handle_chat(self):
        try:
            # リクエスト読み取り
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length) if length else b'{}'
            body = json.loads(raw)

            messages = body.get('messages', [])
            if not messages:
                self._send_json(400, {'error': 'messages required'})
                return

            # OpenAI API 呼び出し
            payload = json.dumps({
                'model': MODEL,
                'messages': messages,
                'temperature': 0.7,
                'max_tokens': 4000,
                'response_format': { 'type': 'json_object' },
            }).encode('utf-8')

            req = urllib.request.Request(
                OPENAI_URL,
                data=payload,
                headers={
                    'Content-Type': 'application/json',
                    'Authorization': f'Bearer {OPENAI_API_KEY}',
                },
                method='POST',
            )

            with urllib.request.urlopen(req, timeout=120) as resp:
                result = json.loads(resp.read().decode('utf-8'))
                reply = result['choices'][0]['message']['content']
                # デバッグ: AIのレスポンス構造をログに出力
                try:
                    parsed = json.loads(reply)
                    has_related = 'relatedUpdates' in parsed
                    related_count = len(parsed.get('relatedUpdates', []))
                    related_aspects = [ru.get('aspect', '?') for ru in parsed.get('relatedUpdates', [])]
                    print(f'[AI Response] relatedUpdates: {has_related}, count: {related_count}, aspects: {related_aspects}')
                    if parsed.get('aspectUpdate'):
                        au = parsed['aspectUpdate']
                        print(f'[AI Response] aspectUpdate: aspect={au.get("aspect")}, status={au.get("status")}')
                except Exception:
                    print(f'[AI Response] JSON parse failed, raw length: {len(reply)}')
                self._send_json(200, {
                    'reply': reply,
                    'model': result.get('model', MODEL),
                    'usage': result.get('usage', {}),
                })

        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8') if e.fp else str(e)
            print(f'[OpenAI Error] {e.code}: {error_body}')
            self._send_json(e.code, {'error': f'OpenAI API error: {e.code}', 'detail': error_body})
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f'[Server Error] {e}')
            self._send_json(500, {'error': str(e)})

    def _send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # GETリクエスト（静的ファイル）にもCORSヘッダーを追加
        # ただし重複を防ぐため、すでにセットされていないか確認
        # SimpleHTTPRequestHandler は _headers_buffer を使う
        buf = getattr(self, '_headers_buffer', [])
        has_cors = any(b'Access-Control-Allow-Origin' in line for line in buf)
        if not has_cors:
            self._send_cors_headers()
        super().end_headers()


if __name__ == '__main__':
    PORT = 8888
    print(f'[PdM Server] Starting on http://localhost:{PORT}')
    print(f'[PdM Server] API Key: {"✓ loaded" if OPENAI_API_KEY else "✗ MISSING"}')
    server = http.server.HTTPServer(('', PORT), APIHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n[PdM Server] Stopped')
