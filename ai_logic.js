/* ===================================================
   PdM Assistant - Mock AI Logic Engine
   ai_logic.js
   ===================================================
   設計方針:
   - チェックは超厳しく
   - FBの言い方は優しく、的を得た一貫性のある形で
   - 初期入力は「概要 + Why」のみ
   - AIが段階的に観点を抽出・構造化してユーザーに提案
   =================================================== */

const AILogic = (() => {

    // --- 5つのベース観点（固定） ---
    const BASE_ASPECTS = {
        background: { label: '背景・前提', emoji: '🔍', guide: 'この取り組みに至った経緯・前提条件' },
        problem: { label: '課題', emoji: '⚠️', guide: '現状の具体的な問題点' },
        target: { label: 'ターゲット', emoji: '🎯', guide: '誰の課題を解決するのか' },
        impact: { label: '期待する効果', emoji: '✨', guide: '解決するとどうなるか（定量・定性）' },
        urgency: { label: 'なぜ今やるか', emoji: '⏰', guide: '今やらないとどうなるか' },
    };

    // --- 可変観点（入力から動的に追加される） ---
    let dynamicAspects = {};

    // --- 統合された観点（BASE + 動的） ---
    function getAspects() {
        return { ...BASE_ASPECTS, ...dynamicAspects };
    }

    // 外部から参照用（後方互換）
    const ASPECTS = new Proxy({}, {
        get: (_, prop) => getAspects()[prop],
        ownKeys: () => Object.keys(getAspects()),
        has: (_, prop) => prop in getAspects(),
        getOwnPropertyDescriptor: (_, prop) => {
            if (prop in getAspects()) return { configurable: true, enumerable: true, value: getAspects()[prop] };
        },
    });

    // --- キーワード辞書 ---
    const HOW_KEYWORDS = ['実装', 'API', '技術', 'ツール', '設計', 'フレームワーク', 'DB', 'サーバー', 'コード', 'プログラム', 'アーキテクチャ', 'インフラ', 'デプロイ', 'ライブラリ', 'React', 'Python', 'JavaScript'];
    const WHAT_KEYWORDS = ['機能', '画面', 'ボタン', 'フォーム', 'ダッシュボード', 'レポート', 'ページ', 'UI', 'インターフェース', 'メニュー', 'モーダル', 'テーブル'];

    // --- 深掘り質問テンプレート ---
    const DEEP_QUESTIONS = {
        background: [
            'この背景がいつ頃から存在していたか、もう少し教えていただけますか？最近になって顕在化したきっかけはありますか？',
            'この前提は社内固有のものですか？それとも業界全体の傾向ですか？',
        ],
        problem: [
            'この課題は、日常業務のどの場面で特に強く感じますか？具体的なエピソードがあれば教えてください。',
            'この課題による損失を数字で表すとしたら、どのくらいになりそうですか？（時間・コスト・品質など）',
        ],
        target: [
            'そのターゲットは現在、この課題にどう対処していますか？代替手段はありますか？',
            'ターゲットの人数規模と、今後増減する見込みを教えてください。',
        ],
        impact: [
            '効果を測定するとしたら、どんな指標（KPI）で測りますか？',
            'この効果が実現した場合、組織全体にどんな波及効果がありますか？',
        ],
        urgency: [
            '具体的に、いつまでに成果が必要ですか？その期限の理由は何ですか？',
            'もし半年後にスタートした場合、何が変わりますか？',
        ],
    };

    // --- 状態管理 ---
    let discussedAspects = new Set();
    let questionIndex = {};

    function reset() {
        discussedAspects = new Set();
        questionIndex = {};
        dynamicAspects = {};
    }

    // --- 動的観点の追加 ---
    function addDynamicAspect(key, label, emoji, guide) {
        dynamicAspects[key] = { label, emoji: emoji || '📌', guide: guide || '' };
    }

    function removeDynamicAspect(key) {
        delete dynamicAspects[key];
    }

    function getDynamicAspectKeys() {
        return Object.keys(dynamicAspects);
    }

    // ==========================================================
    // 初期分析：ユーザーのWhyから観点を抽出
    // ==========================================================
    function analyzeInitialInput(overview, whyText) {
        const result = {
            summary: '',
            extractedAspects: {},
            missingAspects: [],
            contamination: null,
            messages: [],
        };

        // --- コンタミチェック ---
        const contam = detectContamination(whyText + ' ' + overview);
        if (contam.hasContamination) {
            result.contamination = contam;
        }

        // --- 観点の自動抽出（簡易ルールベース） ---
        const extracted = {};
        const missing = [];

        // 背景: 「〜ている」「〜になった」「〜の中で」等の状況描写
        const bgPatterns = ['ている', 'になった', 'が増え', 'が進', '背景', '前提', '経緯', '状況', '環境'];
        const bgMatch = findMatchingSentences(whyText, bgPatterns);
        if (bgMatch) extracted.background = bgMatch;
        else missing.push('background');

        // 課題: 「問題」「困って」「できない」「課題」「バラバラ」「非効率」
        const probPatterns = ['問題', '困', 'できない', '課題', 'バラバラ', '非効率', '負担', 'コスト', '時間がかか', '属人', '品質', 'ミス', '不足'];
        const probMatch = findMatchingSentences(whyText, probPatterns);
        if (probMatch) extracted.problem = probMatch;
        else missing.push('problem');

        // ターゲット: 「メンバー」「ユーザー」「チーム」「顧客」等の人物
        const trgPatterns = ['メンバー', 'ユーザー', 'チーム', '顧客', '社員', 'PdM', 'PM', 'ディレクター', 'ジュニア', 'シニア', '初心者', 'ベテラン', '新人', '担当者'];
        const trgMatch = findMatchingSentences(whyText, trgPatterns);
        if (trgMatch) extracted.target = trgMatch;
        else missing.push('target');

        // 効果: 「削減」「向上」「改善」「効率」「品質」
        const impPatterns = ['削減', '向上', '改善', '効率', '実現', '解決', '短縮', '自動化'];
        const impMatch = findMatchingSentences(whyText, impPatterns);
        if (impMatch) extracted.impact = impMatch;
        else missing.push('impact');

        // 緊急性: 「今」「すぐ」「Q1」「Q2」「期限」「急」
        const urgPatterns = ['今', 'すぐ', '急', '期限', 'Q1', 'Q2', 'Q3', 'Q4', '来月', '来期', '必要'];
        const urgMatch = findMatchingSentences(whyText, urgPatterns);
        if (urgMatch) extracted.urgency = urgMatch;
        else missing.push('urgency');

        result.extractedAspects = extracted;
        result.missingAspects = missing;

        // --- 要約生成 ---
        result.summary = generateSummaryHtml(overview, extracted, missing, contam);

        // --- チャットメッセージ ---
        result.messages = generateInitialMessages(overview, extracted, missing, contam);

        return result;
    }

    // ==========================================================
    // 要約HTMLを生成
    // ==========================================================
    function generateSummaryHtml(overview, extracted, missing, contam) {
        let html = '<div class="summary-doc">';

        html += '<h4>📋 プロジェクト概要</h4>';
        html += `<div class="summary-highlight">${esc(overview)}</div>`;

        html += '<h4>🔎 入力内容からの整理</h4>';

        const extractedKeys = Object.keys(extracted);
        if (extractedKeys.length > 0) {
            // ナラティブ
            let narrative = '';
            if (extracted.background) narrative += `${extracted.background} `;
            if (extracted.problem) narrative += `課題として「${extracted.problem}」があり、`;
            if (extracted.target) narrative += `${extracted.target}を対象に、`;
            narrative += `${overview}を目指すプロジェクトです。`;
            html += `<p>${esc(narrative)}</p>`;
        }

        html += '<h4>📊 観点の網羅度</h4>';
        for (const [key, info] of Object.entries(ASPECTS)) {
            const hasIt = extracted[key];
            let tag = '';
            if (hasIt) {
                tag = '<span class="gap-tag good">✓ 抽出済み</span>';
            } else {
                tag = '<span class="gap-tag missing">未検出</span>';
            }
            html += `<p>${info.emoji} <strong>${info.label}</strong> ${tag}</p>`;
            if (hasIt) html += `<div class="summary-highlight">${esc(hasIt)}</div>`;
        }

        if (contam && contam.hasContamination) {
            html += '<h4>⚠️ 注意</h4>';
            if (contam.howMatches.length > 0) html += `<p style="color:var(--accent-warning);">How表現: 「${contam.howMatches.join('」「')}」</p>`;
            if (contam.whatMatches.length > 0) html += `<p style="color:var(--accent-warning);">What表現: 「${contam.whatMatches.join('」「')}」</p>`;
        }

        html += '</div>';
        return html;
    }

    // ==========================================================
    // 初期メッセージ生成（厳格チェック + やさしい言い方）
    // ==========================================================
    function generateInitialMessages(overview, extracted, missing, contam) {
        const msgs = [];

        // ① 挨拶 + まとめ
        const extractedCount = Object.keys(extracted).length;
        msgs.push({
            role: 'ai', type: 'greeting',
            content: `ありがとうございます！入力内容を分析しました。\n\n上のパネルに要約を表示しています。5つの観点のうち **${extractedCount}つ** を読み取れました。`,
        });

        // ② コンタミ指摘（厳格だが優しく）
        if (contam && contam.hasContamination) {
            let msg = '💡 一つ、大事なポイントをお伝えしますね。\n\n';
            if (contam.howMatches.length > 0) {
                msg += `入力の中に「${contam.howMatches.join('」「')}」という表現がありました。これは**「どう作るか（How）」**の話になっています。\n\n`;
            }
            if (contam.whatMatches.length > 0) {
                msg += `「${contam.whatMatches.join('」「')}」は**「何を作るか（What）」**の領域です。\n\n`;
            }
            msg += 'ここではまだHowやWhatは考えなくて大丈夫です。まずは**「なぜそれが必要なのか」**だけに集中しましょう。後のフェーズで必ずHowとWhatも整理しますので、安心してください 😊';
            msgs.push({ role: 'ai', type: 'warning', content: msg });
        }

        // ③ 検出済みの観点にポジティブFB
        if (extractedCount > 0) {
            const labels = Object.keys(extracted).map(k => `**${ASPECTS[k].label}**`).join('、');
            msgs.push({
                role: 'ai', type: 'feedback',
                content: `✅ ${labels}の観点が読み取れました！いい出発点ですね。\n\nここから一つずつ深掘りしていきましょう。`,
            });
        }

        // ④ 不足観点へのガイド（最初の1つだけ聞く）
        if (missing.length > 0) {
            const firstMissing = missing[0];
            const info = ASPECTS[firstMissing];
            let prompt = '';

            switch (firstMissing) {
                case 'background':
                    prompt = 'まず、**背景から整理してみましょう。**\n\nこのプロジェクトを考え始めたきっかけは何ですか？組織内で何が起きていて、このアイデアに至ったのか、教えてください。';
                    break;
                case 'problem':
                    prompt = '次に、**課題を明確にしましょう。**\n\n今まさに困っていることは何ですか？「〇〇ができない」「〇〇に時間がかかりすぎる」のように、具体的に教えてください。';
                    break;
                case 'target':
                    prompt = '**誰のための取り組みなのか**を明確にしましょう。\n\nこの課題に一番困っている人は誰ですか？また、なぜその人たちが最優先なのですか？';
                    break;
                case 'impact':
                    prompt = '**期待する効果**を整理しましょう。\n\nこの課題が解決されたら、具体的に何がどう変わりますか？数字で表せると、より説得力が増します。';
                    break;
                case 'urgency':
                    prompt = '最後に、**なぜ今やる必要があるのか**を教えてください。\n\n半年後ではなく今始める理由は何ですか？待つことで失われるものはありますか？';
                    break;
            }

            msgs.push({ role: 'ai', type: 'question', content: prompt, targetAspect: firstMissing });
        } else {
            // 全部検出されても、深掘りが必要
            msgs.push({
                role: 'ai', type: 'question',
                content: '素晴らしい！全ての観点が含まれていますね。\n\nただ、それぞれの解像度をもう少し上げていきましょう。どの観点から深掘りしますか？',
                targetAspect: null,
            });
            msgs.push({
                role: 'ai', type: 'chips',
                content: '',
                chips: Object.entries(ASPECTS).map(([k, v]) => ({ label: `${v.emoji} ${v.label}`, field: k })),
            });
        }

        return msgs;
    }

    // ==========================================================
    // ユーザー回答を分析して、観点カード提案 + 次の質問
    // ==========================================================
    function processResponse(userMessage, currentAspect, extractedAspects) {
        const msgs = [];

        // --- コンタミチェック（厳格） ---
        const contam = detectContamination(userMessage);
        if (contam.hasContamination) {
            let msg = '💡 ちょっと待ってくださいね。\n\n';
            if (contam.howMatches.length > 0) {
                msg += `「${contam.howMatches.join('」「')}」は**How（どう作るか）**の話です。`;
            }
            if (contam.whatMatches.length > 0) {
                msg += `「${contam.whatMatches.join('」「')}」は**What（何を作るか）**の話です。`;
            }
            msg += '\n\nとても良い発想だと思いますが、それは後のフェーズでしっかり整理します。今は**「なぜ？」**だけに集中しましょう。\n\n書き直すとしたら、「〇〇という__課題__があるから」「〇〇を__解決__するために」のように、動機を中心に書いてみてください。';
            msgs.push({ role: 'ai', type: 'warning', content: msg });
        }

        // --- 回答の質チェック（厳格だが優しく） ---
        const trimmed = userMessage.trim();
        if (trimmed.length < 15) {
            msgs.push({
                role: 'ai', type: 'feedback',
                content: `ありがとうございます！ただ、もう少し具体的に聞かせていただけますか？\n\n例えば「${getExamplePrompt(currentAspect)}」のように、具体的な状況やエピソードを交えていただけると、Whyの解像度がグッと上がります 📝`,
            });
            return { msgs, suggestion: null };
        }

        // --- 観点カード提案を生成 ---
        let suggestion = null;
        if (currentAspect && !contam.hasContamination) {
            // クリーンな入力 → 提案を生成
            suggestion = {
                aspect: currentAspect,
                text: cleanForAspect(userMessage, currentAspect),
            };

            const label = ASPECTS[currentAspect].label;
            msgs.push({
                role: 'ai', type: 'feedback',
                content: `いいですね！👏\n\n「**${label}**」として左パネルに整理しました。内容を確認して、必要に応じて編集してください。`,
            });

            discussedAspects.add(currentAspect);
        }

        // --- 次の未解決観点を聞く ---
        const allAspectKeys = Object.keys(ASPECTS);
        const resolvedKeys = new Set([...Object.keys(extractedAspects), ...discussedAspects]);
        const remaining = allAspectKeys.filter(k => !resolvedKeys.has(k));

        if (remaining.length > 0) {
            const next = remaining[0];
            const nextInfo = ASPECTS[next];
            const q = getContextualQuestion(next, extractedAspects);
            msgs.push({
                role: 'ai', type: 'question',
                content: q,
                targetAspect: next,
            });
        } else {
            // 全観点カバー済み → 深掘りフェーズへ
            msgs.push({
                role: 'ai', type: 'feedback',
                content: '素晴らしい！5つの観点がすべて揃いました 🎉\n\nここから各観点の**解像度を上げていきましょう**。気になる観点を選んでください。',
            });
            msgs.push({
                role: 'ai', type: 'chips',
                content: '',
                chips: allAspectKeys.map(k => ({ label: `${ASPECTS[k].emoji} ${ASPECTS[k].label}を深掘り`, field: k })),
            });
        }

        return { msgs, suggestion };
    }

    // --- 観点に応じた文脈的質問 ---
    function getContextualQuestion(aspect, existing) {
        switch (aspect) {
            case 'background':
                return 'では、**背景**を教えてください。\n\nこの取り組みを思いついたきっかけは何ですか？組織で何が変化しましたか？';
            case 'problem': {
                const bg = existing.background ? `「${existing.background.slice(0, 30)}…」という背景があるとのことですが、` : '';
                return `${bg}**具体的な課題**は何ですか？\n\n「何がうまくいっていないのか」を、できるだけ具体的に教えてください。`;
            }
            case 'target': {
                const prob = existing.problem ? `その課題に` : '今回の取り組みで';
                return `${prob}**一番困っている人**は誰ですか？\n\nなぜその人たちを最優先にするのかも、あわせて教えてください。`;
            }
            case 'impact':
                return '課題が解決されたら、**具体的に何がどう変わりますか？**\n\n「〇〇が△△分短縮される」「〇〇の質が向上する」のように、できれば数字を交えて教えてください。';
            case 'urgency':
                return '最後に、**なぜ「今」やる必要があるのですか？**\n\n半年待ったらどうなるか、外部環境の変化が迫っていないか、考えてみてください。';
            default:
                return `${ASPECTS[aspect].label}について教えてください。`;
        }
    }

    // --- 深掘りモード ---
    function deepDive(userMessage, aspect, currentText) {
        const msgs = [];

        const contam = detectContamination(userMessage);
        if (contam.hasContamination) {
            msgs.push({
                role: 'ai', type: 'warning',
                content: `💡 今の回答の中にHowまたはWhatの要素が含まれていました（「${[...contam.howMatches, ...contam.whatMatches].join('」「')}」）。\n\nWhyの深掘りでは「なぜそうなのか？」に集中しましょう。`,
            });
        }

        // 深掘り質問を出す
        if (!questionIndex[aspect]) questionIndex[aspect] = 0;
        const questions = DEEP_QUESTIONS[aspect];
        if (questions && questionIndex[aspect] < questions.length) {
            msgs.push({
                role: 'ai', type: 'question',
                content: questions[questionIndex[aspect]],
                targetAspect: aspect,
            });
            questionIndex[aspect]++;
        } else {
            msgs.push({
                role: 'ai', type: 'feedback',
                content: `「${ASPECTS[aspect].label}」についてしっかり深掘りできました！👏\n\n左のカードを更新して、他の観点も深掘りしてみましょう。`,
            });
            msgs.push({
                role: 'ai', type: 'chips', content: '',
                chips: Object.keys(ASPECTS).filter(k => k !== aspect).map(k => ({
                    label: `${ASPECTS[k].emoji} ${ASPECTS[k].label}`, field: k,
                })),
            });
        }

        // 改善提案
        let suggestion = null;
        if (!contam.hasContamination && userMessage.trim().length >= 15) {
            suggestion = {
                aspect,
                text: (currentText ? currentText + '\n\n' : '') + userMessage.trim(),
            };
        }

        return { msgs, suggestion };
    }

    // ==========================================================
    // 観点チェック（診断用 — 確定ではなく改善ガイド）
    // ==========================================================
    function evaluateWhy(aspects) {
        const msgs = [];
        const issues = [];
        const goods = [];
        const allAspects = getAspects();

        for (const [key, info] of Object.entries(allAspects)) {
            const text = aspects[key] || '';
            const len = text.trim().length;

            if (len === 0) {
                issues.push(`${info.emoji} 「${info.label}」がまだ空です。この観点が抜けると、Why全体の説得力が下がってしまいます。`);
            } else if (len < 30) {
                issues.push(`${info.emoji} 「${info.label}」がまだ薄いです（${len}文字）。ステークホルダーを納得させるには、もう少し具体性が必要です。`);
            } else {
                goods.push(`${info.emoji} 「${info.label}」: OK`);
            }

            const { hasContamination, howMatches, whatMatches } = detectContamination(text);
            if (hasContamination) {
                issues.push(`${info.emoji} 「${info.label}」にHowまたはWhatの表現（「${[...howMatches, ...whatMatches].join('」「')}」）が残っています。Whyとして書き直してみましょう。`);
            }
        }

        // 動的に発見された追加観点の提案
        const dynamicSuggestions = suggestAdditionalAspects(aspects);

        if (issues.length > 0) {
            let content = `🔍 **観点チェック結果**\n\n`;
            if (goods.length > 0) content += `✅ OK: ${goods.length}個\n`;
            content += `⚠️ 改善が必要: ${issues.length}個\n\n${issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n\n')}\n\n一つずつ改善していきましょう！壁打ちを続けて大丈夫です 💪`;
            msgs.push({ role: 'ai', type: 'feedback', content });
        } else {
            let content = `🎉 **観点チェック: 全項目OK！**\n\n${goods.length}個すべての観点が十分な内容です。\nさらに深掘りしたい観点があれば選択して壁打ちを続けてください。`;
            if (dynamicSuggestions.length > 0) {
                content += `\n\n💡 追加で検討すると良い観点:\n${dynamicSuggestions.map(s => `• ${s.emoji} **${s.label}**: ${s.guide}`).join('\n')}`;
            }
            content += `\n\n準備ができたら次のステップに進めます。`;
            msgs.push({ role: 'ai', type: 'feedback', content });
        }

        // チェック結果を返す（approvedは参考情報）
        const approved = issues.length === 0;
        return { msgs, approved, issues, goods, dynamicSuggestions };
    }

    // --- 追加観点を動的に提案 ---
    function suggestAdditionalAspects(aspects) {
        const suggestions = [];
        const allText = Object.values(aspects).filter(Boolean).join(' ');

        // 競合・市場に言及があれば「競合分析」を提案
        if (['競合', '他社', '市場', 'シェア', 'マーケット'].some(w => allText.includes(w))) {
            if (!dynamicAspects.competition) {
                suggestions.push({ key: 'competition', label: '競合環境', emoji: '🏁', guide: '競合と比較した差別化ポイント' });
            }
        }
        // リスクに言及があれば「リスク」を提案
        if (['リスク', '失敗', '懸念', '不安', '障壁'].some(w => allText.includes(w))) {
            if (!dynamicAspects.risk) {
                suggestions.push({ key: 'risk', label: 'リスク', emoji: '⚡', guide: '想定されるリスクとその対策' });
            }
        }
        // ステークホルダーに言及
        if (['経営', '上司', '幹部', 'ステークホルダー', '承認'].some(w => allText.includes(w))) {
            if (!dynamicAspects.stakeholder) {
                suggestions.push({ key: 'stakeholder', label: 'ステークホルダー', emoji: '👥', guide: '誰の承認が必要で、何を期待しているか' });
            }
        }
        return suggestions;
    }

    // ==========================================================
    // What / Approach（既存ロジック）
    // ==========================================================
    function processWhat(whatFields) {
        const msgs = [];
        const labels = { value: '提供する価値', scope: 'スコープ', success: '成功指標' };
        for (const [key, val] of Object.entries(whatFields)) {
            if (!val || val.trim().length < 10) continue;
            if (Math.random() > 0.5) {
                msgs.push({ role: 'ai', type: 'question', content: `「${labels[key]}」について確認です。Whyで定義した課題・ターゲットとの繋がりを明確にできますか？` });
            } else {
                msgs.push({ role: 'ai', type: 'feedback', content: `✅ 「${labels[key]}」はWhyの内容と整合しています。` });
            }
        }
        return msgs;
    }

    function generateApproachOptions() {
        return [
            { id: 0, name: '方針A: フル内製', description: '自社チームで一から開発', pros: '高いカスタマイズ性、ノウハウ蓄積', cons: '開発期間・コスト大', risks: 'スケジュール遅延' },
            { id: 1, name: '方針B: SaaS活用', description: '既存SaaS＋カスタマイズ', pros: '開発速度、初期コスト抑制', cons: 'ベンダー依存', risks: '拡張性・移行コスト' },
            { id: 2, name: '方針C: MVP先行', description: '最小限でリリース→拡張', pros: '早期検証、リスク最小化', cons: '初期機能不足', risks: 'MVP範囲設定ミス' },
        ];
    }

    function validateApproachSelection(reason) {
        const msgs = [];
        if (reason.length < 100) {
            msgs.push({ role: 'ai', type: 'warning', content: `⚠️ 選定理由が短いです（${reason.length}文字）。100文字以上で、WhyとWhatとの整合性を示しながら記述してください。` });
            return { msgs, approved: false };
        }
        const c = detectContamination(reason);
        if (c.hasContamination) {
            msgs.push({ role: 'ai', type: 'warning', content: '⚠️ 選定理由にHowの表現が含まれています。ビジネス的な観点から書いてください。' });
            return { msgs, approved: false };
        }
        msgs.push({ role: 'ai', type: 'approval', content: '🎊 要件定義が完了しました！Why → What → 方針選定まで一貫した論理で整理されています。「📄 プレビュー」から確認できます。' });
        return { msgs, approved: true };
    }

    // ==========================================================
    // ヘルパー
    // ==========================================================
    function detectContamination(text) {
        const howMatches = HOW_KEYWORDS.filter(kw => text.includes(kw));
        const whatMatches = WHAT_KEYWORDS.filter(kw => text.includes(kw));
        return { howMatches, whatMatches, hasContamination: howMatches.length > 0 || whatMatches.length > 0 };
    }

    function findMatchingSentences(text, patterns) {
        const sentences = text.split(/[。！？\n]+/).filter(s => s.trim());
        const matched = sentences.filter(s => patterns.some(p => s.includes(p)));
        return matched.length > 0 ? matched.join('。') + '。' : null;
    }

    function cleanForAspect(text, aspect) {
        // 簡易: contaminationを除いた文を返す
        return text.trim();
    }

    function getExamplePrompt(aspect) {
        const examples = {
            background: '組織がこの1年で急成長し、新しいメンバーが毎月入社するようになった',
            problem: '要件定義のレビューに毎回2時間以上かかり、修正が3回以上往復する',
            target: '入社1年未満のジュニアPdM。週3本以上の企画を担当しているが経験不足',
            impact: '要件定義の作成時間を50%短縮し、レビュー回数を平均1.5回に抑える',
            urgency: 'Q2に大型案件が控えており、それまでにプロセスを標準化する必要がある',
        };
        return examples[aspect] || '具体的な状況やエピソードを交えて';
    }

    function esc(text) {
        const d = document.createElement('div');
        d.textContent = text;
        return d.innerHTML;
    }

    return {
        ASPECTS, BASE_ASPECTS, reset,
        analyzeInitialInput, processResponse, deepDive,
        evaluateWhy, processWhat, generateApproachOptions, validateApproachSelection,
        detectContamination, generateSummaryHtml, esc,
        addDynamicAspect, removeDynamicAspect, getDynamicAspectKeys, getAspects,
    };
})();
