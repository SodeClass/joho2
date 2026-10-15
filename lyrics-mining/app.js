// ==========================================
// 辞書キャッシュ & 通信インターセプター
// ==========================================
const DIC_FILE_SIZES = {
    'tid_pos.dat.gz': 5916009,
    'base.dat.gz': 3956825,
    'check.dat.gz': 3111633,
    'cc.dat.gz': 1692067,
    'tid.dat.gz': 1605820,
    'tid_map.dat.gz': 1485576,
    'unk_pos.dat.gz': 10540,
    'unk.dat.gz': 10512,
    'unk_char.dat.gz': 306,
    'unk_compat.dat.gz': 338,
    'unk_invoke.dat.gz': 1140,
    'unk_map.dat.gz': 1190
};
const TOTAL_DIC_SIZE = Object.values(DIC_FILE_SIZES).reduce((a, b) => a + b, 0); // 約17.8MB

const downloadedBytesMap = {};
let onDicProgressCallback = null;

function updateDicProgress(filename, loadedBytes, isCached = false) {
    downloadedBytesMap[filename] = loadedBytes;
    const currentTotal = Object.values(downloadedBytesMap).reduce((a, b) => a + b, 0);
    const percent = Math.min(100, Math.round((currentTotal / TOTAL_DIC_SIZE) * 100));
    if (onDicProgressCallback) {
        onDicProgressCallback(percent, currentTotal, TOTAL_DIC_SIZE, isCached);
    }
}

// XMLHttpRequest をフックして CacheStorage ＆ fetch ストリームプログレス ＆ CDNフォールバック
const OriginalXHR = window.XMLHttpRequest;

class CachedDicXHR {
    constructor() {
        this._realXHR = new OriginalXHR();
        this._isDic = false;
        this._url = '';
        this.responseType = '';
        this.status = 0;
        this.statusText = '';
        this.response = null;
        this.onload = null;
        this.onerror = null;
    }

    open(method, url, async = true) {
        this._url = url;
        if (typeof url === 'string' && url.endsWith('.dat.gz')) {
            this._isDic = true;
        } else {
            this._realXHR.open(method, url, async);
        }
    }

    async send() {
        if (!this._isDic) {
            this._realXHR.responseType = this.responseType;
            this._realXHR.onload = () => {
                this.status = this._realXHR.status;
                this.statusText = this._realXHR.statusText;
                this.response = this._realXHR.response;
                if (this.onload) this.onload.call(this);
            };
            this._realXHR.onerror = (e) => {
                if (this.onerror) this.onerror.call(this, e);
            };
            this._realXHR.send();
            return;
        }

        const filename = this._url.split('/').pop().split('?')[0];

        try {
            const cacheName = 'kuromoji-dic-v1';
            let cache = null;
            if ('caches' in window) {
                try { cache = await caches.open(cacheName); } catch (e) {}
            }

            let responseBuffer = null;

            // 1. キャッシュ確認
            if (cache) {
                try {
                    const cachedRes = await cache.match(this._url);
                    if (cachedRes) {
                        responseBuffer = await cachedRes.arrayBuffer();
                        updateDicProgress(filename, responseBuffer.byteLength, true);
                    }
                } catch (e) {}
            }

            // 2. ネットワークから取得（CDNフォールバック付き）
            if (!responseBuffer) {
                const candidates = [
                    this._url,
                    `https://unpkg.com/kuromoji@0.1.2/dict/${filename}`,
                    `https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/${filename}`
                ];
                let lastErr = null;
                for (const cUrl of candidates) {
                    try {
                        const res = await fetch(cUrl);
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);

                        const reader = res.body.getReader();
                        const chunks = [];
                        let receivedBytes = 0;

                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            chunks.push(value);
                            receivedBytes += value.length;
                            updateDicProgress(filename, receivedBytes, false);
                        }

                        const allChunks = new Uint8Array(receivedBytes);
                        let position = 0;
                        for (const chunk of chunks) {
                            allChunks.set(chunk, position);
                            position += chunk.length;
                        }
                        responseBuffer = allChunks.buffer;

                        if (cache) {
                            try {
                                await cache.put(this._url, new Response(responseBuffer.slice(0)));
                            } catch (e) {}
                        }
                        break;
                    } catch (e) {
                        lastErr = e;
                    }
                }
                if (!responseBuffer) {
                    throw lastErr || new Error('辞書ファイルのダウンロードに失敗しました: ' + filename);
                }
            }

            this.status = 200;
            this.statusText = 'OK';
            this.response = responseBuffer;
            if (this.onload) this.onload.call(this);
        } catch (err) {
            console.error('XHRフックエラー:', err);
            this.status = 500;
            this.statusText = err.message || 'Error';
            if (this.onerror) this.onerror.call(this, err);
        }
    }

    setRequestHeader(h, v) { this._realXHR.setRequestHeader(h, v); }
    abort() { this._realXHR.abort(); }
    getResponseHeader(h) { return this._realXHR.getResponseHeader(h); }
    getAllResponseHeaders() { return this._realXHR.getAllResponseHeaders(); }
}

window.XMLHttpRequest = CachedDicXHR;


// ==========================================
// メインUIロジック
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    // Badges & Status
    const dicBadge = document.getElementById('dic-badge');
    const dicBadgeDot = document.getElementById('dic-badge-dot');
    const dicBadgeText = document.getElementById('dic-badge-text');
    const statusBox = document.getElementById('status-box');
    const statusText = document.getElementById('status-text');
    const statusProgressWrap = document.getElementById('status-progress-wrap');
    const statusProgressBar = document.getElementById('status-progress-bar');

    // Upload & Inputs
    const dropZone = document.getElementById('drop-zone');
    const dropZoneText = document.getElementById('drop-zone-text');
    const fileInput = document.getElementById('file-input');
    const folderInput = document.getElementById('folder-input');
    const btnSelectFile = document.getElementById('btn-select-file');
    const btnSelectFolder = document.getElementById('btn-select-folder');
    const fileInfo = document.getElementById('file-info');
    const fileSummaryCount = document.getElementById('file-summary-count');
    const fileSummaryChars = document.getElementById('file-summary-chars');
    const btnToggleFileList = document.getElementById('btn-toggle-file-list');
    const fileListContent = document.getElementById('file-list-content');
    const fileListUl = document.getElementById('file-list-ul');

    // POS Checkboxes
    const optPosNoun = document.getElementById('opt-pos-noun');
    const optPosVerb = document.getElementById('opt-pos-verb');
    const optPosAdj = document.getElementById('opt-pos-adj');
    const optPosPronoun = document.getElementById('opt-pos-pronoun');
    const optPosAdverb = document.getElementById('opt-pos-adverb');
    const optStopwords = document.getElementById('opt-stopwords');

    // Controls
    const analyzeBtn = document.getElementById('analyze-btn');
    const liveModeToggle = document.getElementById('live-mode-toggle');

    // Live Panel
    const livePanel = document.getElementById('live-panel');
    const liveBadge = document.getElementById('live-badge');
    const liveProgressFill = document.getElementById('live-progress-fill');
    const liveProgressText = document.getElementById('live-progress-text');
    const currentLineBox = document.getElementById('current-line-box');
    const tokenizedLineBox = document.getElementById('tokenized-line-box');
    const speedSlider = document.getElementById('speed-slider');
    const speedDisplay = document.getElementById('speed-display');
    const skipBtn = document.getElementById('skip-btn');

    // Results
    const resultSection = document.getElementById('result-section');
    const chartSection = document.getElementById('chart-section');
    const tableSection = document.getElementById('table-section');
    const viewBtnRanking = document.getElementById('view-btn-ranking');
    const viewBtnGraph = document.getElementById('view-btn-graph');
    const totalCountDisplay = document.getElementById('total-count');
    const uniqueCountDisplay = document.getElementById('unique-count');
    const totalSongsCount = document.getElementById('total-songs-count');
    const chartNInput = document.getElementById('chart-n-input');
    const tableNInput = document.getElementById('table-n-input');
    const xAxisTicks = document.getElementById('x-axis-ticks');
    const barsContainer = document.getElementById('bars-container');
    const rankingTbody = document.getElementById('ranking-tbody');

    // 読み込み済み曲データリスト: [{ name: string, text: string }, ...]
    let loadedSongs = [];
    let tokenizer = null;
    let initPromise = null;
    let isDictionaryReady = false;
    let skipAnimationRequested = false;
    let latestSortedList = [];
    let latestTotalCount = 0;

    // 速度スライダー (600, 400, 300, 200, 1 ms)
    const SPEED_LABELS = { '1': 'とても遅い', '2': '遅い', '3': '標準', '4': '速い', '5': 'とても速い' };
    const SPEED_DELAYS = { '1': 600, '2': 400, '3': 300, '4': 200, '5': 1 };
    let currentDelay = SPEED_DELAYS['3'];

    speedSlider.addEventListener('input', () => {
        const val = speedSlider.value;
        speedDisplay.textContent = SPEED_LABELS[val] || '標準';
        currentDelay = SPEED_DELAYS[val] !== undefined ? SPEED_DELAYS[val] : 300;
    });

    // 辞書ロード進捗コールバック
    onDicProgressCallback = (percent, loadedBytes, totalBytes, isCached, customMsg) => {
        if (isDictionaryReady) return;

        if (isCached) {
            hideStatus();
            dicBadgeText.textContent = 'Sudachi 辞書ロード中...';
            return;
        }

        if (customMsg) {
            showStatus(customMsg, true);
            statusProgressBar.style.width = '100%';
            return;
        }

        const mbLoaded = (loadedBytes / (1024 * 1024)).toFixed(1);
        const mbTotal = (totalBytes / (1024 * 1024)).toFixed(1);

        statusBox.style.display = 'flex';
        statusProgressWrap.style.display = 'block';
        statusProgressBar.style.width = percent + '%';
        statusText.textContent = `Sudachi 辞書をダウンロード中... ${mbLoaded}MB / ${mbTotal}MB (${percent}%)`;
        dicBadgeText.textContent = '辞書ロード中...';
    };

    function showStatus(text, showBar = false) {
        statusText.textContent = text;
        statusBox.style.display = 'flex';
        statusProgressWrap.style.display = showBar ? 'block' : 'none';
    }
    function hideStatus() {
        statusBox.style.display = 'none';
    }

    function setDicReady() {
        isDictionaryReady = true;
        dicBadge.style.backgroundColor = '#c6f6d5';
        dicBadge.style.color = '#22543d';
        dicBadgeDot.style.backgroundColor = '#38a169';
        dicBadgeText.textContent = 'Sudachi 準備完了 (利用可能)';
    }

    function initSudachi() {
        if (tokenizer && tokenizer.isReady()) return Promise.resolve(tokenizer);
        if (initPromise) return initPromise;

        dicBadgeText.textContent = '辞書ロード中...';
        initPromise = SudachiTokenizer.init(onDicProgressCallback)
            .then((tok) => {
                tokenizer = tok;
                setDicReady();
                hideStatus();
                return tokenizer;
            })
            .catch((err) => {
                hideStatus();
                initPromise = null;
                dicBadge.style.backgroundColor = '#fed7d7';
                dicBadge.style.color = '#742a2a';
                dicBadgeDot.style.backgroundColor = '#e53e3e';
                dicBadgeText.textContent = '辞書ロード失敗';
                alert('Sudachi 形態素解析エンジンの読み込みに失敗しました: ' + (err.message || err));
                throw err;
            });
        return initPromise;
    }

    initSudachi().catch(console.error);

    // ==========================================
    // ファイル & フォルダ選択・ドラッグ＆ドロップ
    // ==========================================
    btnSelectFile.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });

    btnSelectFolder.addEventListener('click', (e) => {
        e.stopPropagation();
        folderInput.click();
    });

    dropZone.addEventListener('click', (e) => {
        if (e.target !== btnSelectFile && e.target !== btnSelectFolder && !btnSelectFile.contains(e.target) && !btnSelectFolder.contains(e.target)) {
            fileInput.click();
        }
    });

    ['dragenter', 'dragover'].forEach(name => {
        dropZone.addEventListener(name, (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });
    });

    ['dragleave', 'drop'].forEach(name => {
        dropZone.addEventListener(name, (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
        });
    });

    // ドロップ処理（フォルダ・複数ファイル再帰探索対応）
    dropZone.addEventListener('drop', async (e) => {
        const items = e.dataTransfer.items;
        if (items && items.length > 0) {
            await handleDataTransferItems(items);
        } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            await handleFileList(Array.from(e.dataTransfer.files));
        }
    });

    fileInput.addEventListener('change', async (e) => {
        if (e.target.files.length > 0) {
            await handleFileList(Array.from(e.target.files));
        }
    });

    folderInput.addEventListener('change', async (e) => {
        if (e.target.files.length > 0) {
            await handleFileList(Array.from(e.target.files));
        }
    });

    // ファイル一覧表示トグル
    btnToggleFileList.addEventListener('click', () => {
        if (fileListContent.style.display === 'none') {
            fileListContent.style.display = 'block';
            btnToggleFileList.textContent = 'ファイル一覧を閉じる';
        } else {
            fileListContent.style.display = 'none';
            btnToggleFileList.textContent = 'ファイル一覧を表示';
        }
    });

    // DataTransferItems（フォルダ対応）の再帰スキャン
    async function handleDataTransferItems(items) {
        showStatus('ファイルおよびフォルダをスキャン中...');
        const filePromises = [];
        const queue = [];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.webkitGetAsEntry) {
                const entry = item.webkitGetAsEntry();
                if (entry) queue.push(entry);
            } else {
                const f = item.getAsFile();
                if (f) filePromises.push(f);
            }
        }

        while (queue.length > 0) {
            const entry = queue.shift();
            if (entry.isFile) {
                await new Promise((resolve) => {
                    entry.file((file) => {
                        filePromises.push(file);
                        resolve();
                    }, () => resolve());
                });
            } else if (entry.isDirectory) {
                const reader = entry.createReader();
                const entries = await readAllDirectoryEntries(reader);
                for (const sub of entries) {
                    queue.push(sub);
                }
            }
        }

        await handleFileList(filePromises);
    }

    async function readAllDirectoryEntries(reader) {
        const entries = [];
        let batch = await new Promise((resolve) => {
            reader.readEntries((res) => resolve(res), () => resolve([]));
        });
        while (batch.length > 0) {
            entries.push(...batch);
            batch = await new Promise((resolve) => {
                reader.readEntries((res) => resolve(res), () => resolve([]));
            });
        }
        return entries;
    }

    // 取得したファイル配列の読み込み・展開
    async function handleFileList(files) {
        const validFiles = files.filter(f => {
            const lower = f.name.toLowerCase();
            return (lower.endsWith('.txt') || lower.endsWith('.zip')) && !lower.startsWith('__macosx') && !lower.startsWith('.');
        });

        if (validFiles.length === 0) {
            alert('有効な歌詞ファイル（.txt または .zip）が見つかりませんでした。');
            hideStatus();
            return;
        }

        showStatus(`計 ${validFiles.length} 件のファイルを読み込み中...`);
        loadedSongs = [];

        try {
            for (const file of validFiles) {
                if (file.name.toLowerCase().endsWith('.zip')) {
                    const zip = new JSZip();
                    const zipContent = await zip.loadAsync(file);
                    for (const filename in zipContent.files) {
                        const lower = filename.toLowerCase();
                        if (lower.endsWith('.txt') && !lower.startsWith('__macosx') && !lower.includes('/.')) {
                            const zipFileEntry = zipContent.files[filename];
                            const buf = await zipFileEntry.async('arraybuffer');
                            const text = decodeText(buf);
                            const displayName = filename.split('/').pop();
                            if (text && text.trim().length > 0) {
                                loadedSongs.push({ name: displayName, text: text });
                            }
                        }
                    }
                } else {
                    const buf = await file.arrayBuffer();
                    const text = decodeText(buf);
                    if (text && text.trim().length > 0) {
                        loadedSongs.push({ name: file.name, text: text });
                    }
                }
            }

            if (loadedSongs.length === 0) {
                alert('テキストファイルから歌詞データを読み取れませんでした。');
                hideStatus();
                return;
            }

            const totalChars = loadedSongs.reduce((acc, s) => acc + s.text.length, 0);
            fileSummaryCount.textContent = loadedSongs.length.toLocaleString();
            fileSummaryChars.textContent = totalChars.toLocaleString();
            
            fileListUl.innerHTML = '';
            loadedSongs.forEach(song => {
                const li = document.createElement('li');
                li.textContent = `${song.name} (${song.text.length.toLocaleString()} 文字)`;
                fileListUl.appendChild(li);
            });

            fileInfo.style.display = 'block';
            dropZoneText.innerHTML = `選択完了: 計 <strong>${loadedSongs.length}</strong> 曲`;
            hideStatus();
        } catch (err) {
            console.error(err);
            alert('ファイルの展開・読み込み中にエラーが発生しました: ' + err.message);
            hideStatus();
        }
    }

    // UTF-8 / Shift_JIS 自動判定デコード
    function decodeText(buf) {
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(buf);
        } catch (e) {
            try {
                return new TextDecoder('shift-jis', { fatal: true }).decode(buf);
            } catch (e2) {
                return new TextDecoder('utf-8').decode(buf);
            }
        }
    }

    // ==========================================
    // 歌詞テキストのクレンジング
    // ==========================================
    const CREDIT_LINE_REGEX = /^(?:歌手|アーティスト|作詞|作曲|編曲|歌|唄|原曲|作詞者|作曲者|Vocal|Lyricist|Composer|Arranger|Music|Lyrics|JASRAC|NexTone|権利者)[\s　:：]/i;
    const STRUCT_TAG_REGEX = /^[(\[【（](?:サビ|大サビ|落ちサビ|Aメロ|Bメロ|Cメロ|Intro|Intro\.|Outro|Verse|Verse\s*\d+|Chorus|Chorus\s*\d+|Bridge|Hook|Interlude|間奏|前奏|後奏|ギターソロ|ソロ|ラップ).*?[)\]】）]$/i;
    const TIMESTAMP_REGEX = /\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g;
    const LRC_TAG_REGEX = /^\[(?:ti|ar|al|by|offset|re|ve):.*\]/i;

    function cleanLyricsLines(rawText) {
        const lines = rawText.split(/\r\n|\r|\n/);
        const cleaned = [];

        for (let line of lines) {
            let l = line.trim();
            if (!l) continue;

            // クレジット行の自動除外（歌手・作詞・作曲等）
            if (CREDIT_LINE_REGEX.test(l)) {
                continue;
            }

            // LRCメタタグ・構成タグ（【サビ】等）の除外
            if (LRC_TAG_REGEX.test(l) || STRUCT_TAG_REGEX.test(l)) {
                continue;
            }

            // タイムタグの除去
            l = l.replace(TIMESTAMP_REGEX, '').trim();

            l = l.replace(/《.*?》/g, '').replace(/｜/g, '');
            l = l.replace(/［＃.*?］/g, '');

            if (l.length > 0) {
                cleaned.push(l);
            }
        }
        return cleaned;
    }

    // ==========================================
    // 品詞判定 & 対象単語チェック
    // ==========================================
    function checkWordTarget(token) {
        const pos = token.pos;
        const sub = token.pos_detail_1;
        const basic = token.basic_form === '*' ? token.surface_form : token.basic_form;

        let allowed = false;
        let assignedPos = pos;

        if (sub === '代名詞') {
            if (optPosPronoun.checked) {
                allowed = true;
                assignedPos = '代名詞';
            }
        } else if (pos === '名詞') {
            if (optPosNoun.checked && !['数', '非自立', '接尾'].includes(sub)) {
                allowed = true;
                assignedPos = '名詞';
            }
        } else if (pos === '動詞') {
            if (optPosVerb.checked && !['非自立', '接尾'].includes(sub)) {
                allowed = true;
                assignedPos = '動詞';
            }
        } else if (pos === '形容詞') {
            if (optPosAdj.checked && !['非自立', '接尾'].includes(sub)) {
                allowed = true;
                assignedPos = '形容詞';
            }
        } else if (pos === '副詞') {
            if (optPosAdverb.checked) {
                allowed = true;
                assignedPos = '副詞';
            }
        }

        if (!allowed) return { isTarget: false, word: basic, pos: assignedPos };

        // Sudachi仕様ストップワード判定（ONの場合）
        if (optStopwords && optStopwords.checked && window.STOP_WORDS) {
            const lowerBasic = basic.toLowerCase();
            const lowerSurface = (token.surface_form || '').toLowerCase();
            if (window.STOP_WORDS.has(lowerBasic) || window.STOP_WORDS.has(lowerSurface)) {
                return { isTarget: false, word: basic, pos: assignedPos };
            }
        }

        if (basic.length <= 1 && /^[\u3040-\u309F\u30A0-\u30FF\w\s]$/.test(basic)) {
            return { isTarget: false, word: basic, pos: assignedPos };
        }
        if (/^[!-/:-@[-`{-~、。・…―「」『』（）［］【】\s]+$/.test(basic)) {
            return { isTarget: false, word: basic, pos: assignedPos };
        }

        return { isTarget: true, word: basic, pos: assignedPos };
    }

    skipBtn.addEventListener('click', () => {
        skipAnimationRequested = true;
    });

    // ==========================================
    // 解析実行ボタン
    // ==========================================
    analyzeBtn.addEventListener('click', async () => {
        if (loadedSongs.length === 0) {
            alert('歌詞のtxtファイルまたはフォルダをアップロードしてください。');
            return;
        }

        if (!optPosNoun.checked && !optPosVerb.checked && !optPosAdj.checked && 
            !optPosPronoun.checked && !optPosAdverb.checked) {
            alert('少なくとも1つの品詞をチェックしてください。');
            return;
        }

        analyzeBtn.disabled = true;
        skipAnimationRequested = false;

        try {
            const modeSelect = document.getElementById('sudachi-mode-select');
            if (modeSelect && window.SudachiTokenizer) {
                window.SudachiTokenizer.setMode(modeSelect.value);
            }

            if (!isDictionaryReady) {
                showStatus('Sudachi 辞書の準備を待っています...（完了次第自動で開始）', true);
            }
            const t = await initSudachi();
            showStatus('歌詞データをクレンジング中...', false);

            const processedSongs = [];
            for (const song of loadedSongs) {
                const cleanedLines = cleanLyricsLines(song.text);
                if (cleanedLines.length > 0) {
                    processedSongs.push({ name: song.name, lines: cleanedLines });
                }
            }

            if (processedSongs.length === 0) {
                alert('クレンジング後に歌詞テキストが空になりました。');
                hideStatus();
                return;
            }

            hideStatus();

            if (liveModeToggle.checked) {
                await runLiveStepAnimation(processedSongs, t);
            } else {
                livePanel.style.display = 'none';
                runFastAnalysis(processedSongs, t);
            }
        } catch (err) {
            console.error(err);
            alert('解析中にエラーが発生しました: ' + err.message);
            hideStatus();
        } finally {
            analyzeBtn.disabled = false;
        }
    });

    // ==========================================
    // 高速一括解析（アニメーションOFF時）
    // ==========================================
    function runFastAnalysis(processedSongs, t) {
        showStatus('歌詞を形態素解析・集計中...');
        const wordCounts = {};
        const wordPos = {};
        let totalCount = 0;

        for (const song of processedSongs) {
            for (const line of song.lines) {
                const tokens = t.tokenize(line);
                for (const token of tokens) {
                    const check = checkWordTarget(token);
                    if (check.isTarget) {
                        wordCounts[check.word] = (wordCounts[check.word] || 0) + 1;
                        wordPos[check.word] = check.pos;
                        totalCount++;
                    }
                }
            }
        }

        hideStatus();
        resultSection.style.display = 'block';
        totalSongsCount.textContent = processedSongs.length.toLocaleString();
        renderChartAndTable(wordCounts, wordPos, totalCount);
    }

    // ==========================================
    // アニメーション解析（アニメーションON時・novel-mining仕様完全準拠）
    // ==========================================
    async function runLiveStepAnimation(processedSongs, t) {
        livePanel.style.display = 'block';
        resultSection.style.display = 'block';
        tokenizedLineBox.innerHTML = '';
        currentLineBox.textContent = '（解析開始）';
        liveProgressFill.style.width = '0%';
        liveProgressText.textContent = '0%';
        liveBadge.textContent = '解析中...';
        livePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        totalSongsCount.textContent = processedSongs.length.toLocaleString();

        const runningWordCounts = {};
        const runningWordPos = {};
        let runningTotal = 0;

        let totalTokens = 0;
        const allSongTokenLines = [];
        for (const song of processedSongs) {
            const tokenLines = [];
            for (const line of song.lines) {
                const toks = t.tokenize(line);
                if (toks.length > 0) {
                    tokenLines.push({ text: line, tokens: toks });
                    totalTokens += toks.length;
                }
            }
            allSongTokenLines.push({ songName: song.name, lines: tokenLines });
        }

        let processedTokensCount = 0;

        for (let sIdx = 0; sIdx < allSongTokenLines.length; sIdx++) {
            if (skipAnimationRequested) break;
            const songData = allSongTokenLines[sIdx];
            if (allSongTokenLines.length > 1) {
                liveBadge.textContent = `曲 ${sIdx + 1}/${allSongTokenLines.length}: ${songData.songName}`;
            } else {
                liveBadge.textContent = '歌詞解析中...';
            }

            for (let lIdx = 0; lIdx < songData.lines.length; lIdx++) {
                if (skipAnimationRequested) break;
                const lineItem = songData.lines[lIdx];
                const currentTokens = lineItem.tokens;

                // ① 元の歌詞（1行表示）
                currentLineBox.textContent = lineItem.text;

                // Step A: まず素の文章をそのまま出す（隙間ゼロ・スペースなしの地の文）
                tokenizedLineBox.innerHTML = '';
                const tokenSpans = [];
                currentTokens.forEach((tok) => {
                    const span = document.createElement('span');
                    span.className = 'token-raw';
                    span.textContent = tok.surface_form;
                    tokenSpans.push(span);
                    tokenizedLineBox.appendChild(span);
                });
                tokenizedLineBox.scrollTop = tokenizedLineBox.scrollHeight;

                // 素の文章を見せるウェイト
                if (currentDelay > 0) {
                    await new Promise(r => setTimeout(r, Math.max(currentDelay * 1.5, 80)));
                }
                if (skipAnimationRequested) break;

                // Step B: 形態素に分ける（スラッシュを間に挿入していく）
                for (let i = 0; i < tokenSpans.length - 1; i++) {
                    if (skipAnimationRequested) break;
                    const slash = document.createElement('span');
                    slash.className = 'token-slash';
                    slash.textContent = ' / ';
                    tokenSpans[i].after(slash);
                    tokenizedLineBox.scrollTop = tokenizedLineBox.scrollHeight;
                    if (currentDelay > 0) {
                        await new Promise(r => setTimeout(r, Math.max(currentDelay * 0.5, 10)));
                    }
                }

                // 分かち書き完了の短いウェイト
                if (currentDelay > 0) {
                    await new Promise(r => setTimeout(r, Math.max(currentDelay * 0.8, 30)));
                }
                if (skipAnimationRequested) break;

                // Step C: 1つ1つ品詞判定し、対象外に打ち消し線、対象品詞をハイライト ＆ 初出ゴールド光彩 ＆ 都度グラフカウント
                for (let i = 0; i < currentTokens.length; i++) {
                    if (skipAnimationRequested) break;
                    const token = currentTokens[i];
                    const check = checkWordTarget(token);
                    const span = tokenSpans[i];

                    span.className = 'token-item';

                    if (check.isTarget) {
                        if (check.pos === '名詞') span.classList.add('token-noun');
                        else if (check.pos === '動詞') span.classList.add('token-verb');
                        else if (check.pos === '形容詞') span.classList.add('token-adj');
                        else if (check.pos === '代名詞') span.classList.add('token-pronoun');
                        else if (check.pos === '副詞') span.classList.add('token-adverb');

                        const isFirstAppearance = !runningWordCounts[check.word];
                        if (isFirstAppearance) {
                            span.classList.add('token-first-appearance');
                        }

                        runningTotal++;
                        runningWordCounts[check.word] = (runningWordCounts[check.word] || 0) + 1;
                        runningWordPos[check.word] = check.pos;
                        renderChartAndTable(runningWordCounts, runningWordPos, runningTotal);
                    } else {
                        span.classList.add('token-excluded');
                    }

                    processedTokensCount++;

                    const progress = totalTokens > 0 ? Math.min(100, Math.round((processedTokensCount / totalTokens) * 100)) : 100;
                    liveProgressFill.style.width = progress + '%';
                    liveProgressText.textContent = `${progress}% (抽出: ${runningTotal}語)`;

                    if (currentDelay > 0) {
                        await new Promise(r => setTimeout(r, currentDelay));
                    }
                }

                if (currentDelay > 0) {
                    await new Promise(r => setTimeout(r, Math.max(currentDelay * 1.2, 50)));
                }
            }
        }

        if (skipAnimationRequested) {
            runFastAnalysis(processedSongs, t);
            liveProgressFill.style.width = '100%';
            liveProgressText.textContent = '100% 完了';
            currentLineBox.textContent = '（全曲の解析完了）';
            tokenizedLineBox.innerHTML = '<em>スキップされ、集計が完了しました。</em>';
            liveBadge.textContent = '解析完了！';
        } else {
            liveProgressFill.style.width = '100%';
            liveProgressText.textContent = '100% 完了';
            currentLineBox.textContent = '（全曲の解析完了）';
            liveBadge.textContent = '解析完了！';
            runFastAnalysis(processedSongs, t);
        }
    }

    // ==========================================
    // グラフ＆表 レンダリング (abcounter仕様完全準拠)
    // ==========================================
    function renderChartAndTable(wordCounts, wordPos, total) {
        latestTotalCount = total;
        latestSortedList = Object.keys(wordCounts)
            .map(word => ({
                word,
                count: wordCounts[word],
                pos: wordPos[word] || '名詞'
            }))
            .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));

        const uniqueCount = latestSortedList.length;
        totalCountDisplay.textContent = total.toLocaleString();
        uniqueCountDisplay.textContent = uniqueCount.toLocaleString();

        const n = Math.max(1, parseInt(chartNInput?.value, 10) || parseInt(tableNInput?.value, 10) || 30);
        const topWords = latestSortedList.slice(0, n);

        // ラベル幅の動的調整
        let maxWordLen = 0;
        topWords.forEach(item => {
            if (item.word.length > maxWordLen) maxWordLen = item.word.length;
        });
        const dynamicLabelWidth = Math.min(220, Math.max(115, maxWordLen * 18 + 15));
        const dynamicMarginLeft = dynamicLabelWidth + 15;
        document.documentElement.style.setProperty('--label-width', dynamicLabelWidth + 'px');
        document.documentElement.style.setProperty('--chart-margin-left', dynamicMarginLeft + 'px');

        const maxCount = topWords.length > 0 ? topWords[0].count : 1;
        const maxPct = total > 0 ? (maxCount / total) * 100 : 1;

        // X軸の目盛り生成 (5段階)
        let tickStep = 2;
        if (maxPct <= 2) tickStep = 0.5;
        else if (maxPct <= 5) tickStep = 1;
        else if (maxPct <= 10) tickStep = 2;
        else if (maxPct <= 25) tickStep = 5;
        else if (maxPct <= 50) tickStep = 10;
        else tickStep = 20;

        const maxTickValue = Math.ceil(maxPct / tickStep) * tickStep || tickStep;

        let ticksHTML = '';
        const numSteps = Math.min(10, Math.round(maxTickValue / tickStep));
        for (let i = 0; i <= numSteps; i++) {
            const val = i * tickStep;
            if (val > maxTickValue) break;
            const leftPct = (val / maxTickValue) * 100;
            ticksHTML += `<span class="x-tick" style="left: ${leftPct}%;">${val}%</span>`;
        }
        xAxisTicks.innerHTML = ticksHTML;

        // 横棒バーの生成
        const POS_COLOR_CLASS = {
            '名詞': 'noun',
            '動詞': 'verb',
            '形容詞': 'adj',
            '代名詞': 'pronoun',
            '副詞': 'adverb'
        };

        barsContainer.innerHTML = '';
        topWords.forEach(item => {
            const p = total > 0 ? (item.count / total) * 100 : 0;
            const barWidth = maxTickValue > 0 ? Math.min(100, (p / maxTickValue) * 100) : 0;
            const pText = p >= 10 ? p.toFixed(1) : p.toFixed(2);
            const posClass = POS_COLOR_CLASS[item.pos] || 'noun';

            const row = document.createElement('div');
            row.className = 'bar-row';
            row.innerHTML = `
                <div class="bar-row-label" title="${escapeHtml(item.word)}">${escapeHtml(item.word)}</div>
                <div class="bar-row-track">
                    <div class="bar-row-fill ${posClass}" style="width: ${barWidth}%;">
                        <div class="tooltip-h">${escapeHtml(item.word)} (${item.pos}): ${item.count.toLocaleString()}回 (${pText}%)</div>
                    </div>
                    <div class="bar-row-value">${item.count.toLocaleString()}回 (${pText}%)</div>
                </div>
            `;

            row.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelectorAll('.bar-row').forEach(r => {
                    if (r !== row) r.classList.remove('show-tooltip');
                });
                row.classList.toggle('show-tooltip');
            });

            barsContainer.appendChild(row);
        });

        // ランキング表の生成
        const tableWords = latestSortedList.slice(0, n);
        let tableHTML = '';
        tableWords.forEach((item, index) => {
            const rank = index + 1;
            const p = total > 0 ? ((item.count / total) * 100).toFixed(1) : '0.0';

            tableHTML += `
                <tr>
                    <td>${rank}</td>
                    <td style="font-weight: bold;">${escapeHtml(item.word)}</td>
                    <td>${item.pos}</td>
                    <td>${item.count.toLocaleString()} 回</td>
                    <td>${p}%</td>
                </tr>
            `;
        });

        if (tableWords.length === 0) {
            tableHTML = `<tr><td colspan="5" style="text-align:center; padding: 20px; color:#888;">抽出された単語がありませんでした。</td></tr>`;
        }

        rankingTbody.innerHTML = tableHTML;
    }

    // 上位N件切り替えイベント（グラフ・ランキング連動）
    const updateLimit = (val) => {
        const num = Math.max(1, parseInt(val, 10) || 30);
        if (chartNInput && parseInt(chartNInput.value, 10) !== num) chartNInput.value = num;
        if (tableNInput && parseInt(tableNInput.value, 10) !== num) tableNInput.value = num;
        if (latestSortedList.length > 0) {
            const wordCounts = {};
            const wordPos = {};
            latestSortedList.forEach(item => {
                wordCounts[item.word] = item.count;
                wordPos[item.word] = item.pos;
            });
            renderChartAndTable(wordCounts, wordPos, latestTotalCount);
        }
    };
    if (chartNInput) {
        chartNInput.addEventListener('input', () => updateLimit(chartNInput.value));
        chartNInput.addEventListener('change', () => updateLimit(chartNInput.value));
    }
    if (tableNInput) {
        tableNInput.addEventListener('input', () => updateLimit(tableNInput.value));
        tableNInput.addEventListener('change', () => updateLimit(tableNInput.value));
    }

    document.addEventListener('click', () => {
        document.querySelectorAll('.bar-row').forEach(r => r.classList.remove('show-tooltip'));
    });

    // 表示形式の切り替え（左=ランキング / 右=グラフ、初期状態: ランキング）
    function setViewMode(mode) {
        if (mode === 'ranking') {
            if (chartSection) chartSection.style.display = 'none';
            if (tableSection) tableSection.style.display = 'block';
            if (viewBtnRanking) {
                viewBtnRanking.classList.add('active');
                viewBtnRanking.setAttribute('aria-selected', 'true');
            }
            if (viewBtnGraph) {
                viewBtnGraph.classList.remove('active');
                viewBtnGraph.setAttribute('aria-selected', 'false');
            }
        } else {
            if (chartSection) chartSection.style.display = 'block';
            if (tableSection) tableSection.style.display = 'none';
            if (viewBtnGraph) {
                viewBtnGraph.classList.add('active');
                viewBtnGraph.setAttribute('aria-selected', 'true');
            }
            if (viewBtnRanking) {
                viewBtnRanking.classList.remove('active');
                viewBtnRanking.setAttribute('aria-selected', 'false');
            }
        }
    }

    if (viewBtnRanking) {
        viewBtnRanking.addEventListener('click', () => setViewMode('ranking'));
    }
    if (viewBtnGraph) {
        viewBtnGraph.addEventListener('click', () => setViewMode('graph'));
    }
    setViewMode('ranking');

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
});

