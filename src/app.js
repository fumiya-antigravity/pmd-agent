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
        // Supabase
        sessionId: null,   // 現在のSupabaseセッションID (UUID)
    };

    /* ---------- DB SYNC LAYER (非破壊的永続化) ---------- */
    const dbSync = {
        enabled: false,

        async init() {
            try {
                if (typeof SupabaseClient === 'undefined') {
                    console.warn('[dbSync] SupabaseClient未読込。DB同期無効。');
                    return;
                }
                const client = SupabaseClient.getClient();
                if (!client) {
                    console.warn('🔬[init] SupabaseClient.getClient() returned null');
                    return;
                }
                this.enabled = true;
                console.log('🔬[init] DB同期有効化');

                // 既存セッション一覧をサイドバーに反映
                const sessions = await SupabaseClient.listSessions(20);
                if (sessions?.length) {
                    sessions.forEach(s => {
                        state.threadCounter++;
                        const thread = {
                            id: state.threadCounter,
                            dbId: s.id,
                            name: s.title,
                            time: new Date(s.updated_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
                            messagesHtml: '',
                            phase: s.phase || 'WHY_SESSION',
                            aspects: {},
                            overview: '',
                            whyText: '',
                            isActive: false,
                        };
                        state.threads.push(thread);
                    });
                    renderThreads();
                    console.log(`[dbSync] ${sessions.length}件のセッションを復元`);
                }
            } catch (e) {
                console.warn('[dbSync] 初期化失敗:', e.message);
                this.enabled = false;
            }
        },

        async createSession(title, overview, whyText) {
            if (!this.enabled) return null;
            try {
                const session = await SupabaseClient.createSession(title, overview, whyText);
                state.sessionId = session.id;
                console.log('[dbSync] セッション作成:', session.id);
                return session;
            } catch (e) {
                console.warn('[dbSync] セッション作成失敗:', e.message);
                return null;
            }
        },

        async saveMessage(role, content, metadata = {}) {
            if (!this.enabled || !state.sessionId) {
                console.warn('[dbSync] saveMessageスキップ: enabled=', this.enabled, 'sessionId=', state.sessionId);
                return null;
            }
            try {
                const result = await SupabaseClient.saveMessage(state.sessionId, role, content, metadata);
                console.log(`[dbSync] メッセージ保存成功: role=${role}, id=${result?.id?.substring(0, 8)}`);
                return result;
            } catch (e) {
                console.error('[dbSync] メッセージ保存失敗:', e.message, e);
                return null;
            }
        },

        async saveAspectState(aspectKey, updates) {
            if (!this.enabled || !state.sessionId) {
                console.warn(`[dbSync] saveAspectStateスキップ(${aspectKey}): enabled=`, this.enabled, 'sessionId=', state.sessionId);
                return;
            }
            try {
                await SupabaseClient.upsertAspectState(state.sessionId, aspectKey, updates);
                console.log(`[dbSync] 観点保存成功: ${aspectKey}=${updates.status}`);
            } catch (e) {
                console.error(`[dbSync] 観点保存失敗(${aspectKey}):`, e.message, e);
            }
        },

        async saveAnalysisResult(messageId, analysisType, result) {
            if (!this.enabled || !state.sessionId) {
                console.warn('[dbSync] saveAnalysisResultスキップ: enabled=', this.enabled, 'sessionId=', state.sessionId);
                return;
            }
            try {
                await SupabaseClient.saveAnalysisResult(state.sessionId, messageId, analysisType, result);
                console.log(`[dbSync] 分析結果保存成功: type=${analysisType}, msgId=${messageId?.substring(0, 8)}`);
            } catch (e) {
                console.error(`[dbSync] 分析結果保存失敗:`, e.message, e);
            }
        },

        async updateSessionPhase(phase) {
            if (!this.enabled || !state.sessionId) return;
            try {
                await SupabaseClient.updateSession(state.sessionId, { phase });
            } catch (e) {
                console.warn('[dbSync] フェーズ更新失敗:', e.message);
            }
        },

        async saveSnapshot(volNumber, messageId, snapshot) {
            if (!this.enabled || !state.sessionId) {
                console.warn('[dbSync] saveSnapshotスキップ');
                return;
            }
            try {
                await SupabaseClient.saveSnapshot(state.sessionId, volNumber, messageId, snapshot);
                console.log(`[dbSync] スナップショット保存成功: Vol.${volNumber}`);
            } catch (e) {
                console.error(`[dbSync] スナップショット保存失敗(Vol.${volNumber}):`, e.message, e);
            }
        },

        async loadSession(dbId) {
            if (!this.enabled) {
                console.warn('🔬[loadSession] enabled=false, return null');
                return null;
            }
            try {
                console.log(`🔬[loadSession] 開始: dbId=${dbId}`);
                const [session, messages, aspectStates] = await Promise.all([
                    SupabaseClient.getSession(dbId),
                    SupabaseClient.getMessages(dbId, 50),
                    SupabaseClient.getAllAspectStates(dbId),
                ]);
                console.log(`🔬[loadSession] 取得結果: session=${!!session}, messages=${messages?.length || 0}件, aspectStates=${Object.keys(aspectStates || {}).length}件`);
                if (messages?.length) {
                    messages.forEach((m, i) => {
                        console.log(`🔬[loadSession] msg[${i}]: role=${m.role}, id=${m.id?.substring(0, 8)}, metadata.type=${m.metadata?.type || 'N/A'}, contentLen=${m.content?.length}`);
                    });
                }
                // snapshots は別途取得（テーブル未作成でも他データに影響しない）
                let snapshots = [];
                try {
                    snapshots = await SupabaseClient.getSnapshots(dbId);
                    console.log(`🔬[loadSession] snapshots=${snapshots?.length || 0}件`);
                } catch (e) {
                    console.warn('🔬[loadSession] スナップショット読込スキップ:', e.message);
                }
                return { session, messages, aspectStates, snapshots };
            } catch (e) {
                console.error('🔬[loadSession] セッション読込失敗:', e.message, e);
                return null;
            }
        },
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

    async function init() {
        cacheDom();
        bindAll();
        await dbSync.init();
        console.log(`🔬[init] PdM v2.3 initialized. dbSync.enabled=${dbSync.enabled}, threads=${state.threads.length}`);

        // 🔹 アクティブセッション自動復元
        const lastSessionId = localStorage.getItem('pdm_active_session');
        console.log(`🔬[init] lastSessionId=${lastSessionId}`);
        if (lastSessionId) {
            const thread = state.threads.find(t => t.dbId === lastSessionId);
            console.log(`🔬[init] thread found=${!!thread}, threadId=${thread?.id}, threadPhase=${thread?.phase}, messagesHtml.len=${thread?.messagesHtml?.length}`);
            if (thread) {
                console.log('🔬[init] switchThread呼出開始');
                await switchThread(thread.id);
                console.log('🔬[init] switchThread呼出完了');
            } else {
                console.warn('🔬[init] threadが見つからない。localStorage削除。');
                localStorage.removeItem('pdm_active_session');
            }
        }
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

        // 🔹 Supabaseセッション作成
        const dbSession = await dbSync.createSession(name, overview, whyText);
        if (dbSession) {
            thread.dbId = dbSession.id;
            localStorage.setItem('pdm_active_session', dbSession.id);
        }

        // Initial User Message (History)
        addMsg('user', `## 概要\n${overview}\n\n## Why\n${whyText}`);
        // 🔹 初回メッセージをDB保存
        await dbSync.saveMessage('user', `## 概要\n${overview}\n\n## Why\n${whyText}`);

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
        dbSync.updateSessionPhase('WHY_SESSION');
        dom.topBarTitle.textContent = name;
        dom.chatInput.disabled = true;

        showTyping();

        try {
            const result = await Pipeline.analyzeInitialInput(overview, whyText, state.sessionId, state.abortCtrl.signal);
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

            // プロセスログ表示（AIリクエスト/レスポンスの過程）
            if (result._processLog) {
                addProcessLogBlock(result._processLog);
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

                // 🔹 Vol.1スナップショットをDB保存
                const vol1Snapshot = {};
                for (const key of Object.keys(ASPECT_META)) {
                    vol1Snapshot[key] = {
                        status: state.aspectStatus[key] || 'empty',
                        text: state.aspects[key] || '',
                        reason: state.aspectReason[key] || '',
                        advice: state.aspectAdvice[key] || '',
                        quoted: state.aspectQuoted[key] || '',
                        example: state.aspectExample[key] || '',
                    };
                }
                await dbSync.saveSnapshot(state.summaryVol, null, vol1Snapshot);
            }
            for (const key of Object.keys(ASPECT_META)) {
                if (!state.aspects.hasOwnProperty(key)) state.aspects[key] = '';
                createAspectCard(key, state.aspects[key]);
            }
            updateProgress();

            // AI message（UI表示）
            if (result.message) {
                addMsg('ai', result.message);
            }

            // 🔹 DB保存（result.messageの有無に関わらず必ず実行）
            const aiHistoryEntry = result.message || '[初回分析完了]';
            if (result.aspectUpdates) {
                const summary = Object.entries(result.aspectUpdates)
                    .map(([k, v]) => `${k}=${v.status}`)
                    .join(', ');
                state.conversationHistory.push({
                    role: 'assistant',
                    content: aiHistoryEntry + `\n[初回分析: ${summary}]`,
                });
            } else {
                state.conversationHistory.push({ role: 'assistant', content: aiHistoryEntry });
            }

            // 🔹 [A1] AIメッセージをDB保存（初回分析）— message有無に関わらず必ず実行
            const aiMsgRecord = await dbSync.saveMessage('assistant', state.conversationHistory[state.conversationHistory.length - 1].content, {
                type: 'initial_analysis',
                aspectUpdates: result.aspectUpdates || {},
            });
            console.log(`🔬[startSession] aiMsgRecord: id=${aiMsgRecord?.id?.substring(0, 8) || 'NULL'}, saved=${!!aiMsgRecord}`);

            // 🔹 [A3] 分析結果をDB保存
            await dbSync.saveAnalysisResult(
                aiMsgRecord?.id || null,
                'initial_analysis',
                result
            );
            console.log(`🔬[startSession] analysisResult saved: messageId=${aiMsgRecord?.id?.substring(0, 8) || 'NULL'}`);

            // 🔹 [A2] 全観点のaspectStateをDB保存
            if (result.aspectUpdates) {
                for (const [key, info] of Object.entries(result.aspectUpdates)) {
                    await dbSync.saveAspectState(key, {
                        status: info.status || 'empty',
                        text_content: info.text || '',
                        reason: info.reason || '',
                        advice: info.advice || '',
                        quoted: info.quoted || '',
                        example: info.example || '',
                        updated_by: 'initial_analysis',
                    });
                }
                console.log('🔬[startSession] 全観点DB保存完了');
            }

            // 🔹 Vol.1スナップショットのmessage_idを更新（aiMsgRecord作成後）
            if (aiMsgRecord?.id && state.summaryVol > 0) {
                console.log(`🔬[startSession] Vol.${state.summaryVol} snapshot messageId更新`);
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
        // 🔹 ユーザーメッセージをDB保存
        const userMsgRecord = await dbSync.saveMessage('user', text);
        showTyping();

        try {
            const result = await Pipeline.chat(text, {
                sessionId: state.sessionId,
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

            // プロセスログ表示（AIリクエスト/レスポンスの過程）
            if (result._processLog) {
                addProcessLogBlock(result._processLog);
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

                // 🔹 Volスナップショット保存
                const volSnapshot = {};
                for (const key of Object.keys(ASPECT_META)) {
                    volSnapshot[key] = {
                        status: state.aspectStatus[key] || 'empty',
                        text: state.aspects[key] || '',
                        reason: state.aspectReason[key] || '',
                        advice: state.aspectAdvice[key] || '',
                        quoted: state.aspectQuoted[key] || '',
                        example: state.aspectExample[key] || '',
                    };
                }
                await dbSync.saveSnapshot(state.summaryVol, null, volSnapshot);
            }

            // Related aspect updates (関連観点の連動更新)
            // ※ pipeline.jsのfilterRelatedUpdatesで既にフィルタリング済み
            if (result.relatedUpdates?.length) {
                console.log('[relatedUpdates] AIから返却（フィルタ済み）:', JSON.stringify(result.relatedUpdates, null, 2));
                const appliedUpdates = [];
                result.relatedUpdates.forEach(ru => {
                    if (!ru.aspect) { console.log('[relatedUpdates] aspectなし、スキップ:', ru); return; }
                    if (!ru.newText?.trim()) { console.log(`[relatedUpdates] ${ru.aspect}: newTextが空、スキップ`); return; }

                    // テキスト更新
                    state.aspects[ru.aspect] = ru.newText;
                    if (ru.newStatus) {
                        state.aspectStatus[ru.aspect] = ru.newStatus;
                    }
                    // reason/advice/quoted/example も保存
                    if (ru.reason) state.aspectReason[ru.aspect] = ru.reason;
                    if (ru.advice) state.aspectAdvice[ru.aspect] = ru.advice;
                    if (ru.quoted) state.aspectQuoted[ru.aspect] = ru.quoted;
                    if (ru.example) state.aspectExample[ru.aspect] = ru.example;

                    updateAspectCard(ru.aspect, state.aspects[ru.aspect]);
                    appliedUpdates.push(ru.aspect);
                    console.log(`[relatedUpdates] ${ru.aspect}: 更新成功 (action=${ru.action}, status=${ru.newStatus})`);
                });
                if (appliedUpdates.length) {
                    updateProgress();
                    // 更新をチャットに表示（ユーザーに可視化）
                    const labels = appliedUpdates.map(a => ASPECT_META[a]?.label || a).join('、');
                    addSystemMsg(`🔄 関連する観点を更新しました: ${labels}`);
                }
            } else {
                console.log('[relatedUpdates] AIからrelatedUpdatesが返されませんでした');
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

            // AI message（UI表示）
            if (result.message) {
                addMsg('ai', result.message);
            }

            // 🔹 DB保存（result.messageの有無に関わらず必ず実行）— 05ルール§6準拠
            const aiHistoryEntry = result.message || '[分析完了]';
            let historyEntry = aiHistoryEntry;
            if (update) {
                historyEntry += `\n[分析結果: ${update.aspect}=${update.status}, text要約="${(update.text || '').substring(0, 100)}"]`;
            }
            if (result.relatedUpdates?.length) {
                historyEntry += `\n[関連更新: ${result.relatedUpdates.map(ru => `${ru.aspect}=${ru.newStatus}`).join(', ')}]`;
            }
            state.conversationHistory.push({ role: 'assistant', content: historyEntry });

            // 🔹 AIメッセージをDB保存
            const aiMsgRecord = await dbSync.saveMessage('assistant', historyEntry, {
                aspectUpdate: update || null,
                relatedUpdates: result.relatedUpdates || [],
            });
            console.log(`🔬[actualSend] aiMsgRecord: id=${aiMsgRecord?.id?.substring(0, 8) || 'NULL'}, saved=${!!aiMsgRecord}`);

            // 🔹 分析結果をDB保存
            await dbSync.saveAnalysisResult(
                aiMsgRecord?.id || null,
                state.deepDiveMode ? 'deep_dive' : 'why_session',
                result
            );
            console.log(`🔬[actualSend] analysisResult saved: messageId=${aiMsgRecord?.id?.substring(0, 8) || 'NULL'}`);

            // 🔹 観点状態をDB保存
            if (update?.aspect) {
                await dbSync.saveAspectState(update.aspect, {
                    status: update.status || 'thin',
                    text_content: update.text || '',
                    reason: update.reason || '',
                    advice: update.advice || '',
                    quoted: update.quoted || '',
                    example: update.example || '',
                    updated_by: 'ai_direct',
                });
            }
            // 🔹 relatedUpdatesの観点もDB保存
            if (result.relatedUpdates?.length) {
                for (const ru of result.relatedUpdates) {
                    if (ru.aspect && ru.action !== 'skip' && ru.newText?.trim()) {
                        await dbSync.saveAspectState(ru.aspect, {
                            status: ru.newStatus || 'thin',
                            text_content: ru.newText || '',
                            reason: ru.reason || '',
                            advice: ru.advice || '',
                            quoted: ru.quoted || '',
                            example: ru.example || '',
                            updated_by: 'ai_related',
                        });
                    }
                }
            }
            console.log('🔬[actualSend] 全DB保存完了');

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
            const result = await Pipeline.checkAspects(state.aspects, state.abortCtrl.signal);
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
        state.sessionId = null;  // 🔹 DBセッションリセット
        localStorage.removeItem('pdm_active_session');  // 🔹 アクティブセッション解除
        dom.topBarTitle.textContent = '💎 PdM Assistant';
        dom.startBtn.disabled = true;
        dom.startBtn.textContent = '🚀 壁打ちを開始する';
        updatePhase('INPUT');
        checkForm();
    }

    async function switchThread(id) {
        if (id === state.activeThreadId) return;
        if (state.sending) cancelSend();
        saveThread();
        state.threads.forEach(t => t.isActive = (t.id === id));
        state.activeThreadId = id;
        const thread = state.threads.find(t => t.id === id);
        // 🔹 アクティブセッションをlocalStorageに保存
        if (thread?.dbId) localStorage.setItem('pdm_active_session', thread.dbId);
        if (!thread) return;

        // 🔹 DBセッションIDを設定
        state.sessionId = thread.dbId || null;

        // 🔹 DBからデータを読み込み（dbIdがある場合）
        console.log(`[switchThread DEBUG] dbId=${thread.dbId}, enabled=${dbSync.enabled}, messagesHtml='${(thread.messagesHtml || '').substring(0, 20)}', !messagesHtml=${!thread.messagesHtml}`);
        if (thread.dbId && dbSync.enabled && !thread.messagesHtml) {
            try {
                const data = await dbSync.loadSession(thread.dbId);
                // 分析結果も読み込み
                let analysisResults = [];
                try {
                    analysisResults = await SupabaseClient.getAnalysisResults(thread.dbId, 50);
                } catch (e) {
                    console.warn('[switchThread] 分析結果読み込み失敗:', e.message);
                }

                if (data) {
                    console.log(`[switchThread DEBUG] data loaded: session=${!!data.session}, messages=${data.messages?.length}, aspectStates=${Object.keys(data.aspectStates || {}).length}, snapshots=${data.snapshots?.length}`);
                    // セッション情報を復元
                    thread.overview = data.session.overview || '';
                    thread.whyText = data.session.why_text || '';
                    thread.phase = data.session.phase || 'WHY_SESSION';

                    // 観点状態を復元（全5観点を初期化）
                    thread.aspects = {};
                    thread.aspectStatus = {};
                    thread.aspectAdvice = {};
                    thread.aspectReason = {};
                    thread.aspectQuoted = {};
                    thread.aspectExample = {};

                    // 全観点を初期化（DBに無い観点もemptyとして確保）
                    for (const key of Object.keys(ASPECT_META)) {
                        thread.aspects[key] = '';
                        thread.aspectStatus[key] = 'empty';
                    }

                    // DBの観点状態で上書き
                    if (data.aspectStates) {
                        for (const [key, as] of Object.entries(data.aspectStates)) {
                            thread.aspects[key] = as.text_content || '';
                            thread.aspectStatus[key] = as.status || 'empty';
                            if (as.reason) thread.aspectReason[key] = as.reason;
                            if (as.advice) thread.aspectAdvice[key] = as.advice;
                            if (as.quoted) thread.aspectQuoted[key] = as.quoted;
                            if (as.example) thread.aspectExample[key] = as.example;
                            console.log(`[switchThread] 観点復元: ${key} status=${as.status}, text=${(as.text_content || '').substring(0, 30)}`);
                        }
                    }

                    // 会話履歴とUIを復元
                    if (data.messages?.length) {
                        thread.conversationHistory = data.messages.map(m => ({
                            role: m.role, content: m.content,
                        }));

                        // 分析結果をメッセージIDでインデックス化 + フォールバック用キュー
                        const analysisByMsgId = {};
                        // message_idがnullの分析結果をcreated_at昇順のキューとして確保
                        const orphanedAnalysis = [];
                        // created_at昇順に並べ替え（getAnalysisResultsはdescなので逆転）
                        const sortedResults = [...analysisResults].sort((a, b) =>
                            new Date(a.created_at) - new Date(b.created_at)
                        );
                        sortedResults.forEach(ar => {
                            if (ar.message_id) {
                                analysisByMsgId[ar.message_id] = ar;
                            } else {
                                orphanedAnalysis.push(ar);
                                console.warn(`[switchThread] message_id=nullの分析結果: type=${ar.analysis_type}, id=${ar.id?.substring(0, 8)}`);
                            }
                        });
                        let orphanIdx = 0; // フォールバック用インデックス

                        // メッセージHTMLを再構築（特殊UI要素も含む）
                        let html = '';
                        let summaryVolCount = 0;

                        // スナップショットをVol番号でインデックス化
                        const snapshotByVol = {};
                        if (data.snapshots?.length) {
                            data.snapshots.forEach(s => snapshotByVol[s.vol_number] = s.snapshot);
                            console.log(`[switchThread] ${data.snapshots.length}件のSnapshots読込`);
                        }
                        data.messages.forEach((m, idx) => {
                            console.log(`[switchThread DEBUG] msg[${idx}]: role=${m.role}, type=${m.metadata?.type || 'none'}, id=${m.id?.substring(0, 8)}, contentLen=${m.content?.length}`);
                            if (m.role === 'system') {
                                html += `<div class="msg system"><div>${esc(m.content)}</div></div>`;
                                return;
                            }

                            const roleLabel = m.role === 'assistant' ? '🤖 AI' : '👤 あなた';
                            const msgClass = m.role === 'assistant' ? 'ai' : 'user';

                            // AI応答メッセージの場合: metadataから分析結果UIを復元
                            if (m.role === 'assistant') {
                                // message_idベースで分析結果を取得、なければorphanedキューからフォールバック
                                let ar = analysisByMsgId[m.id];
                                if (!ar && orphanedAnalysis.length > orphanIdx) {
                                    ar = orphanedAnalysis[orphanIdx++];
                                    console.log(`[switchThread] orphan分析結果をフォールバック割当: type=${ar.analysis_type}, msgId=${m.id?.substring(0, 8)}`);
                                }
                                const meta = m.metadata || {};

                                // 初回分析のThinkingBlock復元
                                if (meta.type === 'initial_analysis' || (ar && ar.analysis_type === 'initial_analysis')) {
                                    const analysisData = ar?.raw_response || {};
                                    const aspectUpdates = meta.aspectUpdates || analysisData.aspectUpdates || {};
                                    const contamination = ar?.contamination || analysisData.contamination || {};
                                    const crossCheck = ar?.cross_check || analysisData.crossCheck || {};
                                    const thinking = ar?.thinking || analysisData.thinking || '';

                                    if (thinking || Object.keys(aspectUpdates).length) {
                                        let thinkHtml = '';
                                        // 観点分析結果
                                        for (const [key, info] of Object.entries(aspectUpdates)) {
                                            const ameta = ASPECT_META[key] || { emoji: '📌', label: key };
                                            const dotClass = info.status === 'ok' ? 'pass' : info.status === 'thin' ? 'warn' : 'fail';
                                            const label = info.status === 'ok' ? '検出' : info.status === 'thin' ? '薄い' : '未検出';
                                            thinkHtml += `<div class="anal-item"><span class="anal-dot ${dotClass}"></span>${ameta.emoji} ${ameta.label}: ${label}</div>`;
                                        }
                                        // コンタミ検知
                                        if (contamination.detected && contamination.items?.length) {
                                            contamination.items.forEach(item => {
                                                if (typeof item === 'string') {
                                                    thinkHtml += `<div class="anal-item"><span class="anal-dot warn"></span>⚠ 混入: 「${esc(item)}」</div>`;
                                                } else {
                                                    thinkHtml += `<div class="anal-item"><span class="anal-dot warn"></span>⚠ ${item.type || 'How/What'}混入: 「${esc(item.quote || '')}」<br><span style="color:var(--sub);margin-left:1.2em">→ ${esc(item.suggestion || '')}</span></div>`;
                                                }
                                            });
                                        }
                                        // 同語反復・論理チェーン
                                        if (crossCheck.redundancy?.detected && crossCheck.redundancy.pairs?.length) {
                                            crossCheck.redundancy.pairs.forEach(pair => {
                                                thinkHtml += `<div class="anal-item"><span class="anal-dot fail"></span>🔄 同語反復検出: ${esc(pair.a)} ↔ ${esc(pair.b)}<br><span style="color:var(--sub);margin-left:1.2em">${esc(pair.explanation || '')}</span></div>`;
                                            });
                                        }
                                        if (crossCheck.logicChain && !crossCheck.logicChain.connected) {
                                            thinkHtml += `<div class="anal-item"><span class="anal-dot fail"></span>⛓️ 論理チェーン断絶: ${esc(crossCheck.logicChain.gap || '課題→効果の因果関係が不明')}</div>`;
                                        }
                                        const okCount = Object.values(aspectUpdates).filter(v => v.status === 'ok').length;
                                        html += `<div class="think"><div class="think-head"><span class="think-chev">▶</span><span class="think-title">🔍 入力分析</span><span class="think-badge">${okCount}/5</span></div><div class="think-body"><div class="think-content">${thinkHtml}</div></div></div>`;
                                    }

                                    // プロセスログ復元
                                    if (analysisData._processLog?.length) {
                                        html += buildProcessLogHtml(analysisData._processLog);
                                    }

                                    // 初回分析後のSummaryPreview Vol.1 復元
                                    summaryVolCount++;
                                    const snap1 = snapshotByVol[summaryVolCount];
                                    if (snap1) {
                                        const snapAspects = {}, snapStatus = {};
                                        for (const [k, v] of Object.entries(snap1)) {
                                            snapAspects[k] = v.text || '';
                                            snapStatus[k] = v.status || 'empty';
                                        }
                                        html += buildSummaryPreviewHtml(summaryVolCount, snapAspects, snapStatus);
                                    } else {
                                        html += buildSummaryPreviewHtml(summaryVolCount, thread.aspects, thread.aspectStatus);
                                    }
                                }

                                // チャット応答のFeedbackCard復元
                                if (ar && ar.analysis_type !== 'initial_analysis') {
                                    const analysisData = ar.raw_response || {};
                                    const update = ar.aspect_update || analysisData.aspectUpdate || {};

                                    // ThinkingBlock（文脈推論）
                                    if (analysisData.thinking) {
                                        html += `<div class="think"><div class="think-head"><span class="think-chev">▶</span><span class="think-title">💭 思考プロセス</span></div><div class="think-body"><div class="think-content">${esc(analysisData.thinking)}</div></div></div>`;
                                    }

                                    // プロセスログ復元
                                    if (analysisData._processLog?.length) {
                                        html += buildProcessLogHtml(analysisData._processLog);
                                    }

                                    // FeedbackCard
                                    if (update.aspect) {
                                        const fmeta = ASPECT_META[update.aspect] || { label: update.aspect };
                                        const fbStatus = update.status === 'ok' ? '✓ OK' : update.status === 'thin' ? '△ 薄い' : '✗ 空';
                                        const fbClass = update.status === 'ok' ? 'pass' : update.status === 'thin' ? 'warn' : 'fail';
                                        let fbHtml = `<div class="fb-header"><span class="fb-aspect">${fmeta.label}</span><span class="badge ${fbClass}">${fbStatus}</span></div>`;
                                        if (update.reason) fbHtml += `<div class="fb-section reason"><div class="fb-label">現状の分析</div><div class="fb-content">${esc(update.reason)}</div></div>`;
                                        if (update.quoted) fbHtml += `<div class="fb-section quoted"><div class="fb-label">引用</div><div class="fb-content fb-quoted">${esc(update.quoted)}</div></div>`;
                                        if (update.advice) fbHtml += `<div class="fb-section advice"><div class="fb-label">次の一手</div><div class="fb-content">${esc(update.advice)}</div></div>`;
                                        if (update.example) fbHtml += `<div class="fb-section example"><div class="fb-label">具体例</div><div class="fb-content fb-example">${esc(update.example)}</div></div>`;
                                        html += `<div class="feedback-card">${fbHtml}</div>`;
                                    }

                                    // SummaryPreview復元（スナップショットベース）
                                    summaryVolCount++;
                                    const snapN = snapshotByVol[summaryVolCount];
                                    if (snapN) {
                                        const snapAspects = {}, snapStatus = {};
                                        for (const [k, v] of Object.entries(snapN)) {
                                            snapAspects[k] = v.text || '';
                                            snapStatus[k] = v.status || 'empty';
                                        }
                                        html += buildSummaryPreviewHtml(summaryVolCount, snapAspects, snapStatus);
                                    } else {
                                        html += buildSummaryPreviewHtml(summaryVolCount, thread.aspects, thread.aspectStatus);
                                    }

                                    // コンタミ検知
                                    const contam = ar.contamination || analysisData.contamination || {};
                                    if (contam.detected && contam.items?.length) {
                                        let contamHtml = '';
                                        contam.items.forEach(item => {
                                            if (typeof item === 'string') {
                                                contamHtml += `<div class="anal-item"><span class="anal-dot warn"></span> 「${esc(item)}」</div>`;
                                            } else {
                                                contamHtml += `<div class="anal-item"><span class="anal-dot warn"></span>⚠ 「${esc(item.quote || '')}」は${item.type || 'How/What'}です<br><span style="color:var(--sub);margin-left:1.2em">→ ${esc(item.suggestion || '')}</span></div>`;
                                            }
                                        });
                                        html += `<div class="think"><div class="think-head"><span class="think-chev">▶</span><span class="think-title">⚠️ コンタミ検知</span></div><div class="think-body"><div class="think-content">${contamHtml}</div></div></div>`;
                                    }

                                    // 関連更新のシステムメッセージ
                                    const relatedUpdates = ar.related_updates || analysisData.relatedUpdates || [];
                                    if (relatedUpdates.length) {
                                        const applied = relatedUpdates.filter(ru => ru.action !== 'skip' && ru.newText?.trim());
                                        if (applied.length) {
                                            const labels = applied.map(a => ASPECT_META[a.aspect]?.label || a.aspect).join('、');
                                            html += `<div class="msg system"><div>🔄 関連する観点を更新しました: ${labels}</div></div>`;
                                        }
                                    }
                                }
                            }

                            // メッセージ本文（contentから[分析結果:]や[関連更新:]のメタ情報は除外して表示）
                            let displayContent = m.content;
                            displayContent = displayContent.replace(/\n\[初回分析:.*?\]/g, '');
                            displayContent = displayContent.replace(/\n\[分析結果:.*?\]/g, '');
                            displayContent = displayContent.replace(/\n\[関連更新:.*?\]/g, '');
                            displayContent = displayContent.trim();

                            if (displayContent) {
                                html += `<div class="msg ${msgClass}"><div class="msg-role">${roleLabel}</div><div>${fmt(displayContent)}</div></div>`;
                            }
                        });
                        thread.messagesHtml = html;
                        thread.summaryVol = summaryVolCount;
                    }
                    console.log(`[switchThread DEBUG] 最終HTML長: ${html.length}, summaryVolCount=${summaryVolCount}`);
                    console.log(`[switchThread] DBからセッション復元: ${thread.dbId}`);
                }
            } catch (e) {
                console.warn('[switchThread] DB読み込み失敗:', e.message);
            }
        }

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
            state.summaryVol = thread.summaryVol || 0;
            state.conversationHistory = thread.conversationHistory || [];

            // 全5観点のカードを生成（DBにない観点もemptyとして表示）
            dom.aspectList.innerHTML = '';
            for (const key of Object.keys(ASPECT_META)) {
                if (!state.aspects.hasOwnProperty(key)) state.aspects[key] = '';
                createAspectCard(key, state.aspects[key]);
            }
            updateProgress();
            updatePhase(thread.phase);

            // ThinkingBlockのクリックイベントを再バインド
            dom.chatMessages.querySelectorAll('.think-head').forEach(head => {
                head.addEventListener('click', () => head.parentElement.classList.toggle('open'));
            });
            // SummaryPreviewのクリックイベントを再バインド
            dom.chatMessages.querySelectorAll('.sp-header').forEach(header => {
                header.addEventListener('click', () => header.parentElement.classList.toggle('open'));
            });
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

    /**
     * プロセスログのHTML文字列を返す（switchThread復元用）
     */
    function buildProcessLogHtml(processLog) {
        if (!processLog || !processLog.length) return '';
        let inner = '';
        for (const log of processLog) {
            inner += `<div style="margin-bottom:12px;border-bottom:1px solid var(--border);padding-bottom:8px">`;
            inner += `<div style="font-weight:600;margin-bottom:4px">Step ${log.step}: ${esc(log.label)} <span style="color:var(--sub);font-weight:400">${log.timestamp || ''}</span></div>`;
            if (log.usage && (log.usage.prompt_tokens || log.usage.completion_tokens)) {
                inner += `<div style="color:var(--sub);font-size:0.85em;margin-bottom:4px">📊 トークン: 入力=${log.usage.prompt_tokens || '?'} / 出力=${log.usage.completion_tokens || '?'} / 合計=${log.usage.total_tokens || '?'}</div>`;
            }
            inner += `<details style="margin:4px 0"><summary style="cursor:pointer;color:var(--accent);font-size:0.9em">📤 リクエスト（メッセージ ${log.request?.messageCount || '?'}件）</summary>`;
            inner += `<div style="font-size:0.8em;background:var(--card);padding:8px;border-radius:6px;margin-top:4px;max-height:300px;overflow-y:auto;white-space:pre-wrap;word-break:break-all">`;
            if (log.request?.systemPrompt) {
                inner += `<div style="color:var(--sub);margin-bottom:4px">--- system prompt (${log.request.systemPrompt.length}文字) ---</div>`;
                inner += esc(log.request.systemPrompt.length > 2000 ? log.request.systemPrompt.substring(0, 2000) + '\n...（省略）' : log.request.systemPrompt);
            }
            if (log.request?.historyCount > 0) {
                inner += `<div style="color:var(--sub);margin:4px 0">--- 会話履歴 ${log.request.historyCount}件 ---</div>`;
            }
            if (log.request?.userMessage) {
                inner += `<div style="color:var(--sub);margin:4px 0">--- user message ---</div>`;
                inner += esc(log.request.userMessage);
            }
            inner += `</div></details>`;
            inner += `<details style="margin:4px 0"><summary style="cursor:pointer;color:var(--accent);font-size:0.9em">📥 レスポンス</summary>`;
            inner += `<div style="font-size:0.8em;background:var(--card);padding:8px;border-radius:6px;margin-top:4px;max-height:300px;overflow-y:auto;white-space:pre-wrap;word-break:break-all">`;
            try {
                inner += esc(JSON.stringify(log.response, null, 2));
            } catch (e) {
                inner += esc('[シリアライズ不可]');
            }
            inner += `</div></details>`;
            inner += `</div>`;
        }
        const apiCalls = processLog.length;
        return `<div class="think"><div class="think-head"><span class="think-chev">▶</span><span class="think-title">🔗 AIプロセスログ</span><span class="think-badge">API ${apiCalls}回</span></div><div class="think-body"><div class="think-content">${inner}</div></div></div>`;
    }

    /**
     * AIプロセスログをthinkingブロックとして表示（ライブ用 — DOM直接操作）
     */
    function addProcessLogBlock(processLog) {
        if (!processLog || !processLog.length) return;
        let html = '';
        for (const log of processLog) {
            html += `<div style="margin-bottom:12px;border-bottom:1px solid var(--border);padding-bottom:8px">`;
            html += `<div style="font-weight:600;margin-bottom:4px">Step ${log.step}: ${esc(log.label)} <span style="color:var(--sub);font-weight:400">${log.timestamp || ''}</span></div>`;

            // トークン使用量
            if (log.usage && (log.usage.prompt_tokens || log.usage.completion_tokens)) {
                html += `<div style="color:var(--sub);font-size:0.85em;margin-bottom:4px">📊 トークン: 入力=${log.usage.prompt_tokens || '?'} / 出力=${log.usage.completion_tokens || '?'} / 合計=${log.usage.total_tokens || '?'}</div>`;
            }

            // リクエスト
            const req = log.request || {};
            html += `<details style="margin:4px 0"><summary style="cursor:pointer;color:var(--accent);font-size:0.9em">📤 リクエスト（メッセージ ${req.messageCount || '?'}件）</summary>`;
            html += `<div style="font-size:0.8em;background:var(--card);padding:8px;border-radius:6px;margin-top:4px;max-height:300px;overflow-y:auto;white-space:pre-wrap;word-break:break-all">`;
            if (req.systemPrompt) {
                html += `<div style="color:var(--sub);margin-bottom:4px">--- system prompt (${req.systemPrompt.length}文字) ---</div>`;
                html += esc(req.systemPrompt.length > 2000 ? req.systemPrompt.substring(0, 2000) + '\n...（省略）' : req.systemPrompt);
            }
            if (req.historyCount > 0) {
                html += `<div style="color:var(--sub);margin:4px 0">--- 会話履歴 ${req.historyCount}件 ---</div>`;
            }
            if (req.userMessage) {
                html += `<div style="color:var(--sub);margin:4px 0">--- user message ---</div>`;
                html += esc(req.userMessage);
            }
            html += `</div></details>`;

            // レスポンス
            html += `<details style="margin:4px 0"><summary style="cursor:pointer;color:var(--accent);font-size:0.9em">📥 レスポンス</summary>`;
            html += `<div style="font-size:0.8em;background:var(--card);padding:8px;border-radius:6px;margin-top:4px;max-height:300px;overflow-y:auto;white-space:pre-wrap;word-break:break-all">`;
            try {
                html += esc(JSON.stringify(log.response || {}, null, 2));
            } catch (e) {
                html += esc('[シリアライズ不可]');
            }
            html += `</div></details>`;

            html += `</div>`;
        }
        const apiCalls = processLog.length;
        addThinkingBlock(`🔗 AIプロセスログ`, html, `API ${apiCalls}回`);
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
        // フォールバック（AI評価がない場合）
        // ※ OKは絶対にAI判定からのみ。テキスト長でOKにしない
        if (!t?.trim()) return { l: '✗ 空', c: 'empty' };
        return { l: '△ 薄い', c: 'thin' };
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

    // DB復元用: HTML文字列のみ返す（DOM操作なし）
    function buildSummaryPreviewHtml(vol, aspects, aspectStatus) {
        let contentHtml = '';
        for (const [key, meta] of Object.entries(ASPECT_META)) {
            const text = aspects[key] || '（未記入）';
            const status = aspectStatus[key] || (!aspects[key] ? 'empty' : 'thin');
            const statusLabel = status === 'ok' ? 'OK' : status === 'thin' ? '薄い' : '未';
            const statusClass = status === 'ok' ? 'pass' : status === 'thin' ? 'warn' : 'fail';
            const previewText = text.length > 150 ? text.substring(0, 150) + '...' : text;
            contentHtml += `<div class="sp-item"><div class="sp-label"><span class="sp-dot ${statusClass}"></span>${meta.label} <span class="sp-status">${statusLabel}</span></div><div class="sp-text">${esc(previewText)}</div></div>`;
        }
        return `<div class="summary-preview"><div class="sp-header"><span class="sp-toggle">▶</span><span class="sp-title">💎 要約プレビュー Vol.${vol}</span><span class="sp-sub">（クリックで展開）</span></div><div class="sp-body">${contentHtml}</div></div>`;
    }

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
