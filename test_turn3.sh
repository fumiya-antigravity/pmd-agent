#!/bin/bash
# Turn 3質問パターンテスト
BASE="https://pmd-agent.vercel.app"

run_test() {
    local label=$1
    echo ""
    echo "=========================================="
    echo "テスト: $label"
    echo "=========================================="
    
    # セッション作成
    local sid=$(curl -s "$BASE/api/session" -X POST -H "Content-Type: application/json" | python3 -c "import json,sys; print(json.load(sys.stdin)['session_id'])")
    echo "Session: $sid"
    
    # Turn 0
    echo "--- Turn 0 ---"
    local r0=$(curl -s "$BASE/api/process" -X POST -H "Content-Type: application/json" -d "{\"session_id\":\"$sid\",\"user_message\":\"私専用の壁打ちするAIエージェントを作りたい。\"}")
    echo "AI: $(echo $r0 | python3 -c "import json,sys; print(json.load(sys.stdin)['message'])")"
    
    # Turn 1
    echo "--- Turn 1 ---"
    local r1=$(curl -s "$BASE/api/process" -X POST -H "Content-Type: application/json" -d "{\"session_id\":\"$sid\",\"user_message\":\"Whyを壁打ちしまくりたいんだよね\"}")
    echo "AI: $(echo $r1 | python3 -c "import json,sys; print(json.load(sys.stdin)['message'])")"
    
    # Turn 2
    echo "--- Turn 2 ---"
    local r2=$(curl -s "$BASE/api/process" -X POST -H "Content-Type: application/json" -d "{\"session_id\":\"$sid\",\"user_message\":\"要件定義を作るときに、Howから入っちゃって本来作る目的やなぜ作るのかを正しく言語化できない場合があるから、それを防ぐようにやり取りができるAIを作りたいんだよね\"}")
    echo "AI: $(echo $r2 | python3 -c "import json,sys; print(json.load(sys.stdin)['message'])")"
    local mgu2=$(echo $r2 | python3 -c "import json,sys; print(json.load(sys.stdin)['debug']['mgu'])")
    echo "MGU: $mgu2"
    
    # Turn 3
    echo "--- Turn 3 (検証対象) ---"
    local r3=$(curl -s "$BASE/api/process" -X POST -H "Content-Type: application/json" -d "{\"session_id\":\"$sid\",\"user_message\":\"はい、そうです\"}")
    echo "AI: $(echo $r3 | python3 -c "import json,sys; print(json.load(sys.stdin)['message'])")"
    local mgu3=$(echo $r3 | python3 -c "import json,sys; print(json.load(sys.stdin)['debug']['mgu'])")
    local layer=$(echo $r3 | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('debug',{}).get('current_focus',{}).get('layer','?'))")
    local next_q=$(echo $r3 | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('debug',{}).get('current_focus',{}).get('next_question','?'))")
    echo "MGU: $mgu3 | Layer: $layer"
    echo "Planner next_question: $next_q"
}

run_test "セッション1"
run_test "セッション2" 
run_test "セッション3"
