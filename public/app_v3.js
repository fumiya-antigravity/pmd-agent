/* ===================================================
   CLARIX — Why Discovery Engine  App v3
   フロントエンドロジック: Phase遷移 + API呼出し + UI更新
   =================================================== */

const ClarixApp = (() => {
    'use strict';

    // ===================================================
    // State
    // ===================================================
    let currentSessionId = null;
    let currentPhase = 'WELCOME';
    let sliderData = [];
    let isProcessing = false;

    // ===================================================
    // DOM Elements
    // ===================================================
    const $ = id => document.getElementById(id);
    const el = {
        sidebar: $('sidebar'),
        sessionList: $('sessionList'),
        newSessionBtn: $('newSessionBtn'),
        debugToggle: $('debugToggle'),
        // Phases
        phaseWelcome: $('phaseWelcome'),
        phaseConversation: $('phaseConversation'),
        phaseSlider: $('phaseSlider'),
        phaseReport: $('phaseReport'),
        // Chat
        chatMessages: $('chatMessages'),
        debugPanel: $('debugPanel'),
        // Debug values
        debugMgu: $('debugMgu'),
        debugSqc: $('debugSqc'),
        debugType: $('debugType'),
        debugTurn: $('debugTurn'),
        debugPurpose: $('debugPurpose'),
        // Slider
        sliderItems: $('sliderItems'),
        sliderPurpose: $('sliderPurpose'),
        sliderBackBtn: $('sliderBackBtn'),
        sliderSubmitBtn: $('sliderSubmitBtn'),
        // Report
        reportContent: $('reportContent'),
        reportNewBtn: $('reportNewBtn'),
        // Input
        inputArea: $('inputArea'),
        userInput: $('userInput'),
        sendBtn: $('sendBtn'),
        // Loading
        loadingOverlay: $('loadingOverlay'),
    };

    // ===================================================
    // Init
    // ===================================================
    function init() {
        setupEventListeners();
        loadSessionList();
        showPhase('WELCOME');
    }

    function setupEventListeners() {
        el.newSessionBtn.addEventListener('click', createNewSession);
        el.sendBtn.addEventListener('click', handleSend);
        el.userInput.addEventListener('input', handleInputChange);
        el.userInput.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
            }
        });
        el.debugToggle.addEventListener('change', e => {
            el.debugPanel.style.display = e.target.checked ? 'block' : 'none';
        });
        el.sliderBackBtn.addEventListener('click', handleSliderBack);
        el.sliderSubmitBtn.addEventListener('click', handleSliderSubmit);
        el.reportNewBtn.addEventListener('click', createNewSession);
    }

    // ===================================================
    // Phase Management
    // ===================================================
    function showPhase(phase) {
        currentPhase = phase;
        [el.phaseWelcome, el.phaseConversation, el.phaseSlider, el.phaseReport].forEach(p => {
            p.style.display = 'none';
            p.classList.remove('active');
        });

        switch (phase) {
            case 'WELCOME':
                el.phaseWelcome.style.display = 'flex';
                el.phaseWelcome.classList.add('active');
                el.inputArea.style.display = 'block';
                break;
            case 'CONVERSATION':
                el.phaseConversation.style.display = 'flex';
                el.phaseConversation.classList.add('active');
                el.inputArea.style.display = 'block';
                break;
            case 'SLIDER':
                el.phaseSlider.style.display = 'flex';
                el.phaseSlider.classList.add('active');
                el.inputArea.style.display = 'none';
                break;
            case 'REPORT':
            case 'COMPLETE':
                el.phaseReport.style.display = 'flex';
                el.phaseReport.classList.add('active');
                el.inputArea.style.display = 'none';
                break;
        }
    }

    // ===================================================
    // Session Management
    // ===================================================
    async function createNewSession() {
        try {
            const resp = await fetch('/api/session', { method: 'POST' });
            const data = await resp.json();
            if (data.error) throw new Error(data.error);

            currentSessionId = data.session_id;
            el.chatMessages.innerHTML = '';
            sliderData = [];
            showPhase('WELCOME');
            loadSessionList();
            el.userInput.focus();
        } catch (err) {
            console.error('[createNewSession]', err);
            alert('セッション作成に失敗しました: ' + err.message);
        }
    }

    async function loadSessionList() {
        try {
            const sessions = await SupabaseClient.listSessions();
            el.sessionList.innerHTML = '';
            (sessions || []).forEach(s => {
                const item = document.createElement('div');
                item.className = `session-item${s.id === currentSessionId ? ' active' : ''}`;
                const phase = (s.phase || 'WELCOME').toLowerCase();
                item.innerHTML = `<span class="phase-dot ${phase}"></span><span>${s.title || '新しい壁打ち'}</span>`;
                item.addEventListener('click', () => loadSession(s.id));
                el.sessionList.appendChild(item);
            });
        } catch (err) {
            console.error('[loadSessionList]', err);
        }
    }

    async function loadSession(sessionId) {
        currentSessionId = sessionId;
        try {
            const session = await SupabaseClient.getSession(sessionId);
            if (!session) return;

            const phase = session.phase || 'WELCOME';

            switch (phase) {
                case 'WELCOME':
                    showPhase('WELCOME');
                    break;

                case 'CONVERSATION': {
                    showPhase('CONVERSATION');
                    const messages = await SupabaseClient.getMessages(sessionId, 100);
                    renderMessages(messages || []);
                    const goal = await SupabaseClient.getLatestGoal(sessionId);
                    if (goal) updateDebug({ mgu: goal.mgu, sqc: goal.sqc, question_type: goal.question_type, session_purpose: goal.session_purpose });
                    break;
                }

                case 'SLIDER': {
                    const insights = await SupabaseClient.getConfirmedInsights(sessionId);
                    const anchor = await SupabaseClient.getSessionAnchor(sessionId);
                    const goal = await SupabaseClient.getLatestGoal(sessionId);
                    sliderData = Synthesizer.run(insights, anchor?.original_message || '');
                    showPhase('SLIDER');
                    renderSliders(sliderData, goal?.session_purpose || '');
                    break;
                }

                case 'REPORT':
                case 'COMPLETE': {
                    const report = await SupabaseClient.getReport(sessionId);
                    showPhase('REPORT');
                    renderReport(report?.report_markdown || 'レポートが見つかりません');
                    break;
                }
            }

            loadSessionList();
        } catch (err) {
            console.error('[loadSession]', err);
        }
    }

    // ===================================================
    // Chat
    // ===================================================
    function handleInputChange() {
        el.sendBtn.disabled = !el.userInput.value.trim();
        // Auto-resize textarea
        el.userInput.style.height = 'auto';
        el.userInput.style.height = Math.min(el.userInput.scrollHeight, 120) + 'px';
    }

    async function handleSend() {
        const text = el.userInput.value.trim();
        if (!text || isProcessing) return;

        // セッションなし → 自動作成
        if (!currentSessionId) {
            try {
                const resp = await fetch('/api/session', { method: 'POST' });
                const data = await resp.json();
                if (data.error) throw new Error(data.error);
                currentSessionId = data.session_id;
            } catch (err) {
                alert('セッション作成に失敗: ' + err.message);
                return;
            }
        }

        // UIにユーザーメッセージ追加
        addChatBubble('user', text);
        el.userInput.value = '';
        el.userInput.style.height = 'auto';
        el.sendBtn.disabled = true;

        // フェーズ遷移
        if (currentPhase === 'WELCOME') {
            showPhase('CONVERSATION');
        }

        // API呼出し
        isProcessing = true;
        showLoading(true);
        showTypingIndicator();

        try {
            const resp = await fetch('/api/process', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: currentSessionId, user_message: text }),
            });
            const result = await resp.json();

            removeTypingIndicator();

            if (result.error) {
                addChatBubble('assistant', `⚠️ エラー: ${result.error}`);
                return;
            }

            // Phase分岐
            if (result.phase === 'CONVERSATION') {
                addChatBubble('assistant', result.message);
                if (result.debug) updateDebug(result.debug);
                if (result.turn !== undefined) {
                    if ($('debugTurn')) $('debugTurn').textContent = result.turn;
                }
            } else if (result.phase === 'SLIDER') {
                sliderData = result.insights;
                showPhase('SLIDER');
                renderSliders(result.insights, result.session_purpose || '');
            }

            loadSessionList();
        } catch (err) {
            removeTypingIndicator();
            addChatBubble('assistant', `⚠️ 通信エラー: ${err.message}`);
        } finally {
            isProcessing = false;
            showLoading(false);
        }
    }

    function addChatBubble(role, text) {
        const bubble = document.createElement('div');
        bubble.className = `chat-bubble ${role}`;
        bubble.textContent = text;
        el.chatMessages.appendChild(bubble);
        el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
    }

    function renderMessages(messages) {
        el.chatMessages.innerHTML = '';
        messages.forEach(m => addChatBubble(m.role, m.content));
    }

    function showTypingIndicator() {
        const indicator = document.createElement('div');
        indicator.className = 'typing-indicator';
        indicator.id = 'typingIndicator';
        indicator.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
        el.chatMessages.appendChild(indicator);
        el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
    }

    function removeTypingIndicator() {
        const indicator = $('typingIndicator');
        if (indicator) indicator.remove();
    }

    function updateDebug(debug) {
        if (!debug) return;
        if (el.debugMgu) el.debugMgu.textContent = debug.mgu ?? '-';
        if (el.debugSqc) el.debugSqc.textContent = debug.sqc ?? '-';
        if (el.debugType) el.debugType.textContent = debug.question_type ?? '-';
        if (el.debugPurpose) el.debugPurpose.textContent = debug.session_purpose ?? '-';
    }

    function showLoading(show) {
        el.loadingOverlay.style.display = show ? 'flex' : 'none';
    }

    // ===================================================
    // Slider
    // ===================================================
    function renderSliders(insights, sessionPurpose) {
        el.sliderPurpose.textContent = sessionPurpose;
        el.sliderItems.innerHTML = '';

        insights.forEach((ins, i) => {
            const card = document.createElement('div');
            card.className = 'slider-card';
            card.innerHTML = `
                <div class="slider-card-header">
                    <span class="slider-card-label">${ins.label}</span>
                    <div class="slider-card-meta">
                        <span class="layer-badge ${ins.layer}">${ins.layer}</span>
                        ${ins.johari_blind_spot ? '<span class="blind-spot-badge">🔍 盲点</span>' : ''}
                    </div>
                </div>
                <div class="slider-input-row">
                    <input type="range" min="0" max="100" value="${ins.slider_value || ins.strength}"
                           data-insight-id="${ins.id}" data-index="${i}">
                    <span class="slider-weight-value" id="sliderVal${i}">${ins.slider_value || ins.strength}%</span>
                </div>
            `;
            const rangeInput = card.querySelector('input[type="range"]');
            rangeInput.addEventListener('input', e => {
                $(`sliderVal${i}`).textContent = e.target.value + '%';
            });
            el.sliderItems.appendChild(card);
        });
    }

    async function handleSliderBack() {
        if (!currentSessionId) return;
        try {
            const resp = await fetch('/api/process/resume', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: currentSessionId }),
            });
            const result = await resp.json();
            if (result.error) throw new Error(result.error);

            showPhase('CONVERSATION');
            const messages = await SupabaseClient.getMessages(currentSessionId, 100);
            renderMessages(messages || []);
            loadSessionList();
        } catch (err) {
            alert('会話に戻れませんでした: ' + err.message);
        }
    }

    async function handleSliderSubmit() {
        if (!currentSessionId) return;

        // スライダー値を収集
        const sliders = el.sliderItems.querySelectorAll('input[type="range"]');
        const weights = {};
        sliders.forEach(s => {
            const id = s.dataset.insightId;
            if (id) weights[id] = parseInt(s.value);
        });

        isProcessing = true;
        showLoading(true);

        try {
            const resp = await fetch('/api/report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: currentSessionId, slider_weights: weights }),
            });
            const result = await resp.json();
            if (result.error) throw new Error(result.error);

            showPhase('REPORT');
            renderReport(result.report_markdown);
            loadSessionList();
        } catch (err) {
            alert('レポート生成に失敗しました: ' + err.message);
        } finally {
            isProcessing = false;
            showLoading(false);
        }
    }

    // ===================================================
    // Report
    // ===================================================
    function renderReport(markdown) {
        if (typeof marked !== 'undefined') {
            el.reportContent.innerHTML = marked.parse(markdown);
        } else {
            el.reportContent.textContent = markdown;
        }
    }

    // ===================================================
    // Boot
    // ===================================================
    document.addEventListener('DOMContentLoaded', init);

    return { createNewSession, loadSession };
})();
