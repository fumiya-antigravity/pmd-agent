/* ===================================================
   PdM Assistant v2.2 — 3秒ディレイ + キャンセル + API連携
   =================================================== */
(() => {
    'use strict';

    /* ---------- STATE ---------- */
    const state = {
        phase: 'INPUT',
        aspects: {},
        currentAspect: null,
        deepDiveMode: false,
        conversationHistory: [],
        threads: [],
        activeThreadId: null,
        threadCounter: 0,
        // Send control
        pendingTimer: null,   // 3秒ディレイ用
        abortCtrl: null,      // AbortController
        sending: false,
        aspectAdvice: {}, // 観点ごとの深掘りアドバイス
        aspectReason: {}, // 観点ごとの評価理由
        aspectQuoted: {}, // 引用
        aspectExample: {}, // 具体例
        aspectStatus: {},  // AIが判定したステータス (ok/thin/empty)
    };

    const ASPECT_META = {
        background: { label: '背景・前提', emoji: '' },
        problem: { label: '課題', emoji: '' },
        target: { label: 'ターゲット', emoji: '' },
        impact: { label: '期待する効果', emoji: '' },
        urgency: { label: 'なぜ今やるか', emoji: '' },
    };

    const $ = s => document.querySelector(s);
    const $$ = s => document.querySelectorAll(s);
    const dom = {};

    /* ---------- INIT ---------- */
    function cacheDom() {
        dom.sidebar = $('#sidebar');
        dom.sidebarToggle = $('#sidebar-toggle');
        dom.sidebarThreads = $('#sidebar-threads');
        dom.newThreadBtn = $('#new-thread-btn');
        dom.topBarTitle = $('#top-bar-title');

        dom.welcomeView = $('#welcome-view');
        dom.sessionView = $('#session-view');
        dom.rightPanel = $('#right-panel');

        dom.overviewInput = $('#overview-input');
        dom.whyInput = $('#why-input');
        dom.startBtn = $('#start-btn');

        dom.chatMessages = $('#chat-messages');
        dom.chatScroll = $('#chat-scroll');
        dom.chatInput = $('#chat-input');
        dom.chatSend = $('#chat-send');

        dom.aspectList = $('#aspect-list');
        dom.progressFill = $('#progress-fill');
        dom.progressText = $('#progress-text');

        dom.checkBtn = $('#check-btn');
        dom.previewBtn = $('#preview-btn');
    }

    function init() {
        cacheDom();
        bindAll();
        console.log('[PdM v2.2] initialized (API mode + 3s delay)');
    }

    function bindAll() {
        dom.sidebarToggle.addEventListener('click', () => dom.sidebar.classList.toggle('collapsed'));
        dom.newThreadBtn.addEventListener('click', newThread);

        dom.overviewInput.addEventListener('input', checkForm);
        dom.whyInput.addEventListener('input', checkForm);
        dom.startBtn.addEventListener('click', startSession);

        dom.chatSend.addEventListener('click', handleSendClick);
        dom.chatSend.addEventListener('click', handleSendClick);
        dom.chatInput.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                handleSendClick();
            }
        });
        dom.chatInput.addEventListener('input', () => {
            dom.chatInput.style.height = 'auto';
            dom.chatInput.style.height = Math.min(dom.chatInput.scrollHeight, 100) + 'px';
            if (!state.sending) dom.chatSend.disabled = !dom.chatInput.value.trim();
        });

        dom.checkBtn.addEventListener('click', runCheckAspects);
        dom.previewBtn.addEventListener('click', showPreview);

        $$('.modal-close').forEach(b => b.addEventListener('click', () => $(`#${b.dataset.modal}`).classList.add('hidden')));
        $$('.modal-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) o.classList.add('hidden'); }));
    }

    /* ========================================
       SEND CONTROL — 3秒ディレイ + キャンセル
       ======================================== */
    function handleSendClick() {
        // 送信中（ディレイ中 or API通信中）→ キャンセル
        if (state.sending) {
            cancelSend();
            return;
        }
        const text = dom.chatInput.value.trim();
        if (!text) return;

        // メッセージ表示 + 入力クリア
        addMsg('user', text);
        dom.chatInput.value = '';
        dom.chatInput.style.height = 'auto';

        // 3秒ディレイ開始
        startDelayedSend(text);
    }

    function startDelayedSend(text) {
        state.sending = true;
        state.abortCtrl = new AbortController();
        setSendBtnCancel();
        dom.chatInput.disabled = true;

        // カウントダウン表示
        showCountdown(3);
        let remaining = 3;

        state.pendingTimer = setInterval(() => {
            remaining--;
            if (remaining > 0) {
                updateCountdown(remaining);
            } else {
                clearInterval(state.pendingTimer);
                state.pendingTimer = null;
                removeCountdown();
                // 3秒経過 → API送信
                actualSend(text);
            }
        }, 1000);
    }

    function cancelSend() {
        // ディレイタイマーをクリア
        if (state.pendingTimer) {
            clearInterval(state.pendingTimer);
            state.pendingTimer = null;
        }
        // API通信中なら中断
        if (state.abortCtrl) {
            state.abortCtrl.abort();
            state.abortCtrl = null;
        }
        removeCountdown();
        removeTyping();
        state.sending = false;
        setSendBtnNormal();
        dom.chatInput.disabled = false;
        dom.chatInput.focus();
        addSystemMsg('⏹ キャンセルしました');
    }

    function setSendBtnCancel() {
        dom.chatSend.textContent = '⏹';
        dom.chatSend.disabled = false;
        dom.chatSend.classList.add('cancel-mode');
    }

    function setSendBtnNormal() {
        dom.chatSend.textContent = '▲';
        dom.chatSend.classList.remove('cancel-mode');
        dom.chatSend.disabled = !dom.chatInput.value.trim();
    }

    /* ========================================
       WELCOME FORM
       ======================================== */
    function checkForm() {
        dom.startBtn.disabled = !(dom.overviewInput.value.trim() && dom.whyInput.value.trim());
    }

    /* ========================================
       SESSION START
       ======================================== */
    async function startSession() {
        const overview = dom.overviewInput.value.trim();
        const whyText = dom.whyInput.value.trim();
        if (!overview || !whyText) return;

        dom.startBtn.disabled = true;
        dom.startBtn.textContent = '⏳ 分析中...';
        state.abortCtrl = new AbortController();
        state.sending = true;

        // Create thread
        state.threadCounter++;
        const name = overview.length > 25 ? overview.substring(0, 25) + '…' : overview;
        const thread = {
            id: state.threadCounter, name,
            time: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
            messagesHtml: '', phase: 'WHY_SESSION', aspects: {},
            overview, whyText, isActive: true,
        };
        state.threads.forEach(t => t.isActive = false);
        state.threads.push(thread);
        state.activeThreadId = thread.id;
        renderThreads();

        // Initial User Message (History)
        addMsg('user', `## 概要\n${overview}\n\n## Why\n${whyText}`);

        // Transition
        dom.welcomeView.classList.add('fade-out');
        setTimeout(() => {
            dom.welcomeView.classList.add('hidden');
            dom.sessionView.classList.remove('hidden');
            requestAnimationFrame(() => dom.rightPanel.classList.add('show'));
        }, 300);

        state.phase = 'WHY_SESSION';
        state.conversationHistory = [];
        state.aspects = {};
        state.aspectAdvice = {};
        state.aspectReason = {};
        state.aspectQuoted = {};
        state.aspectExample = {};
        state.summaryVol = 0; // Initialize volume counter
        updatePhase('WHY_SESSION');
        dom.topBarTitle.textContent = name;
        dom.chatInput.disabled = true;

        showTyping();

        try {
            const result = await AIApi.analyzeInitialInput(overview, whyText, state.abortCtrl.signal);
            removeTyping();
            state.sending = false;

            // Thinking block
            if (result.thinking) {
                let thinkHtml = '';
                if (result.aspectUpdates) {
                    for (const [key, info] of Object.entries(result.aspectUpdates)) {
                        const meta = ASPECT_META[key] || { emoji: '📌', label: key };
                        const dotClass = info.status === 'ok' ? 'pass' : info.status === 'thin' ? 'warn' : 'fail';
                        const label = info.status === 'ok' ? '検出' : info.status === 'thin' ? '薄い' : '未検出';
                        thinkHtml += `<div class="anal-item"><span class="anal-dot ${dotClass}"></span>${meta.emoji} ${meta.label}: ${label}</div>`;
                    }
                }
                // コンタミ検知（原文引用付き）
                if (result.contamination?.detected && result.contamination.items?.length) {
                    result.contamination.items.forEach(item => {
                        if (typeof item === 'string') {
                            thinkHtml += `<div class="anal-item"><span class="anal-dot warn"></span>⚠ 混入: 「${esc(item)}」</div>`;
                        } else {
                            thinkHtml += `<div class="anal-item"><span class="anal-dot warn"></span>⚠ ${item.type || 'How/What'}混入: 「${esc(item.quote || '')}」<br><span style="color:var(--sub);margin-left:1.2em">→ ${esc(item.suggestion || '')}</span></div>`;
                        }
                    });
                }
                // crossCheck: 同語反復検出 & 論理チェーン検証
                if (result.crossCheck) {
                    if (result.crossCheck.redundancy?.detected && result.crossCheck.redundancy.pairs?.length) {
                        result.crossCheck.redundancy.pairs.forEach(pair => {
                            thinkHtml += `<div class="anal-item"><span class="anal-dot fail"></span>🔄 同語反復検出: ${esc(pair.a)} ↔ ${esc(pair.b)}<br><span style="color:var(--sub);margin-left:1.2em">${esc(pair.explanation || '')}</span></div>`;
                        });
                    }
                    if (result.crossCheck.logicChain && !result.crossCheck.logicChain.connected) {
                        thinkHtml += `<div class="anal-item"><span class="anal-dot fail"></span>⛓️ 論理チェーン断絶: ${esc(result.crossCheck.logicChain.gap || '課題→効果の因果関係が不明')}</div>`;
                    }
                }
                const okCount = Object.values(result.aspectUpdates || {}).filter(v => v.status === 'ok').length;
                addThinkingBlock('🔍 入力分析', thinkHtml, `${okCount}/5`);
            }

            // Aspect cards
            if (result.aspectUpdates) {
                for (const [key, info] of Object.entries(result.aspectUpdates)) {
                    state.aspects[key] = info.text || '';
                    state.aspectStatus[key] = info.status || 'empty';
                    if (info.advice) state.aspectAdvice[key] = info.advice;
                    if (info.reason) state.aspectReason[key] = info.reason;
                    if (info.quoted) state.aspectQuoted[key] = info.quoted;
                    if (info.example) state.aspectExample[key] = info.example;
                }
                // Show Summary Preview Vol.1
                addSummaryPreview();
            }
            for (const key of Object.keys(ASPECT_META)) {
                if (!state.aspects.hasOwnProperty(key)) state.aspects[key] = '';
                createAspectCard(key, state.aspects[key]);
            }
            updateProgress();

            // AI message
            if (result.message) {
                addMsg('ai', result.message);
                state.conversationHistory.push({ role: 'assistant', content: result.message });
            }

            // Next aspect
            if (result.nextAspect) {
                state.currentAspect = result.nextAspect;
                highlightCard(result.nextAspect);
                const meta = ASPECT_META[result.nextAspect];
                if (meta) dom.chatInput.placeholder = `${meta.label}について回答...`;
            }

            dom.chatInput.disabled = false;
            dom.chatSend.disabled = true;
        } catch (err) {
            removeTyping();
            state.sending = false;
            if (err.name === 'AbortError') {
                return; // Cancelled
            }
            console.error(err);
            addSystemMsg(`⚠️ エラー: ${err.message}`);
            dom.startBtn.disabled = false;
            dom.startBtn.textContent = '🚀 壁打ちを開始する';
            dom.chatInput.disabled = false;
        }
    }

    /* ========================================
       CHAT — 3秒ディレイ後API送信
       ======================================== */
    async function actualSend(text) {
        state.conversationHistory.push({ role: 'user', content: text });
        showTyping();

        try {
            const result = await AIApi.chat(text, {
                phase: state.deepDiveMode ? 'DEEP_DIVE' : state.phase,
                currentAspect: state.currentAspect,
                aspects: state.aspects,
                conversationHistory: state.conversationHistory.slice(-10),
                aspectStatus: state.aspectStatus,
                aspectReason: state.aspectReason,
                aspectAdvice: state.aspectAdvice,
            }, state.abortCtrl?.signal);
            removeTyping();

            // Thinking
            if (result.thinking) {
                addThinkingBlock('💭 分析', esc(result.thinking));
            }

            // Aspect update
            const update = result.aspectUpdate;
            if (update?.aspect && update.text) {
                state.aspects[update.aspect] = update.text;
                state.aspectStatus[update.aspect] = update.status || 'thin';
                if (update.advice) state.aspectAdvice[update.aspect] = update.advice;
                if (update.reason) state.aspectReason[update.aspect] = update.reason;
                if (update.quoted) state.aspectQuoted[update.aspect] = update.quoted;
                if (update.example) state.aspectExample[update.aspect] = update.example;
                updateAspectCard(update.aspect, update.text);
                updateProgress();

                // Show updated FB card in chat
                const fbReason = update.reason;
                const fbAdvice = update.advice;
                const fbQuoted = update.quoted;
                const fbExample = update.example;
                if (fbReason || fbAdvice || fbExample) {
                    const feedback = document.createElement('div');
                    feedback.className = 'feedback-card';
                    let fbHtml = '';
                    if (fbReason) {
                        fbHtml += `<div class="fb-section analysis"><div class="fb-label">現状の分析</div>${fbQuoted ? `<div class="fb-quote">"${esc(fbQuoted)}"</div>` : ''}<div class="fb-content">${esc(fbReason)}</div></div>`;
                    }
                    if (fbAdvice) {
                        fbHtml += `<div class="fb-section advice"><div class="fb-label">次の一手</div><div class="fb-content">${esc(fbAdvice)}</div></div>`;
                    }
                    if (fbExample) {
                        fbHtml += `<div class="fb-section example"><div class="fb-label">具体例</div><div class="fb-content fb-example">${esc(fbExample)}</div></div>`;
                    }
                    feedback.innerHTML = fbHtml;
                    dom.chatMessages.appendChild(feedback);
                }

                // Show Summary Preview (Update)
                addSummaryPreview();
            }

            // Related aspect updates (関連観点の連動更新)
            if (result.relatedUpdates?.length) {
                result.relatedUpdates.forEach(ru => {
                    if (!ru.aspect || ru.action === 'skip') return;
                    if (ru.relevanceScore < 0.7) return; // 0.7未満は更新しない
                    if (ru.contradictionCheck?.includes('矛盾')) return; // 矛盾がある場合は更新しない

                    if (ru.action === 'append' && state.aspects[ru.aspect]) {
                        // 追記: 既存textに新情報を追加
                        state.aspects[ru.aspect] = ru.newText || (state.aspects[ru.aspect] + '\n' + (ru.reason || ''));
                    } else if (ru.action === 'overwrite' || !state.aspects[ru.aspect]) {
                        // 上書き or 新規
                        state.aspects[ru.aspect] = ru.newText || '';
                    }
                    if (ru.newStatus) {
                        state.aspectStatus[ru.aspect] = ru.newStatus;
                    }
                    updateAspectCard(ru.aspect, state.aspects[ru.aspect]);
                });
                updateProgress();
            }
            if (result.contamination?.detected && result.contamination.items?.length) {
                let html = '';
                result.contamination.items.forEach(item => {
                    if (typeof item === 'string') {
                        html += `<div class="anal-item"><span class="anal-dot warn"></span> 「${esc(item)}」</div>`;
                    } else {
                        html += `<div class="anal-item"><span class="anal-dot warn"></span>⚠ 「${esc(item.quote || '')}」は${item.type || 'How/What'}です<br><span style="color:var(--sub);margin-left:1.2em">→ ${esc(item.suggestion || '')}</span></div>`;
                    }
                });
                addThinkingBlock('⚠️ コンタミ検知', html);
            }

            // AI message
            if (result.message) {
                addMsg('ai', result.message);
                // 会話履歴にはmessageだけでなく、分析結果のサマリーも含める
                // これによりAIが次のターンで「前回何を分析・更新したか」を把握できる
                let historyEntry = result.message;
                if (update) {
                    historyEntry += `\n[分析結果: ${update.aspect}=${update.status}, text要約="${(update.text || '').substring(0, 100)}"]`;
                }
                if (result.relatedUpdates?.length) {
                    const applied = result.relatedUpdates.filter(ru => ru.action !== 'skip' && ru.relevanceScore >= 0.7);
                    if (applied.length) {
                        historyEntry += `\n[関連更新: ${applied.map(ru => `${ru.aspect}=${ru.newStatus}`).join(', ')}]`;
                    }
                }
                state.conversationHistory.push({ role: 'assistant', content: historyEntry });
            }

            // Next aspect — Flows層の決定論的遷移制御
            // AIのnextAspect指示が優先だが、OK後のフォールバックをFlows層が保証する
            if (result.nextAspect && result.nextAspect !== state.currentAspect) {
                state.currentAspect = result.nextAspect;
                state.deepDiveMode = false;
                highlightCard(result.nextAspect);
                const meta = ASPECT_META[result.nextAspect];
                if (meta) dom.chatInput.placeholder = `${meta.label}について回答...`;
            } else if (update?.status === 'ok' && !result.nextAspect) {
                // AIがnextAspectを設定しなかった場合のフォールバック:
                // OK観点に留まらず、次のthin/emptyに自動遷移
                const ASPECT_KEYS = ['background', 'problem', 'target', 'impact', 'urgency'];
                const nextIncomplete = ASPECT_KEYS.find(k =>
                    k !== update.aspect &&
                    state.aspectStatus[k] !== 'ok' &&
                    state.aspectStatus[k] !== 'skipped'
                );
                if (nextIncomplete) {
                    state.currentAspect = nextIncomplete;
                    state.deepDiveMode = false;
                    highlightCard(nextIncomplete);
                    const meta = ASPECT_META[nextIncomplete];
                    if (meta) {
                        dom.chatInput.placeholder = `${meta.label}について回答...`;
                        addSystemMsg(`「${ASPECT_META[update.aspect]?.label || update.aspect}」が充実しました。次は「${meta.label}」について深掘りしましょう。`);
                    }
                } else {
                    // 全観点OK → 観点チェック提案
                    addSystemMsg('すべての観点が充実しました。観点チェックを実行して全体の整合性を確認しましょう。');
                }
            }

        } catch (err) {
            removeTyping();
            if (err.name === 'AbortError') {
                addSystemMsg('⏹ キャンセルしました');
            } else {
                addMsg('ai', `⚠️ エラー: ${err.message}`, 'warning');
            }
        }

        state.sending = false;
        setSendBtnNormal();
        dom.chatInput.disabled = false;
        dom.chatInput.focus();
    }

    /* ========================================
       ASPECT CHECK
       ======================================== */
    async function runCheckAspects() {
        dom.checkBtn.disabled = true;
        dom.checkBtn.textContent = '⏳ チェック中...';
        state.abortCtrl = new AbortController();
        showTyping();

        try {
            const result = await AIApi.checkAspects(state.aspects, state.abortCtrl.signal);
            removeTyping();

            if (result.aspectResults) {
                let html = '';
                for (const [key, info] of Object.entries(result.aspectResults)) {
                    const meta = ASPECT_META[key] || { emoji: '📌', label: key };
                    const dot = info.status === 'ok' ? 'pass' : info.status === 'thin' ? 'warn' : 'fail';
                    html += `<div class="anal-item"><span class="anal-dot ${dot}"></span>${meta.emoji} ${meta.label}: ${esc(info.feedback)}</div>`;
                }
                const okN = Object.values(result.aspectResults).filter(v => v.status === 'ok').length;
                addThinkingBlock('🔍 観点チェック', html, `${okN}/5`);
            }

            if (result.suggestedAspects?.length) {
                const wrap = document.createElement('div');
                wrap.className = 'chips';
                result.suggestedAspects.forEach(s => {
                    const btn = document.createElement('button');
                    btn.className = 'chip';
                    btn.textContent = `${s.emoji} ${s.label}を追加`;
                    btn.addEventListener('click', () => {
                        ASPECT_META[s.key] = { label: s.label, emoji: s.emoji };
                        state.aspects[s.key] = '';
                        createAspectCard(s.key, '');
                        updateProgress();
                        addMsg('ai', `${s.emoji} **${s.label}**を追加しました。`);
                        btn.disabled = true;
                    });
                    wrap.appendChild(btn);
                });
                dom.chatMessages.appendChild(wrap);
                scroll();
            }

            if (result.message) addMsg('ai', result.message);

            if (result.allApproved) {
                setTimeout(() => {
                    const p = document.createElement('div');
                    p.className = 'next-prompt';
                    p.innerHTML = '✅ 全観点OK — 要件定義書を生成する →';
                    p.addEventListener('click', () => addMsg('ai', '🎉 すべての観点が整理されました！ 右上の「📄 プレビュー」から確認できます。'));
                    dom.chatMessages.appendChild(p);
                    scroll();
                }, 500);
            }
        } catch (err) {
            removeTyping();
            if (err.name !== 'AbortError') addMsg('ai', `⚠️ エラー: ${err.message}`, 'warning');
        }

        dom.checkBtn.disabled = false;
        dom.checkBtn.textContent = '🔍 観点をチェック';
    }

    /* ========================================
       THREAD MANAGEMENT
       ======================================== */
    function newThread() {
        if (state.sending) cancelSend();
        saveThread();
        dom.sessionView.classList.add('hidden');
        dom.rightPanel.classList.remove('show');
        dom.welcomeView.classList.remove('hidden', 'fade-out');
        dom.overviewInput.value = '';
        dom.whyInput.value = '';
        dom.chatMessages.innerHTML = '';
        dom.aspectList.innerHTML = '';
        dom.chatInput.value = '';
        dom.chatInput.disabled = true;
        dom.checkBtn.classList.add('hidden');
        state.phase = 'INPUT';
        state.aspects = {};
        state.aspectAdvice = {};
        state.aspectReason = {};
        state.aspectQuoted = {};
        state.aspectExample = {};
        state.aspectStatus = {};
        state.currentAspect = null;
        state.deepDiveMode = false;
        state.conversationHistory = [];
        dom.topBarTitle.textContent = '💎 PdM Assistant';
        dom.startBtn.disabled = true;
        dom.startBtn.textContent = '🚀 壁打ちを開始する';
        updatePhase('INPUT');
        checkForm();
    }

    function switchThread(id) {
        if (id === state.activeThreadId) return;
        if (state.sending) cancelSend();
        saveThread();
        state.threads.forEach(t => t.isActive = (t.id === id));
        state.activeThreadId = id;
        const thread = state.threads.find(t => t.id === id);
        if (!thread) return;

        if (thread.phase === 'INPUT') {
            dom.sessionView.classList.add('hidden');
            dom.rightPanel.classList.remove('show');
            dom.welcomeView.classList.remove('hidden', 'fade-out');
            dom.overviewInput.value = thread.overview || '';
            dom.whyInput.value = thread.whyText || '';
            checkForm();
        } else {
            dom.welcomeView.classList.add('hidden');
            dom.sessionView.classList.remove('hidden');
            dom.rightPanel.classList.add('show');
            dom.chatInput.disabled = false;
            dom.chatMessages.innerHTML = thread.messagesHtml || '';
            state.aspects = { ...thread.aspects };
            state.aspectAdvice = { ...(thread.aspectAdvice || {}) };
            state.aspectReason = { ...(thread.aspectReason || {}) };
            state.aspectQuoted = { ...(thread.aspectQuoted || {}) };
            state.aspectExample = { ...(thread.aspectExample || {}) };
            state.aspectStatus = { ...(thread.aspectStatus || {}) };
            state.phase = thread.phase;
            state.conversationHistory = thread.conversationHistory || [];
            dom.aspectList.innerHTML = '';
            for (const [key, text] of Object.entries(state.aspects)) {
                createAspectCard(key, text);
            }
            updateProgress();
            updatePhase(thread.phase);
        }
        dom.topBarTitle.textContent = thread.name;
        renderThreads();
    }

    function saveThread() {
        const t = state.threads.find(t => t.id === state.activeThreadId);
        if (!t) return;
        t.messagesHtml = dom.chatMessages.innerHTML;
        t.phase = state.phase;
        t.aspects = { ...state.aspects };
        t.aspectAdvice = { ...state.aspectAdvice };
        t.aspectReason = { ...state.aspectReason };
        t.aspectQuoted = { ...state.aspectQuoted };
        t.aspectExample = { ...state.aspectExample };
        t.aspectStatus = { ...state.aspectStatus };
        t.overview = dom.overviewInput.value;
        t.whyText = dom.whyInput.value;
        t.conversationHistory = [...state.conversationHistory];
    }

    function renderThreads() {
        dom.sidebarThreads.innerHTML = '';
        [...state.threads].reverse().forEach(t => {
            const el = document.createElement('div');
            el.className = `sb-thread${t.id === state.activeThreadId ? ' active' : ''}`;
            el.innerHTML = `<span class="sb-thread-name">💬 ${esc(t.name)}</span><span class="sb-thread-time">${t.time}</span>`;
            el.addEventListener('click', () => switchThread(t.id));
            dom.sidebarThreads.appendChild(el);
        });
    }

    /* ========================================
       UI HELPERS
       ======================================== */
    function addMsg(role, content, type) {
        const el = document.createElement('div');
        el.className = `msg ${role}`;
        if (type === 'warning') el.classList.add('warning');
        el.innerHTML = `<div class="msg-role">${role === 'ai' ? '🤖 AI' : '👤 あなた'}</div><div>${fmt(content)}</div>`;
        dom.chatMessages.appendChild(el);
        scroll();
    }

    function addSystemMsg(text) {
        const el = document.createElement('div');
        el.className = 'msg system';
        el.innerHTML = `<div>${text}</div>`;
        dom.chatMessages.appendChild(el);
        scroll();
        // システムメッセージも会話履歴に含める（AIが文脈を把握できるように）
        state.conversationHistory.push({ role: 'system', content: `[システム] ${text}` });
    }

    function addThinkingBlock(title, bodyHtml, badge) {
        const el = document.createElement('div');
        el.className = 'think';
        el.innerHTML = `
            <div class="think-head">
                <span class="think-chev">▶</span>
                <span class="think-title">${title}</span>
                ${badge ? `<span class="think-badge">${badge}</span>` : ''}
            </div>
            <div class="think-body"><div class="think-content">${bodyHtml}</div></div>`;
        el.querySelector('.think-head').addEventListener('click', () => el.classList.toggle('open'));
        dom.chatMessages.appendChild(el);
        scroll();
    }

    function showTyping() {
        const t = document.createElement('div');
        t.className = 'typing'; t.id = 'typing-ind';
        t.innerHTML = '<span></span><span></span><span></span>';
        dom.chatMessages.appendChild(t); scroll();
    }
    function removeTyping() { const t = $('#typing-ind'); if (t) t.remove(); }

    function showCountdown(n) {
        const el = document.createElement('div');
        el.className = 'countdown-indicator'; el.id = 'countdown-ind';
        el.innerHTML = `<span class="countdown-num">${n}</span><span class="countdown-text">秒後に送信... ⏹で停止</span>`;
        dom.chatMessages.appendChild(el);
        scroll();
    }
    function updateCountdown(n) {
        const el = $('#countdown-ind');
        if (el) el.querySelector('.countdown-num').textContent = n;
    }
    function removeCountdown() { const el = $('#countdown-ind'); if (el) el.remove(); }

    function scroll() { dom.chatScroll.scrollTop = dom.chatScroll.scrollHeight; }
    function fmt(t) { return t.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>'); }
    function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

    /* ========================================
       ASPECT CARDS
       ======================================== */
    function createAspectCard(aspect, text) {
        const meta = ASPECT_META[aspect];
        if (!meta) return;
        const s = cardStatus(text, aspect);
        const card = document.createElement('div');
        card.className = 'a-card';
        card.dataset.aspect = aspect;
        if (s.c === 'skipped') card.classList.add('skipped');

        const isSkipped = s.c === 'skipped';
        const isOk = s.c === 'ok';
        const needsAction = !isOk && !isSkipped;
        const btnHtml = needsAction ? `<button class="a-card-btn ${text ? 'deepen' : 'respond'}">${text ? '💬 深掘り' : '💬 回答する'}</button>` : '';
        const skipBtnHtml = needsAction ? '<button class="a-card-skip" title="この観点をスキップ">― スキップ</button>' : '';
        const restoreBtnHtml = isSkipped ? '<button class="a-card-restore">↩ 復元</button>' : '';
        const preview = isSkipped ? 'スキップ済み' : (text ? esc(trunc(text, 60)) : '未入力');
        const fullText = text ? esc(text) : '';
        const hasMore = !isSkipped && text && text.length > 60;

        card.innerHTML = `
            <div class="a-card-top">
                <span class="a-card-label">${meta.emoji} ${meta.label}</span>
                <span class="badge ${s.c}">${s.l}</span>
            </div>
            <div class="a-card-body ${isSkipped ? 'hint' : (text ? '' : 'hint')}">
                <div class="a-card-preview">${preview}</div>
                ${hasMore ? `<div class="a-card-full" style="display:none">${fullText}</div>` : ''}
                ${hasMore ? '<div class="a-card-toggle">▼ 全文表示</div>' : ''}
            </div>
            <div class="a-card-actions">
                ${btnHtml}${skipBtnHtml}${restoreBtnHtml}
            </div>`;

        if (!text && !isSkipped) card.classList.add('attention');

        // アコーディオントグル
        if (hasMore) {
            card.querySelector('.a-card-toggle').addEventListener('click', (e) => {
                e.stopPropagation();
                const full = card.querySelector('.a-card-full');
                const prev = card.querySelector('.a-card-preview');
                const toggle = card.querySelector('.a-card-toggle');
                const isOpen = full.style.display !== 'none';
                full.style.display = isOpen ? 'none' : 'block';
                prev.style.display = isOpen ? 'block' : 'none';
                toggle.textContent = isOpen ? '▼ 全文表示' : '▲ 短く表示';
            });
        }

        if (needsAction) {
            card.querySelector('.a-card-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                startAspectChat(aspect);
            });
            card.querySelector('.a-card-skip').addEventListener('click', (e) => {
                e.stopPropagation();
                skipAspect(aspect);
            });
        }
        if (isSkipped) {
            card.querySelector('.a-card-restore').addEventListener('click', (e) => {
                e.stopPropagation();
                restoreAspect(aspect);
            });
        }
        dom.aspectList.appendChild(card);
        requestAnimationFrame(() => card.classList.add('in'));
    }

    function updateAspectCard(aspect, text) {
        const card = dom.aspectList.querySelector(`[data-aspect="${aspect}"]`);
        if (!card) { createAspectCard(aspect, text); return; }
        // スキップ状態変更時はカードごと再構築
        const currentSkipped = card.classList.contains('skipped');
        const newSkipped = state.aspectStatus[aspect] === 'skipped';
        if (currentSkipped !== newSkipped) {
            card.remove();
            createAspectCard(aspect, text);
            return;
        }
        const s = cardStatus(text, aspect);
        card.querySelector('.badge').textContent = s.l;
        card.querySelector('.badge').className = `badge ${s.c}`;

        const body = card.querySelector('.a-card-body');
        const preview = text ? esc(trunc(text, 60)) : '未入力';
        const fullText = text ? esc(text) : '';
        const hasMore = text && text.length > 60;

        body.className = `a-card-body ${text ? '' : 'hint'}`;
        body.innerHTML = `
            <div class="a-card-preview">${preview}</div>
            ${hasMore ? `<div class="a-card-full" style="display:none">${fullText}</div>` : ''}
            ${hasMore ? '<div class="a-card-toggle">▼ 全文表示</div>' : ''}
        `;

        // アコーディオントグル
        if (hasMore) {
            body.querySelector('.a-card-toggle').addEventListener('click', (e) => {
                e.stopPropagation();
                const full = body.querySelector('.a-card-full');
                const prev = body.querySelector('.a-card-preview');
                const toggle = body.querySelector('.a-card-toggle');
                const isOpen = full.style.display !== 'none';
                full.style.display = isOpen ? 'none' : 'block';
                prev.style.display = isOpen ? 'block' : 'none';
                toggle.textContent = isOpen ? '▼ 全文表示' : '▲ 短く表示';
            });
        }

        let btn = card.querySelector('.a-card-btn');
        if (s.c === 'ok') {
            if (btn) btn.remove();
        } else {
            if (!btn) {
                btn = document.createElement('button');
                card.appendChild(btn);
            }
            btn.className = `a-card-btn ${text ? 'deepen' : 'respond'}`;
            btn.innerHTML = text ? '💬 深掘り' : '💬 回答する';
            btn.onclick = () => startAspectChat(aspect);
        }
        card.classList.toggle('attention', !text?.trim());
        card.classList.remove('focused');
    }

    function highlightCard(aspect) {
        $$('.a-card').forEach(c => c.classList.remove('focused'));
        const card = dom.aspectList.querySelector(`[data-aspect="${aspect}"]`);
        if (card) { card.classList.add('focused'); card.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }

    function startAspectChat(aspect) {
        state.currentAspect = aspect;
        state.deepDiveMode = true;
        highlightCard(aspect);
        const meta = ASPECT_META[aspect];
        if (!meta) return;
        const ctx = document.createElement('div');
        ctx.className = 'ctx-card';
        ctx.innerHTML = `${meta.emoji} ${meta.label}について`;
        dom.chatMessages.appendChild(ctx);


        const reason = state.aspectReason[aspect];
        const advice = state.aspectAdvice[aspect];
        const quoted = state.aspectQuoted[aspect];
        const example = state.aspectExample[aspect];

        if (reason || advice || example) {
            const feedback = document.createElement('div');
            feedback.className = 'feedback-card';

            let html = '';
            if (reason) {
                html += `<div class="fb-section analysis"><div class="fb-label">現状の分析</div>${quoted ? `<div class="fb-quote">"${esc(quoted)}"</div>` : ''}<div class="fb-content">${esc(reason)}</div></div>`;
            }
            if (advice) {
                html += `<div class="fb-section advice"><div class="fb-label">次の一手</div><div class="fb-content">${esc(advice)}</div></div>`;
            }
            if (example) {
                html += `<div class="fb-section example"><div class="fb-label">具体例</div><div class="fb-content fb-example">${esc(example)}</div></div>`;
            }
            feedback.innerHTML = html;
            dom.chatMessages.appendChild(feedback);
        }

        scroll();
        dom.chatInput.placeholder = `${meta.label}について回答...`;
        dom.chatInput.disabled = false;
        dom.chatInput.focus();
    }

    function cardStatus(t, aspect) {
        // AIが判定したステータスを優先使用
        const aiStatus = aspect ? state.aspectStatus[aspect] : null;
        if (aiStatus) {
            if (aiStatus === 'ok') return { l: '✓ OK', c: 'ok' };
            if (aiStatus === 'skipped') return { l: '― スキップ', c: 'skipped' };
            if (aiStatus === 'thin') return { l: '△ 薄い', c: 'thin' };
            return { l: '✗ 空', c: 'empty' };
        }
        // フォールバック（AI評価がない場合のみ文字数で判定）
        if (!t?.trim()) return { l: '✗ 空', c: 'empty' };
        if (t.trim().length < 30) return { l: '△ 薄い', c: 'thin' };
        return { l: '✓ OK', c: 'ok' };
    }

    function skipAspect(aspect) {
        state.aspectStatus[aspect] = 'skipped';
        updateAspectCard(aspect, state.aspects[aspect] || '');
        updateProgress();
    }

    function restoreAspect(aspect) {
        delete state.aspectStatus[aspect];
        updateAspectCard(aspect, state.aspects[aspect] || '');
        updateProgress();
    }
    function trunc(t, m) { return t.length <= m ? t : t.substring(0, m) + '…'; }

    function updateProgress() {
        const allKeys = Object.keys(state.aspects).length ? Object.keys(state.aspects) : Object.keys(ASPECT_META);
        const skippedCount = allKeys.filter(key => state.aspectStatus[key] === 'skipped').length;
        const activeTotal = allKeys.length - skippedCount;
        // AIのステータス判定を使用
        const ok = allKeys.filter(key => state.aspectStatus[key] === 'ok').length;
        const pct = activeTotal > 0 ? Math.round((ok / activeTotal) * 100) : 0;
        dom.progressFill.style.width = pct + '%';
        const skippedLabel = skippedCount > 0 ? ` (スキップ${skippedCount})` : '';
        dom.progressText.textContent = `${ok} / ${activeTotal} 完了${skippedLabel}`;
        if (ok >= Math.min(3, activeTotal)) dom.checkBtn.classList.remove('hidden');
    }

    function updatePhase(active) {
        const phases = ['INPUT', 'WHY_SESSION', 'WHAT_SESSION', 'APPROACH_SESSION', 'DONE'];
        const idx = phases.indexOf(active);
        $$('.phase-dots .dot').forEach(d => {
            const si = phases.indexOf(d.dataset.phase);
            d.classList.remove('active', 'done');
            if (si < idx) d.classList.add('done');
            else if (si === idx) d.classList.add('active');
        });
    }

    function showPreview() {
        const modal = $('#preview-modal');
        modal.classList.remove('hidden');
        const cnt = $('#preview-content');
        let h = '<div class="preview-doc">';
        const ov = dom.overviewInput.value.trim() || state.threads.find(t => t.id === state.activeThreadId)?.overview || '';
        h += `<h4>📋 概要</h4>`;
        if (ov) h += `<div class="preview-pt"><span class="preview-pt-label">テーマ</span><span>${esc(ov)}</span></div>`;
        h += `<h4>🔍 Why</h4>`;
        for (const [key, text] of Object.entries(state.aspects)) {
            const meta = ASPECT_META[key] || { emoji: '📌', label: key };
            if (text?.trim()) {
                h += `<div class="preview-pt"><span class="preview-pt-label">${meta.emoji} ${meta.label}</span><span>${esc(text.trim())}</span></div>`;
            } else {
                h += `<div class="preview-pt" style="opacity:.4"><span class="preview-pt-label">${meta.emoji} ${meta.label}</span><span style="color:var(--err)">未整理</span></div>`;
            }
        }
        h += '</div>';
        cnt.innerHTML = h;
    }

    /* ========================================
       SUMMARY PREVIEW
       ======================================== */
    function addSummaryPreview() {
        state.summaryVol = (state.summaryVol || 0) + 1;
        const vol = state.summaryVol;

        const summaryDiv = document.createElement('div');
        summaryDiv.className = 'summary-preview';

        let contentHtml = '';
        for (const [key, meta] of Object.entries(ASPECT_META)) {
            const text = state.aspects[key] || '（未記入）';
            const status = state.aspectStatus[key] || (!state.aspects[key] ? 'empty' : 'thin');
            const statusLabel = status === 'ok' ? 'OK' : status === 'thin' ? '薄い' : '未';
            const statusClass = status === 'ok' ? 'pass' : status === 'thin' ? 'warn' : 'fail';

            // Show full cumulative text (truncate only if very long)
            const previewText = text.length > 150 ? text.substring(0, 150) + '...' : text;

            contentHtml += `
                <div class="sp-item">
                    <div class="sp-label"><span class="sp-dot ${statusClass}"></span>${meta.label} <span class="sp-status">${statusLabel}</span></div>
                    <div class="sp-text">${esc(previewText)}</div>
                </div>
            `;
        }

        summaryDiv.innerHTML = `
            <div class="sp-header" onclick="this.parentElement.classList.toggle('open')">
                <span class="sp-toggle">▶</span>
                <span class="sp-title">💎 要約プレビュー Vol.${vol}</span>
                <span class="sp-sub">（クリックで展開）</span>
            </div>
            <div class="sp-body">
                ${contentHtml}
            </div>
        `;

        dom.chatMessages.appendChild(summaryDiv);
        dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
    }

    document.addEventListener('DOMContentLoaded', init);
})();
