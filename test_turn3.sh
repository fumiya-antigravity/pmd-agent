#!/bin/bash
BASE="https://pmd-agent.vercel.app"

run_test() {
    local label=$1
    echo ""
    echo "=========================================="
    echo "テスト: $label"
    echo "=========================================="
    
    local sid=$(curl -s "$BASE/api/session" -X POST -H "Content-Type: application/json" | python3 -c "import json,sys; print(json.load(sys.stdin)['session_id'])")
    echo "Session: $sid"
    
    # Turn 0
    echo "--- Turn 0 (User: 壁打ちAIを作りたい) ---"
    local r0=$(curl -s "$BASE/api/process" -X POST -H "Content-Type: application/json" -d "{\"session_id\":\"$sid\",\"user_message\":\"私専用の壁打ちするAIエージェントを作りたい。\"}")
    local q0=$(echo $r0 | python3 -c "import json,sys; print(json.load(sys.stdin)['message'])")
    local dim0=$(echo $r0 | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('debug',{}).get('current_focus',{}).get('dimension','?'))" 2>/dev/null)
    echo "AI: $q0 [dim=$dim0]"
    
    # Turn 1
    echo "--- Turn 1 (User: Whyを壁打ちしまくりたい) ---"
    local r1=$(curl -s "$BASE/api/process" -X POST -H "Content-Type: application/json" -d "{\"session_id\":\"$sid\",\"user_message\":\"Whyを壁打ちしまくりたいんだよね\"}")
    local q1=$(echo $r1 | python3 -c "import json,sys; print(json.load(sys.stdin)['message'])")
    local dim1=$(echo $r1 | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('debug',{}).get('current_focus',{}).get('dimension','?'))" 2>/dev/null)
    echo "AI: $q1 [dim=$dim1]"
    
    # Turn 2
    echo "--- Turn 2 (User: 詳細説明) ---"
    local r2=$(curl -s "$BASE/api/process" -X POST -H "Content-Type: application/json" -d "{\"session_id\":\"$sid\",\"user_message\":\"要件定義を作るときに、Howから入っちゃって本来作る目的やなぜ作るのかを正しく言語化できない場合があるから、それを防ぐようにやり取りができるAIを作りたいんだよね\"}")
    local q2=$(echo $r2 | python3 -c "import json,sys; print(json.load(sys.stdin)['message'])")
    local mgu2=$(echo $r2 | python3 -c "import json,sys; print(json.load(sys.stdin)['debug']['mgu'])")
    local dim2=$(echo $r2 | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('debug',{}).get('current_focus',{}).get('dimension','?'))" 2>/dev/null)
    local five_w=$(echo $r2 | python3 -c "import json,sys; d=json.load(sys.stdin); fw=d.get('debug',{}).get('five_w_status',{}); print(fw)" 2>/dev/null)
    echo "AI: $q2 [MGU=$mgu2, dim=$dim2]"
    echo "5W: $five_w"
    
    # Turn 3
    echo "--- Turn 3 (User: はい) ---"
    local r3=$(curl -s "$BASE/api/process" -X POST -H "Content-Type: application/json" -d "{\"session_id\":\"$sid\",\"user_message\":\"はい、そうです\"}")
    local q3=$(echo $r3 | python3 -c "import json,sys; print(json.load(sys.stdin)['message'])")
    local mgu3=$(echo $r3 | python3 -c "import json,sys; print(json.load(sys.stdin)['debug']['mgu'])")
    local dim3=$(echo $r3 | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('debug',{}).get('current_focus',{}).get('dimension','?'))" 2>/dev/null)
    local five_w3=$(echo $r3 | python3 -c "import json,sys; d=json.load(sys.stdin); fw=d.get('debug',{}).get('five_w_status',{}); print(fw)" 2>/dev/null)
    echo "AI: $q3 [MGU=$mgu3, dim=$dim3]"
    echo "5W: $five_w3"
    
    # Turn 4 
    echo "--- Turn 4 (User: 自分一人で使う) ---"
    local r4=$(curl -s "$BASE/api/process" -X POST -H "Content-Type: application/json" -d "{\"session_id\":\"$sid\",\"user_message\":\"自分一人で使う想定だよ。PdMとして企画を考えるときに使いたい\"}")
    local q4=$(echo $r4 | python3 -c "import json,sys; print(json.load(sys.stdin)['message'])")
    local mgu4=$(echo $r4 | python3 -c "import json,sys; print(json.load(sys.stdin)['debug']['mgu'])")
    local dim4=$(echo $r4 | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('debug',{}).get('current_focus',{}).get('dimension','?'))" 2>/dev/null)
    local five_w4=$(echo $r4 | python3 -c "import json,sys; d=json.load(sys.stdin); fw=d.get('debug',{}).get('five_w_status',{}); print(fw)" 2>/dev/null)
    echo "AI: $q4 [MGU=$mgu4, dim=$dim4]"
    echo "5W: $five_w4"
}

run_test "セッション1"
run_test "セッション2"
run_test "セッション3"
