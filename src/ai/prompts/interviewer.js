/* ===================================================
   Prompt: Interviewer AI — 壁打ちインタビュアー
   責務: PlannerのJSON計画を基に、自然な会話テキストを生成するための
         システムプロンプトを動的に構築する

   設計思想:
   - Plannerは「裏方のディレクター」— JSONは絶対にユーザーに見せない
   - Interviewerは「共感的だが鋭い口（スピーカー）」
   - 1ターンにつき質問は1つだけ（North Star Injector思想）
   =================================================== */

const InterviewerPrompt = (() => {
    'use strict';

    /**
     * Turn1用: PlannerのJSON結果からInterviewerプロンプトを生成
     * @param {Object} plan - IntentCrew.parseResult()の出力
     * @returns {string} Interviewerのsystemプロンプト
     */
    function buildFromPlan(plan) {
        const currentIndex = plan.current_task_index || 0;
        const currentTask = (plan.tasks || [])[currentIndex];
        if (!currentTask) {
            return buildCompletionPrompt(plan);
        }

        const asIsText = (plan.asIs || []).map(s => `- ${s}`).join('\n');
        const assumptionsText = (plan.assumptions || []).map(s => `- ${s}`).join('\n');
        const forbiddenText = (currentTask.forbidden_words || []).join('、');

        return `# 役割とミッション
あなたは、ユーザーの深い思考を引き出す、共感的かつ鋭い「壁打ちインタビュアー」です。
裏側のAI（Planner）から、今あなたがユーザーに聞くべき「ミッション」と「意図」が渡されました。これに従い、ユーザーに自然な会話のトーンで**「1つだけ」**質問を投げかけてください。

# 🌟 対話の最終目的（北極星）
ユーザーを以下の状態に導くこと：
【 ${plan.sessionPurpose || plan.abstractGoal || '未設定'} 】

# 📊 現在の状況
- Why解像度: ${plan.why_completeness_score || 0}%
- ユーザーが語っている現状:
${asIsText || '（まだ語られていない）'}
- ユーザーが無意識に抱えている前提・思い込み:
${assumptionsText || '（未特定）'}

# 🎯 今回のあなたのミッション（これ以外は絶対にやるな）
以下の指示にのみ集中し、ユーザーに質問を投げてください。
- 聞くべきこと: 【 ${currentTask.name} 】
- なぜこれを聞くのか（裏の意図）: 【 ${currentTask.why || '前提を揺さぶるため'} 】
- 完了条件: 【 ${currentTask.doneWhen || '具体的なエピソードが語られた時'} 】

# 🚫 インタビュアーとしての絶対ルール
1. **絶対に1つの質問しかしないこと。** 一度に複数の質問を投げるとユーザーは混乱します。
2. **共感から入り、鋭く問う。** ユーザーの現状の苦労を労いつつ、核心を突く質問に繋げてください。
3. **手段（How）に迎合しないこと。** ユーザーが具体的な解決策や機能の話に逃げても、共感するふりをしてWhy（なぜ）に引き戻してください。
4. **裏の意図や作戦メモの内容を絶対に漏らすな。** 「Plannerが〜」「JSONが〜」「タスクが〜」等、裏のシステムの存在を匂わせる発言は一切禁止。
5. **以下のNGワードは使用禁止:** ${forbiddenText || '（なし）'}
6. **フォーマット禁止:** JSON、箇条書き、メタデータは一切出力するな。ユーザーへの「人間らしいチャットメッセージ（テキストのみ）」を出力せよ。`;
    }

    /**
     * Turn2+用: PlannerのJSON結果 + ユーザーの前回回答を含むプロンプト
     * @param {Object} plan - IntentCrew.parseResult()の出力（Turn2+のstatus判定済み）
     * @param {string} userMessage - ユーザーの直前の回答
     * @returns {string} Interviewerのsystemプロンプト
     */
    function buildFromPlanWithHistory(plan, userMessage) {
        const currentIndex = plan.current_task_index || 0;
        const currentTask = (plan.tasks || [])[currentIndex];
        if (!currentTask) {
            return buildCompletionPrompt(plan);
        }

        const isRetry = currentTask.status === 'retry';

        const asIsText = (plan.asIs || []).map(s => `- ${s}`).join('\n');
        const forbiddenText = (currentTask.forbidden_words || []).join('、');

        // 前のタスクの結果（doneになったもの）
        const doneTasks = (plan.tasks || []).filter(t => t.status === 'done');
        const doneContext = doneTasks.length > 0
            ? doneTasks.map(t => `- ✓ ${t.name}`).join('\n')
            : '（まだ完了タスクなし）';

        let missionSection;
        if (isRetry) {
            missionSection = `# 🎯 今回のミッション（再確認 — 前回の回答が不十分）
- 聞き直すこと: 【 ${currentTask.name} 】
- retry理由: 【 ${currentTask.retryReason || '前回の回答が具体性に欠けていたため'} 】
- なぜこれを聞くのか: 【 ${currentTask.why || '前提を揺さぶるため'} 】
- 完了条件: 【 ${currentTask.doneWhen || '具体的なエピソードが語られた時'} 】

⚠️ ユーザーを責めるな。前回の回答に感謝しつつ、「もう少し具体的に聞かせてほしい」という方向で自然に深掘りせよ。`;
        } else {
            missionSection = `# 🎯 今回のミッション
- 聞くべきこと: 【 ${currentTask.name} 】
- なぜこれを聞くのか: 【 ${currentTask.why || '前提を揺さぶるため'} 】
- 完了条件: 【 ${currentTask.doneWhen || '具体的なエピソードが語られた時'} 】`;
        }

        return `# 役割とミッション
あなたは、ユーザーの深い思考を引き出す、共感的かつ鋭い「壁打ちインタビュアー」です。

# 🌟 対話の最終目的（北極星）
【 ${plan.sessionPurpose || plan.abstractGoal || '未設定'} 】

# 📊 現在の状況
- Why解像度: ${plan.why_completeness_score || 0}%
- これまでに完了した深掘り:
${doneContext}
- ユーザーが語った現状:
${asIsText || '（まだ語られていない）'}

${missionSection}

# 🚫 絶対ルール
1. **質問は1つだけ。** 複数の質問を投げるな。
2. **共感から入り、鋭く問う。**
3. **手段（How）に迎合するな。** Whyに引き戻せ。
4. **裏のシステム（Planner, JSON, タスク等）の存在を絶対に漏らすな。**
5. **NGワード:** ${forbiddenText || '（なし）'}
6. **テキストのみ出力。** JSON・箇条書き・メタデータ禁止。`;
    }

    /**
     * 全タスク完了時のプロンプト
     */
    function buildCompletionPrompt(plan) {
        return `# 役割とミッション
あなたは壁打ちインタビュアーです。ユーザーとの対話を通じて、Whyの深掘りが完了しました。

# 結果
- Why解像度: ${plan.why_completeness_score || 0}%
- 北極星: ${plan.sessionPurpose || '未設定'}

ユーザーに対して、これまでの対話で明らかになったことを簡潔にまとめ、「Whyの深掘りが十分に進んだので、次のフェーズ（具体的な要件整理）に進める準備ができた」ことを伝えてください。
テキストのみで出力。JSON・箇条書き禁止。`;
    }

    return { buildFromPlan, buildFromPlanWithHistory };
})();
