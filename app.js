/* ===================================================
   PdM Assistant - Main Application Logic
   app.js
   ===================================================
   スレッド管理 + IDE風思考ブロック折りたたみ
   =================================================== */

(() => {
    'use strict';

    // ===================================================
    // STATE
    // ===================================================
    const state = {
        phase: 'INPUT',
        project: { name: '' },
        why: { initial: '', aspects: {}, revisions: [] },
        what: { fields: { value: '', scope: '', success: '' } },
        approach: { options: [], selectedId: null, selectionReason: '' },
        currentAspect: null,
        deepDiveMode: false,
        selectedAspects: new Set(),
        learningLog: [],
        // --- Thread management ---
        threads: [],
        activeThreadId: null,
        threadCounter: 0,
        sidebarOpen: true,
    };

    const $ = s => document.querySelector(s);
    const $$ = s => document.querySelectorAll(s);
    const dom = {};

    function cacheDom() {
        dom.homeScreen = $('#home-screen'); dom.mainScreen = $('#main-screen');
        dom.projectNameInput = $('#project-name-input'); dom.createProjectBtn = $('#create-project-btn');
        dom.headerProjectName = $('#header-project-name');
        dom.overviewInput = $('#overview-input'); dom.whyInput = $('#why-input');
        dom.startSessionBtn = $('#start-session-btn');
        dom.aspectsSection = $('#aspects-section'); dom.aspectList = $('#aspect-list');
        dom.aspectCountBadge = $('#aspect-count-badge');
        dom.stepOverview = $('#step-overview'); dom.stepWhy = $('#step-why');
        dom.stepWhat = $('#step-what'); dom.stepApproach = $('#step-approach');
        dom.confirmWhyBtn = $('#confirm-why-btn');
        dom.submitWhatBtn = $('#submit-what-btn');
        dom.brainstormApproachBtn = $('#brainstorm-approach-btn');
        dom.finalizeApproachBtn = $('#finalize-approach-btn');
        dom.previewBtn = $('#preview-btn'); dom.historyToggleBtn = $('#history-toggle-btn');
        dom.approachTableContainer = $('#approach-table-container');
        dom.approachSelection = $('#approach-selection');
        dom.approachReason = $('#approach-reason'); dom.approachReasonCount = $('#approach-reason-count');
        dom.chatMessages = $('#chat-messages'); dom.chatScroll = $('#chat-scroll');
        dom.chatInput = $('#chat-input'); dom.chatSendBtn = $('#chat-send-btn');
        dom.progressFill = $('#progress-fill'); dom.progressPct = $('#progress-pct');
        dom.learningCount = $('#learning-count'); dom.learningDetailBtn = $('#learning-detail-btn');
        dom.discussSelectedBtn = $('#discuss-selected-btn'); dom.selectedCount = $('#selected-count');
        dom.threadSidebar = $('#thread-sidebar'); dom.threadList = $('#thread-list');
        dom.sidebarToggleBtn = $('#sidebar-toggle-btn'); dom.newThreadBtn = $('#new-thread-btn');
        dom.currentThreadLabel = $('#current-thread-label');
    }

    function init() {
        cacheDom();
        bindHomeEvents();
        bindFormEvents();
        bindChatEvents();
        bindActionEvents();
        bindModalEvents();
        bindThreadEvents();
    }

    // ===================================================
    // HOME
    // ===================================================
    function bindHomeEvents() {
        dom.projectNameInput.addEventListener('input', () => { dom.createProjectBtn.disabled = !dom.projectNameInput.value.trim(); });
        dom.createProjectBtn.addEventListener('click', () => {
            state.project.name = dom.projectNameInput.value.trim();
            dom.headerProjectName.textContent = state.project.name;
            switchScreen('main');
            updatePhase('INPUT');
        });
        dom.projectNameInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !dom.createProjectBtn.disabled) dom.createProjectBtn.click(); });
    }
    function switchScreen(s) { $$('.screen').forEach(el => el.classList.remove('active')); (s === 'home' ? dom.homeScreen : dom.mainScreen).classList.add('active'); }

    // ===================================================
    // THREAD MANAGEMENT
    // ===================================================
    function bindThreadEvents() {
        dom.sidebarToggleBtn.addEventListener('click', () => {
            state.sidebarOpen = !state.sidebarOpen;
            dom.threadSidebar.classList.toggle('collapsed', !state.sidebarOpen);
        });
        dom.newThreadBtn.addEventListener('click', createNewThread);
    }

    function createNewThread() {
        // Save current thread messages before switching
        saveCurrentThreadMessages();

        state.threadCounter++;
        const thread = {
            id: state.threadCounter,
            name: `壁打ち #${state.threadCounter}`,
            createdAt: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
            messages: [],
            isActive: true,
        };

        // Deactivate previous threads
        state.threads.forEach(t => t.isActive = false);
        state.threads.push(thread);
        state.activeThreadId = thread.id;

        // Clear chat for new thread
        dom.chatMessages.innerHTML = '';
        addWelcomeMessage();
        dom.chatInput.disabled = false;
        dom.chatSendBtn.disabled = true;
        dom.currentThreadLabel.textContent = thread.name;

        // Reset deep dive state for the new thread
        state.currentAspect = null;
        state.deepDiveMode = false;

        // --- STEP 1/2 リセット ---
        dom.overviewInput.value = '';
        dom.overviewInput.disabled = false;
        dom.whyInput.value = '';
        dom.whyInput.disabled = false;
        state.why.initial = '';
        state.why.aspects = {};
        state.selectedAspects.clear();

        // Reset aspect cards
        dom.aspectList.innerHTML = '';
        dom.aspectsSection.classList.add('hidden');
        updateAspectCount();
        updateProgress();

        // Show start button, hide confirm
        dom.startSessionBtn.classList.remove('hidden');
        dom.startSessionBtn.disabled = true;
        dom.confirmWhyBtn.classList.add('hidden');
        dom.discussSelectedBtn.classList.add('hidden');

        // Reset step states
        dom.stepOverview.classList.remove('completed-step');
        dom.stepWhy.classList.remove('completed-step');

        // Reset phase
        state.phase = 'INPUT';
        updatePhase('INPUT');

        // Reset AI
        AILogic.reset();

        renderThreadList();
        updateSelectedBtn();
    }

    function saveCurrentThreadMessages() {
        if (state.activeThreadId) {
            const thread = state.threads.find(t => t.id === state.activeThreadId);
            if (thread) {
                thread.messages = dom.chatMessages.innerHTML;
            }
        }
    }

    function switchToThread(threadId) {
        if (threadId === state.activeThreadId) return;

        // Save current thread
        saveCurrentThreadMessages();

        // Switch
        state.threads.forEach(t => t.isActive = (t.id === threadId));
        state.activeThreadId = threadId;

        const thread = state.threads.find(t => t.id === threadId);
        if (thread) {
            dom.chatMessages.innerHTML = thread.messages || '';
            dom.currentThreadLabel.textContent = thread.name;
        }

        renderThreadList();
        scroll();
    }

    function renderThreadList() {
        dom.threadList.innerHTML = '';
        // Show newest first
        [...state.threads].reverse().forEach(thread => {
            const item = document.createElement('div');
            item.className = `thread-item ${thread.id === state.activeThreadId ? 'active' : ''}`;
            item.innerHTML = `
                <span class="thread-icon">💬</span>
                <div class="thread-info">
                    <div class="thread-name">${esc(thread.name)}</div>
                    <div class="thread-meta">${thread.createdAt}</div>
                </div>
                ${thread.id === state.activeThreadId ? '<span class="thread-dot"></span>' : ''}
            `;
            item.addEventListener('click', () => switchToThread(thread.id));
            dom.threadList.appendChild(item);
        });
    }

    function addWelcomeMessage() {
        dom.chatMessages.innerHTML = `
            <div class="chat-welcome">
                <div class="welcome-icon">💬</div>
                <h3>新しい壁打ちスレッド</h3>
                <p>左パネルの観点を選択して「💬 壁打ち」で<br>このスレッドで議論しましょう</p>
            </div>
        `;
    }

    // ===================================================
    // FORMS
    // ===================================================
    function bindFormEvents() {
        dom.overviewInput.addEventListener('input', updateStartBtn);
        dom.whyInput.addEventListener('input', () => { state.why.initial = dom.whyInput.value; updateStartBtn(); });
        $$('.what-field').forEach(ta => ta.addEventListener('input', () => { state.what.fields[ta.dataset.key] = ta.value; }));
        dom.approachReason.addEventListener('input', () => { state.approach.selectionReason = dom.approachReason.value; dom.approachReasonCount.textContent = dom.approachReason.value.length; });
    }
    function updateStartBtn() { dom.startSessionBtn.disabled = !(dom.overviewInput.value.trim() && dom.whyInput.value.trim()); }

    // ===================================================
    // CHAT
    // ===================================================
    function bindChatEvents() {
        dom.chatSendBtn.addEventListener('click', sendMsg);
        dom.chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
        dom.chatInput.addEventListener('input', () => {
            dom.chatInput.style.height = 'auto';
            dom.chatInput.style.height = Math.min(dom.chatInput.scrollHeight, 80) + 'px';
            dom.chatSendBtn.disabled = !dom.chatInput.value.trim();
        });
    }

    function sendMsg() {
        const text = dom.chatInput.value.trim();
        if (!text) return;
        addBubble('user', text);
        dom.chatInput.value = ''; dom.chatInput.style.height = 'auto'; dom.chatSendBtn.disabled = true;

        showTyping();
        setTimeout(() => {
            removeTyping();
            if (state.phase === 'WHY_SESSION') {
                if (state.deepDiveMode) {
                    const { msgs, suggestion } = AILogic.deepDive(text, state.currentAspect, state.why.aspects[state.currentAspect] || '');
                    if (suggestion) applyAspect(suggestion);
                    renderMsgs(msgs);
                } else {
                    const { msgs, suggestion } = AILogic.processResponse(text, state.currentAspect, state.why.aspects);
                    if (suggestion) applyAspect(suggestion);
                    renderMsgs(msgs);
                }
                updateProgress();
            } else if (state.phase === 'WHAT_SESSION') {
                renderMsgs(AILogic.processWhat(state.what.fields));
            }
        }, 500 + Math.random() * 300);
    }

    function addBubble(role, content, type) {
        clearWelcome();
        const b = document.createElement('div');
        b.className = `chat-bubble ${role}`;
        if (type === 'warning') b.classList.add('warning');
        b.innerHTML = `<div class="bubble-label">${role === 'ai' ? '🤖 AI' : '👤 あなた'}</div><div>${fmt(content)}</div>`;
        dom.chatMessages.appendChild(b); scroll();
    }

    // ===================================================
    // THINKING BLOCKS - IDE-style collapsible
    // ===================================================
    function addThinkingBlock(icon, title, bodyHtml, opts = {}) {
        clearWelcome();
        const block = document.createElement('div');
        block.className = 'thinking-block open'; // start open

        const showSpinner = opts.loading || false;
        const badge = opts.badge || '';

        block.innerHTML = `
            <div class="thinking-block-header">
                <span class="thinking-block-chevron">▶</span>
                ${showSpinner ? '<span class="thinking-spinner"></span>' : `<span class="thinking-block-icon">${icon}</span>`}
                <span class="thinking-block-title">${title}</span>
                ${badge ? `<span class="thinking-block-badge">${badge}</span>` : ''}
            </div>
            <div class="thinking-block-body">
                <div class="thinking-block-content">${bodyHtml}</div>
            </div>
        `;

        // Toggle on header click
        const header = block.querySelector('.thinking-block-header');
        header.addEventListener('click', () => block.classList.toggle('open'));

        dom.chatMessages.appendChild(block);
        scroll();

        return block;
    }

    function collapseThinkingBlock(block, delay = 1500) {
        // Auto-collapse after delay (like IDE thinking blocks)
        setTimeout(() => {
            block.classList.remove('open');
            // Remove spinner if present
            const spinner = block.querySelector('.thinking-spinner');
            if (spinner) {
                const icon = document.createElement('span');
                icon.className = 'thinking-block-icon';
                icon.textContent = '✓';
                spinner.replaceWith(icon);
            }
        }, delay);
    }

    function renderMsgs(msgs) {
        msgs.forEach((m, i) => setTimeout(() => {
            if (m.type === 'chips') {
                if (m.content) addBubble('ai', m.content);
                const chips = document.createElement('div'); chips.className = 'chat-chips';
                m.chips.forEach(c => {
                    const el = document.createElement('button'); el.className = 'chat-chip'; el.textContent = c.label;
                    el.addEventListener('click', () => {
                        state.currentAspect = c.field; state.deepDiveMode = true;
                        addBubble('user', c.label); showTyping();
                        setTimeout(() => { removeTyping(); renderMsgs(AILogic.deepDive('', c.field, state.why.aspects[c.field] || '').msgs); }, 400);
                        chips.querySelectorAll('.chat-chip').forEach(ch => { ch.disabled = true; ch.style.opacity = '0.4'; });
                    });
                    chips.appendChild(el);
                });
                dom.chatMessages.appendChild(chips); scroll();
            } else if (m.type === 'warning') {
                addBubble('ai', m.content, 'warning');
            } else {
                addBubble('ai', m.content);
                if (m.targetAspect) { state.currentAspect = m.targetAspect; highlightAccordion(m.targetAspect); }
            }
        }, i * 400));
    }

    function clearWelcome() { const w = dom.chatMessages.querySelector('.chat-welcome'); if (w) w.remove(); }
    function showTyping() { const t = document.createElement('div'); t.className = 'typing-indicator'; t.id = 'typing'; t.innerHTML = '<span></span><span></span><span></span>'; dom.chatMessages.appendChild(t); scroll(); }
    function removeTyping() { const t = $('#typing'); if (t) t.remove(); }
    function scroll() { dom.chatScroll.scrollTop = dom.chatScroll.scrollHeight; }
    function fmt(t) { return t.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>'); }
    function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

    // ===================================================
    // ACCORDION ASPECT CARDS
    // ===================================================
    function applyAspect(suggestion) {
        const { aspect, text } = suggestion;
        state.why.aspects[aspect] = text;
        const existing = dom.aspectList.querySelector(`[data-aspect="${aspect}"]`);
        if (!existing) createAccordion(aspect, text);
        else updateAccordionContent(existing, text);
        dom.aspectsSection.classList.remove('hidden');
        updateAspectCount(); updateProgress();
        addLearning(`${AILogic.ASPECTS[aspect].label}が整理されました`);
    }

    function createAccordion(aspect, text) {
        const info = AILogic.ASPECTS[aspect];
        const status = getStatus(text);
        const item = document.createElement('div');
        item.className = 'accordion-item'; item.dataset.aspect = aspect;
        item.innerHTML = `
            <div class="accordion-header">
                <div class="accordion-check" data-aspect="${aspect}">✓</div>
                <span class="accordion-emoji">${info.emoji}</span>
                <span class="accordion-title">${info.label}</span>
                <span class="accordion-status ${status.cls}">${status.label}</span>
                <span class="accordion-chevron">▶</span>
            </div>
            <div class="accordion-body"><div class="accordion-content"><p class="accordion-text">${esc(text)}</p></div></div>
        `;
        item.querySelector('.accordion-header').addEventListener('click', e => { if (!e.target.classList.contains('accordion-check')) item.classList.toggle('open'); });
        item.querySelector('.accordion-check').addEventListener('click', e => {
            e.stopPropagation();
            const isChecked = e.target.classList.toggle('checked');
            item.classList.toggle('selected', isChecked);
            if (isChecked) state.selectedAspects.add(aspect); else state.selectedAspects.delete(aspect);
            updateSelectedBtn();
        });
        dom.aspectList.appendChild(item);
        requestAnimationFrame(() => item.classList.add('revealed'));
    }

    function updateAccordionContent(item, text) {
        const p = item.querySelector('.accordion-text'); if (p) p.textContent = text;
        const status = getStatus(text);
        const badge = item.querySelector('.accordion-status');
        badge.textContent = status.label; badge.className = `accordion-status ${status.cls}`;
    }

    function getStatus(text) {
        if (!text?.trim()) return { label: '未入力', cls: 'empty' };
        if (text.trim().length < 30) return { label: '不足', cls: 'thin' };
        return { label: '✓ OK', cls: 'ok' };
    }

    function highlightAccordion(aspect) {
        $$('.accordion-item').forEach(a => a.classList.remove('selected'));
        const item = dom.aspectList.querySelector(`[data-aspect="${aspect}"]`);
        if (item) { item.classList.add('open'); item.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }

    function updateAspectCount() {
        const allAspects = AILogic.getAspects();
        const total = Object.keys(allAspects).length;
        const count = Object.keys(state.why.aspects).filter(k => state.why.aspects[k]?.trim()).length;
        dom.aspectCountBadge.textContent = `${count}/${total}`;
    }

    function updateSelectedBtn() {
        const n = state.selectedAspects.size;
        dom.selectedCount.textContent = n;
        dom.discussSelectedBtn.disabled = n === 0;
    }

    // ===================================================
    // MULTI-SELECT 壁打ち
    // ===================================================
    function sendSelectedToChat() {
        if (state.selectedAspects.size === 0) return;

        const group = document.createElement('div'); group.className = 'chat-context-group';
        group.innerHTML = `<div class="context-group-label">💬 ${state.selectedAspects.size}つの観点を壁打ち</div>`;
        [...state.selectedAspects].forEach(aspect => {
            const info = AILogic.ASPECTS[aspect];
            const card = document.createElement('div'); card.className = 'chat-context-card';
            card.innerHTML = `<div class="context-card-label">${info.emoji} ${info.label}</div><div class="context-card-text">${esc(state.why.aspects[aspect] || '')}</div>`;
            group.appendChild(card);
        });
        clearWelcome();
        dom.chatMessages.appendChild(group); scroll();

        const aspects = [...state.selectedAspects];
        state.deepDiveMode = true;
        state.currentAspect = aspects[0];

        showTyping();
        setTimeout(() => {
            removeTyping();
            if (aspects.length === 1) {
                renderMsgs(AILogic.deepDive(state.why.aspects[aspects[0]] || '', aspects[0], state.why.aspects[aspects[0]] || '').msgs);
            } else {
                addBubble('ai', `${aspects.length}つの観点を受け取りました。どの観点から深掘りしますか？`);
                const chips = document.createElement('div'); chips.className = 'chat-chips';
                aspects.forEach(a => {
                    const info = AILogic.ASPECTS[a];
                    const el = document.createElement('button'); el.className = 'chat-chip'; el.textContent = `${info.emoji} ${info.label}`;
                    el.addEventListener('click', () => {
                        state.currentAspect = a; state.deepDiveMode = true;
                        addBubble('user', `${info.emoji} ${info.label}`); showTyping();
                        setTimeout(() => { removeTyping(); renderMsgs(AILogic.deepDive(state.why.aspects[a] || '', a, state.why.aspects[a] || '').msgs); }, 400);
                        chips.querySelectorAll('.chat-chip').forEach(ch => { ch.disabled = true; ch.style.opacity = '0.4'; });
                    });
                    chips.appendChild(el);
                });
                dom.chatMessages.appendChild(chips); scroll();
            }
        }, 600);

        state.selectedAspects.clear();
        $$('.accordion-check').forEach(c => c.classList.remove('checked'));
        $$('.accordion-item').forEach(a => a.classList.remove('selected'));
        updateSelectedBtn();
        dom.chatInput.focus();
    }

    // ===================================================
    // PROGRESS
    // ===================================================
    function updateProgress() {
        const allAspects = AILogic.getAspects();
        const total = Object.keys(allAspects).length;
        const filled = Object.keys(state.why.aspects).filter(k => state.why.aspects[k]?.trim()).length;
        const pct = Math.round((filled / total) * 100);
        dom.progressFill.style.width = pct + '%'; dom.progressPct.textContent = pct + '%';
    }

    // ===================================================
    // ACTIONS
    // ===================================================
    function bindActionEvents() {
        dom.startSessionBtn.addEventListener('click', startSession);
        dom.confirmWhyBtn.addEventListener('click', checkAspects);
        dom.submitWhatBtn.addEventListener('click', submitWhat);
        dom.brainstormApproachBtn.addEventListener('click', brainstormApproach);
        dom.finalizeApproachBtn.addEventListener('click', finalizeApproach);
        dom.previewBtn.addEventListener('click', showPreview);
        dom.historyToggleBtn.addEventListener('click', showHistory);
        dom.learningDetailBtn.addEventListener('click', showLearning);
        dom.discussSelectedBtn.addEventListener('click', sendSelectedToChat);
    }

    function startSession() {
        state.phase = 'WHY_SESSION'; updatePhase('WHY_SESSION');
        // STEP1/2は常時編集可能（disabledにしない）
        dom.chatInput.disabled = false; dom.chatSendBtn.disabled = false;
        dom.startSessionBtn.classList.add('hidden');
        dom.confirmWhyBtn.classList.remove('hidden');
        dom.historyToggleBtn.classList.remove('hidden');
        dom.discussSelectedBtn.classList.remove('hidden');
        dom.stepOverview.classList.add('completed-step');
        dom.stepWhy.classList.add('completed-step');

        // 入力値を先にキャプチャ（createNewThreadがリセットするため）
        const overview = dom.overviewInput.value.trim();
        const whyText = dom.whyInput.value.trim();

        // Create thread (this resets inputs)
        createNewThread();
        const thread = state.threads.find(t => t.id === state.activeThreadId);
        if (thread) thread.name = overview.length > 15 ? overview.substring(0, 15) + '…' : overview || '初回分析';
        renderThreadList();

        // 入力値を復元（リセットされたので）
        dom.overviewInput.value = overview;
        dom.whyInput.value = whyText;

        // 再分析
        AILogic.reset();
        const result = AILogic.analyzeInitialInput(overview, whyText);

        // --- Thinking block: 分析中 ---
        const baseCount = Object.keys(AILogic.BASE_ASPECTS).length;
        const analysisBlock = addThinkingBlock('🔍', '入力を分析中...', `概要とWhyから${baseCount}つの観点を読み取ります`, { loading: true, badge: '処理中' });

        setTimeout(() => {
            // Build check results
            let checkHtml = '';
            let detectedCount = 0;
            for (const [key, info] of Object.entries(AILogic.ASPECTS)) {
                const has = result.extractedAspects[key];
                if (has) { checkHtml += `<div class="check-result pass">✓ ${info.emoji} ${info.label}</div>`; detectedCount++; }
                else checkHtml += `<div class="check-result fail">✗ ${info.emoji} ${info.label}: 未検出</div>`;
            }
            if (result.contamination?.hasContamination) {
                const matches = [...result.contamination.howMatches, ...result.contamination.whatMatches];
                checkHtml += `<div class="check-result warn">⚠ How/What表現: 「${matches.join('」「')}」</div>`;
            }

            // Update the thinking block content and auto-collapse
            const content = analysisBlock.querySelector('.thinking-block-content');
            content.innerHTML = checkHtml;
            const titleEl = analysisBlock.querySelector('.thinking-block-title');
            titleEl.textContent = `入力を分析 — ${detectedCount}個の観点を検出`;
            const badgeEl = analysisBlock.querySelector('.thinking-block-badge');
            if (badgeEl) badgeEl.textContent = `${detectedCount}/5`;
            collapseThinkingBlock(analysisBlock, 2000);

            // Create aspect cards
            for (const [aspect, text] of Object.entries(result.extractedAspects)) {
                state.why.aspects[aspect] = text;
                createAccordion(aspect, text);
            }
            if (Object.keys(result.extractedAspects).length > 0) dom.aspectsSection.classList.remove('hidden');
            updateAspectCount(); updateProgress();

            // AI messages (but only the actual conversation messages, not the analysis)
            result.messages.forEach((m, i) => setTimeout(() => renderMsgs([m]), i * 500 + 300));
        }, 800);
    }

    function checkAspects() {
        saveRevision(); showTyping();
        setTimeout(() => {
            removeTyping();

            // 最新のSTEP1/2入力を再分析（編集されている可能性がある）
            const currentOverview = dom.overviewInput.value.trim();
            const currentWhy = dom.whyInput.value.trim();
            if (currentOverview || currentWhy) {
                // 入力が変更されていたら再分析
                const reAnalysis = AILogic.analyzeInitialInput(currentOverview, currentWhy);
                for (const [aspect, text] of Object.entries(reAnalysis.extractedAspects)) {
                    if (!state.why.aspects[aspect]) {
                        state.why.aspects[aspect] = text;
                        const existing = dom.aspectList.querySelector(`[data-aspect="${aspect}"]`);
                        if (!existing) createAccordion(aspect, text);
                        else updateAccordionContent(existing, text);
                    }
                }
                if (Object.keys(reAnalysis.extractedAspects).length > 0) dom.aspectsSection.classList.remove('hidden');
                updateAspectCount(); updateProgress();
            }

            // Thinking block: 観点チェック
            const allAspects = AILogic.getAspects();
            const totalCount = Object.keys(allAspects).length;
            const evalBlock = addThinkingBlock('🔎', '観点をチェック中...', 'チェック中', { loading: true, badge: '診断中' });

            setTimeout(() => {
                const result = AILogic.evaluateWhy(state.why.aspects);
                let checkHtml = '';
                let okCount = 0;
                for (const [key, info] of Object.entries(allAspects)) {
                    const text = state.why.aspects[key] || '';
                    if (!text.trim()) checkHtml += `<div class="check-result fail">✗ ${info.label}: 未入力</div>`;
                    else if (text.trim().length < 30) checkHtml += `<div class="check-result warn">△ ${info.label}: ${text.trim().length}文字</div>`;
                    else { checkHtml += `<div class="check-result pass">✓ ${info.label}: OK</div>`; okCount++; }
                }
                const content = evalBlock.querySelector('.thinking-block-content');
                content.innerHTML = checkHtml;
                const titleEl = evalBlock.querySelector('.thinking-block-title');
                titleEl.textContent = `観点チェック完了 — ${okCount}/${totalCount} OK`;
                const badgeEl = evalBlock.querySelector('.thinking-block-badge');
                if (badgeEl) badgeEl.textContent = result.approved ? '✓ 全項目OK' : '要改善';
                collapseThinkingBlock(evalBlock, 2000);

                // 動的観点の提案があればチップで表示
                if (result.dynamicSuggestions && result.dynamicSuggestions.length > 0) {
                    setTimeout(() => {
                        addBubble('ai', result.msgs[0]?.content || '観点チェックが完了しました。');
                        const chips = document.createElement('div'); chips.className = 'chat-chips';
                        result.dynamicSuggestions.forEach(s => {
                            const el = document.createElement('button'); el.className = 'chat-chip';
                            el.textContent = `${s.emoji} ${s.label}を追加`;
                            el.addEventListener('click', () => {
                                AILogic.addDynamicAspect(s.key, s.label, s.emoji, s.guide);
                                state.why.aspects[s.key] = '';
                                createAccordion(s.key, '');
                                dom.aspectsSection.classList.remove('hidden');
                                updateAspectCount(); updateProgress();
                                addBubble('ai', `${s.emoji} **${s.label}**の観点を追加しました。左パネルで確認して、壁打ちで深掘りしましょう。`);
                                el.disabled = true; el.style.opacity = '0.4';
                                addLearning(`追加観点: ${s.label}`);
                            });
                            chips.appendChild(el);
                        });
                        dom.chatMessages.appendChild(chips); scroll();
                    }, 600);
                } else {
                    result.msgs.forEach((m, i) => setTimeout(() => renderMsgs([m]), i * 400 + 200));
                }

                // チェックのみ—自動遷移はしない
            }, 600);
        }, 800);
    }

    function transitionToWhat() {
        state.phase = 'WHAT_SESSION'; updatePhase('WHAT_SESSION');
        dom.stepWhat.classList.remove('locked', 'hidden'); dom.stepWhat.querySelector('.step-lock').textContent = '🔓';
        $$('.what-field').forEach(t => t.disabled = false);
        dom.confirmWhyBtn.classList.add('hidden'); dom.submitWhatBtn.classList.remove('hidden');
        dom.discussSelectedBtn.classList.add('hidden');
        addLearning('Why確定 — 5つの観点が整理されました');
    }

    function submitWhat() {
        showTyping();
        setTimeout(() => { removeTyping(); renderMsgs(AILogic.processWhat(state.what.fields)); setTimeout(transitionToApproach, 800); }, 600);
    }

    function transitionToApproach() {
        state.phase = 'APPROACH_SESSION'; updatePhase('APPROACH_SESSION');
        $$('.what-field').forEach(t => t.disabled = true);
        dom.stepApproach.classList.remove('locked', 'hidden'); dom.stepApproach.querySelector('.step-lock').textContent = '🔓';
        dom.submitWhatBtn.classList.add('hidden'); dom.brainstormApproachBtn.classList.remove('hidden');
    }

    function brainstormApproach() {
        const opts = AILogic.generateApproachOptions(); state.approach.options = opts;
        renderApproachTable(opts);
        dom.approachTableContainer.classList.remove('hidden'); dom.approachSelection.classList.remove('hidden');
        dom.brainstormApproachBtn.classList.add('hidden'); dom.finalizeApproachBtn.classList.remove('hidden');
        addBubble('ai', '💡 3つの方針案を左パネルに提示しました。');
    }

    function renderApproachTable(opts) {
        const rows = ['概要', 'メリット', 'デメリット', 'リスク'], keys = ['description', 'pros', 'cons', 'risks'];
        let html = '<table class="approach-table"><tr><th></th>' + opts.map(o => `<th>${o.name}</th>`).join('') + '</tr>';
        keys.forEach((k, i) => { html += `<tr><th>${rows[i]}</th>` + opts.map(o => `<td contenteditable="true" data-option="${o.id}" data-key="${k}">${o[k]}</td>`).join('') + '</tr>'; });
        html += '<tr class="approach-radio-row"><th>選択</th>' + opts.map(o => `<td><input type="radio" name="approach-select" value="${o.id}"></td>`).join('') + '</tr></table>';
        dom.approachTableContainer.innerHTML = html;
        $$('input[name="approach-select"]').forEach(r => r.addEventListener('change', () => { state.approach.selectedId = parseInt(r.value); }));
    }

    function finalizeApproach() {
        if (state.approach.selectedId === null) { addBubble('ai', '⚠️ 方針を一つ選択してください。', 'warning'); return; }
        const { messages, approved } = AILogic.validateApproachSelection(state.approach.selectionReason);
        renderMsgs(messages);
        if (approved) {
            state.phase = 'DONE'; updatePhase('DONE');
            dom.finalizeApproachBtn.classList.add('hidden');
            dom.chatInput.disabled = true; dom.approachReason.disabled = true;
            addLearning('要件定義が完了しました');
        }
    }

    function updatePhase(active) {
        const phases = ['INPUT', 'WHY_SESSION', 'WHAT_SESSION', 'APPROACH_SESSION', 'DONE'];
        const idx = phases.indexOf(active);
        $$('.phase-step').forEach(step => {
            const si = phases.indexOf(step.dataset.phase);
            step.classList.remove('active', 'completed');
            if (si < idx) step.classList.add('completed');
            else if (si === idx) step.classList.add('active');
        });
    }

    // ===================================================
    // PREVIEW (構造的・最小限)
    // ===================================================
    function showPreview() {
        const modal = $('#preview-modal'); modal.classList.remove('hidden');
        const content = $('#preview-content');
        let html = '<div class="preview-doc">';
        const ov = dom.overviewInput.value.trim();
        html += `<h4>📋 概要</h4>`;
        if (ov) html += `<div class="preview-point"><span class="preview-point-label">テーマ</span><span>${esc(ov)}</span></div>`;

        html += `<h4>🔍 Why</h4>`;
        Object.entries(AILogic.ASPECTS).forEach(([key, info]) => {
            const text = state.why.aspects[key] || '';
            if (text.trim()) {
                const summary = text.trim().length > 80 ? text.trim().substring(0, 80) + '…' : text.trim();
                html += `<div class="preview-point"><span class="preview-point-label">${info.emoji} ${info.label}</span><span>${esc(summary)}</span></div>`;
            } else {
                html += `<div class="preview-point" style="opacity:0.4;"><span class="preview-point-label">${info.emoji} ${info.label}</span><span style="color:var(--accent-danger);">未整理</span></div>`;
            }
        });

        if (['WHAT_SESSION', 'APPROACH_SESSION', 'DONE'].includes(state.phase)) {
            html += `<h4>💡 What</h4>`;
            Object.entries({ value: '提供する価値', scope: 'スコープ', success: '成功指標' }).forEach(([k, l]) => {
                const v = state.what.fields[k]?.trim() || '';
                if (v) html += `<div class="preview-point"><span class="preview-point-label">${l}</span><span>${esc(v.length > 80 ? v.substring(0, 80) + '…' : v)}</span></div>`;
            });
        }
        if (state.phase === 'DONE' && state.approach.selectedId !== null) {
            const sel = state.approach.options[state.approach.selectedId];
            html += `<h4>🎯 選定方針</h4>`;
            html += `<div class="preview-point"><span class="preview-point-label">方針</span><span>${esc(sel.name)}</span></div>`;
        }
        html += '</div>';
        content.innerHTML = html;
    }

    // ===================================================
    // HISTORY / LEARNING / MODALS
    // ===================================================
    function saveRevision() {
        state.why.revisions.push({ version: state.why.revisions.length + 1, aspects: JSON.parse(JSON.stringify(state.why.aspects)), timestamp: new Date().toLocaleTimeString('ja-JP') });
    }

    function showHistory() {
        const modal = $('#history-modal'); modal.classList.remove('hidden');
        const content = $('#history-content');
        if (!state.why.revisions.length) { content.innerHTML = '<p class="text-muted">まだ修正履歴はありません</p>'; return; }
        let html = '';
        state.why.revisions.forEach(rev => {
            html += `<h4 style="color:var(--accent-primary);margin:12px 0 6px;">v${rev.version} (${rev.timestamp})</h4>`;
            Object.entries(AILogic.ASPECTS).forEach(([k, info]) => { const v = rev.aspects[k]; if (v) html += `<div style="padding:6px;border-left:3px solid var(--accent-primary);margin-bottom:4px;font-size:var(--font-sm);"><strong>${info.label}</strong>: ${esc(v)}</div>`; });
        });
        content.innerHTML = html;
    }

    function addLearning(insight) { state.learningLog.push({ insight, timestamp: new Date().toLocaleTimeString('ja-JP') }); dom.learningCount.textContent = state.learningLog.length; }

    function showLearning() {
        const modal = $('#learning-modal'); modal.classList.remove('hidden');
        const content = $('#learning-content');
        if (!state.learningLog.length) { content.innerHTML = '<p class="text-muted">まだ改善履歴はありません</p>'; return; }
        let html = '';
        state.learningLog.forEach(e => {
            html += `<div style="padding:8px;border-left:3px solid var(--accent-primary);margin-bottom:6px;background:rgba(99,102,241,0.05);border-radius:0 4px 4px 0;"><div style="font-size:10px;color:var(--text-muted);">${e.timestamp}</div><div style="font-size:var(--font-sm);">${e.insight}</div></div>`;
        });
        content.innerHTML = html;
    }

    function bindModalEvents() {
        $$('.modal-close').forEach(btn => btn.addEventListener('click', () => $(`#${btn.dataset.modal}`).classList.add('hidden')));
        $$('.modal-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) o.classList.add('hidden'); }));
    }

    document.addEventListener('DOMContentLoaded', init);
})();
