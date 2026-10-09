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
                const uniqueCandidates = Array.from(new Set(candidates));

                let lastError = null;
                for (const url of uniqueCandidates) {
                    try {
                        const fetchedRes = await fetchWithProgress(url, filename);
                        if (fetchedRes && fetchedRes.ok) {
                            if (cache) {
                                try { await cache.put(this._url, fetchedRes.clone()); } catch (e) {}
                            }
                            responseBuffer = await fetchedRes.arrayBuffer();
                            break;
                        }
                    } catch (err) {
                        lastError = err;
                    }
                }

                if (!responseBuffer) {
                    throw lastError || new Error(`辞書ファイル ${filename} のダウンロードに失敗しました`);
                }
            }

            this.status = 200;
            this.statusText = 'OK';
            this.response = responseBuffer;
            if (this.onload) this.onload.call(this);

        } catch (err) {
            console.error('Dic download error:', err);
            this.status = 500;
            this.statusText = err.message || 'Error';
            if (this.onerror) this.onerror.call(this, err);
        }
    }
}

async function fetchWithProgress(url, filename) {
    const res = await fetch(url);
    if (!res.ok) return res;

    const reader = res.body.getReader();
    let receivedLength = 0;
    const chunks = [];

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedLength += value.length;
        updateDicProgress(filename, receivedLength, false);
    }

    const all = new Uint8Array(receivedLength);
    let pos = 0;
    for (const chunk of chunks) {
        all.set(chunk, pos);
        pos += chunk.length;
    }

    return new Response(all.buffer, {
        headers: res.headers,
        status: res.status,
        statusText: res.statusText
    });
}

window.XMLHttpRequest = CachedDicXHR;

// ==========================================
// アプリケーション本体
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const fileInput = document.getElementById('file-input');
    const dropZone = document.getElementById('drop-zone');
    const dropZoneText = document.getElementById('drop-zone-text');
    const fileInfo = document.getElementById('file-info');
    const fileNameDisplay = document.getElementById('file-name-display');
    const analyzeBtn = document.getElementById('analyze-btn');
    const liveModeToggle = document.getElementById('live-mode-toggle');

    // POS Checkboxes
    const optPosNoun = document.getElementById('opt-pos-noun');
    const optPosVerb = document.getElementById('opt-pos-verb');
    const optPosAdj = document.getElementById('opt-pos-adj');
    const optPosPronoun = document.getElementById('opt-pos-pronoun');
    const optPosAdverb = document.getElementById('opt-pos-adverb');

    // Status & Badges
    const dicBadge = document.getElementById('dic-badge');
    const dicBadgeDot = document.getElementById('dic-badge-dot');
    const dicBadgeText = document.getElementById('dic-badge-text');

    const statusBox = document.getElementById('status-box');
    const statusText = document.getElementById('status-text');
    const statusProgressWrap = document.getElementById('status-progress-wrap');
    const statusProgressBar = document.getElementById('status-progress-bar');

    // Live Panel & Controls
    const livePanel = document.getElementById('live-panel');
    const liveBadge = document.getElementById('live-badge');
    const liveProgressText = document.getElementById('live-progress-text');
    const liveProgressFill = document.getElementById('live-progress-fill');
    const currentLineBox = document.getElementById('current-line-box');
    const tokenizedLineBox = document.getElementById('tokenized-line-box');
    const speedSlider = document.getElementById('speed-slider');
    const speedDisplay = document.getElementById('speed-display');
    const skipBtn = document.getElementById('skip-btn');

    // Results (abcounter仕様)
    const resultSection = document.getElementById('result-section');
    const totalCountDisplay = document.getElementById('total-count');
    const uniqueCountDisplay = document.getElementById('unique-count');
    const chartNInput = document.getElementById('chart-n-input');
    const xAxisTicks = document.getElementById('x-axis-ticks');
    const barsContainer = document.getElementById('bars-container');
    const rankingTbody = document.getElementById('ranking-tbody');

    let currentLoadedText = '';
    let currentLoadedFileName = '';
    let tokenizer = null;
    let initPromise = null;
    let isDictionaryReady = false;
    let skipAnimationRequested = false;
    let latestSortedList = [];
    let latestTotalCount = 0;

    // 速度スライダー制御 (600, 400, 300, 200, 0 ms)
    const SPEED_LABELS = { '1': 'とても遅い', '2': '遅い', '3': '標準', '4': '速い', '5': 'とても速い' };
    const SPEED_DELAYS = { '1': 600, '2': 400, '3': 300, '4': 200, '5': 1 };
    let currentDelay = SPEED_DELAYS['3'];

    speedSlider.addEventListener('input', () => {
        const val = speedSlider.value;
        speedDisplay.textContent = SPEED_LABELS[val] || '標準';
        currentDelay = SPEED_DELAYS[val] !== undefined ? SPEED_DELAYS[val] : 300;
    });

    // 辞書ロード進捗コールバック
    onDicProgressCallback = (percent, loadedBytes, totalBytes, isCached) => {
        if (isDictionaryReady) return;

        if (isCached) {
            // キャッシュ復元中の画面表示は消す
            hideStatus();
            // 右上の表示は「辞書ロード中...」のまま進める
            dicBadgeText.textContent = '辞書ロード中...';
            return;
        }

        const mbLoaded = (loadedBytes / (1024 * 1024)).toFixed(1);
        const mbTotal = (totalBytes / (1024 * 1024)).toFixed(1);

        statusBox.style.display = 'flex';
        statusProgressWrap.style.display = 'block';
        statusProgressBar.style.width = percent + '%';
        statusText.textContent = `形態素解析辞書をロード中... ${mbLoaded}MB / ${mbTotal}MB (${percent}%)`;
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
        dicBadgeText.textContent = '辞書準備完了 (利用可能)';
    }

    function initKuromoji() {
        if (tokenizer) return Promise.resolve(tokenizer);
        if (initPromise) return initPromise;

        // キャッシュチェック前の初期状態は右上バッジのみ「辞書ロード中...」
        dicBadgeText.textContent = '辞書ロード中...';
        initPromise = new Promise((resolve, reject) => {
            kuromoji.builder({
                dicPath: 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/'
            }).build((err, _tokenizer) => {
                if (err) {
                    hideStatus();
                    initPromise = null;
                    dicBadge.style.backgroundColor = '#fed7d7';
                    dicBadge.style.color = '#742a2a';
                    dicBadgeDot.style.backgroundColor = '#e53e3e';
                    dicBadgeText.textContent = '辞書ロード失敗';
                    alert('形態素解析エンジンの読み込みに失敗しました: ' + (err.message || err));
                    reject(err);
                } else {
                    tokenizer = _tokenizer;
                    setDicReady();
                    hideStatus();
                    resolve(tokenizer);
                }
            });
        });
        return initPromise;
    }

    initKuromoji().catch(console.error);

    // ドラッグ＆ドロップ & ファイル選択
    dropZone.addEventListener('click', () => fileInput.click());

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

    dropZone.addEventListener('drop', (e) => {
        if (e.dataTransfer.files.length > 0) {
            handleFile(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    });

    async function handleFile(file) {
        showStatus(`ファイル「${file.name}」を展開・読み込み中...`);
        try {
            const isZip = file.name.toLowerCase().endsWith('.zip');
            if (isZip) {
                const zip = new JSZip();
                const zipContent = await zip.loadAsync(file);
                let textFile = null;
                for (let filename in zipContent.files) {
                    if (filename.toLowerCase().endsWith('.txt') && !filename.startsWith('__MACOSX')) {
                        textFile = zipContent.files[filename];
                        break;
                    }
                }
                if (!textFile) {
                    alert('zip内にテキストファイル（.txt）が見つかりませんでした。');
                    hideStatus();
                    return;
                }
                const buf = await textFile.async('arraybuffer');
                currentLoadedText = decodeText(buf);
            } else {
                const buf = await file.arrayBuffer();
                currentLoadedText = decodeText(buf);
            }

            currentLoadedFileName = file.name;
            fileNameDisplay.textContent = file.name;
            fileInfo.style.display = 'block';
            dropZoneText.innerHTML = `選択中: <strong>${escapeHtml(file.name)}</strong>`;
            hideStatus();
        } catch (err) {
            console.error(err);
            alert('ファイルの読み込みに失敗しました: ' + err.message);
            hideStatus();
        }
    }

    function decodeText(buf) {
        try {
            return new TextDecoder('shift-jis', { fatal: true }).decode(buf);
        } catch (e) {
            try {
                return new TextDecoder('utf-8').decode(buf);
            } catch (e2) {
                return new TextDecoder('shift-jis').decode(buf);
            }
        }
    }

    // 青空文庫特有のクレンジング
    function cleanAozoraText(rawText) {
        let text = rawText;
        const b1 = text.indexOf('-------------------------------------------------------');
        if (b1 !== -1) {
            const b2 = text.indexOf('-------------------------------------------------------', b1 + 50);
            if (b2 !== -1) text = text.substring(b2 + 55);
        }
        const teihon = text.search(/底本：|底本:/);
        if (teihon !== -1 && teihon > text.length * 0.4) {
            text = text.substring(0, teihon);
        }
        text = text.replace(/《.*?》/g, '').replace(/｜/g, '');
        text = text.replace(/［＃.*?］/g, '').replace(/〔.*?〕/g, '');
        return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    }

    // 単語チェック（品詞チェックボックス参照）
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

    // 解析ボタン実行
    analyzeBtn.addEventListener('click', async () => {
        if (!currentLoadedText) {
            alert('青空文庫のzipまたはtxtファイルをアップロードしてください。');
            return;
        }

        if (!optPosNoun.checked && !optPosVerb.checked && !optPosAdj.checked && !optPosPronoun.checked && !optPosAdverb.checked) {
            alert('少なくとも1つの品詞をチェックしてください。');
            return;
        }

        analyzeBtn.disabled = true;
        skipAnimationRequested = false;

        try {
            if (!isDictionaryReady) {
                showStatus('形態素解析辞書の準備を待っています...（完了次第自動で開始）', true);
            }
            const t = await initKuromoji();
            showStatus('青空文庫テキストをクレンジング中...', false);
            const cleanedText = cleanAozoraText(currentLoadedText);

            if (!cleanedText) {
                alert('クレンジング後にテキストが空になりました。');
                hideStatus();
                return;
            }

            showStatus('形態素解析を実行中...', false);
            const tokens = t.tokenize(cleanedText);
            hideStatus();

            if (liveModeToggle.checked) {
                await runLiveStepAnimation(cleanedText, tokens);
            } else {
                // オフのときはアニメーション欄を非表示にする
                livePanel.style.display = 'none';
                updateFullResults(tokens);
            }
        } catch (err) {
            console.error(err);
            alert('解析中にエラーが発生しました: ' + err.message);
            hideStatus();
        } finally {
            analyzeBtn.disabled = false;
        }
    });

    // アニメーション可視化（素の文章 → スラッシュ挿入 → 打ち消し線 ＆ 初出ポップ演出 ＆ 都度グラフカウント）
    async function runLiveStepAnimation(cleanedText, tokens) {
        livePanel.style.display = 'block';
        resultSection.style.display = 'block';
        tokenizedLineBox.innerHTML = '';
        currentLineBox.textContent = '（解析開始）';
        liveProgressFill.style.width = '0%';
        liveProgressText.textContent = '0%';
        liveBadge.textContent = '解析中...';
        livePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        const runningWordCounts = {};
        const runningWordPos = {};
        let runningTotal = 0;

        // トークン列を句点（。！？）や改行で文ごとに正確にグループ化（100%完全一致）
        const sentenceGroups = [];
        let curGroup = [];
        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];
            curGroup.push(tok);
            if (/[。！？\n]/.test(tok.surface_form) || curGroup.length >= 35) {
                sentenceGroups.push(curGroup);
                curGroup = [];
            }
        }
        if (curGroup.length > 0) {
            sentenceGroups.push(curGroup);
        }

        const totalTokens = tokens.length;
        let processedTokensCount = 0;

        for (let sIdx = 0; sIdx < sentenceGroups.length; sIdx++) {
            if (skipAnimationRequested) break;
            const currentTokens = sentenceGroups[sIdx];
            const sentenceText = currentTokens.map(t => t.surface_form).join('').trim();
            if (!sentenceText) {
                processedTokensCount += currentTokens.length;
                continue;
            }

            // ① 元のデータを1行表示（トークン列から直接生成するため1文字のズレも起きない）
            currentLineBox.textContent = sentenceText;

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

            // Step C: 1つ1つ品詞判定し、対象外に打ち消し線、対象品詞をハイライト ＆ 都度グラフにカウント
            for (let i = 0; i < currentTokens.length; i++) {
                if (skipAnimationRequested) break;
                const token = currentTokens[i];
                const check = checkWordTarget(token);
                const span = tokenSpans[i];

                span.className = 'token-item'; // バッジスタイルに移行

                if (check.isTarget) {
                    // 対象品詞ハイライト
                    if (check.pos === '名詞') span.classList.add('token-noun');
                    else if (check.pos === '動詞') span.classList.add('token-verb');
                    else if (check.pos === '形容詞') span.classList.add('token-adj');
                    else if (check.pos === '代名詞') span.classList.add('token-pronoun');
                    else if (check.pos === '副詞') span.classList.add('token-adverb');

                    // 初出の単語ならポップ演出（ゴールド光彩）
                    const isFirstAppearance = !runningWordCounts[check.word];
                    if (isFirstAppearance) {
                        span.classList.add('token-first-appearance');
                    }

                    // ④ 都度グラフにカウント
                    runningTotal++;
                    runningWordCounts[check.word] = (runningWordCounts[check.word] || 0) + 1;
                    runningWordPos[check.word] = check.pos;
                    renderChartAndTable(runningWordCounts, runningWordPos, runningTotal);
                } else {
                    // 対象外は打ち消し線のみ
                    span.classList.add('token-excluded');
                }

                processedTokensCount++;

                // 進捗更新
                const progress = Math.min(100, Math.round((processedTokensCount / totalTokens) * 100));
                liveProgressFill.style.width = progress + '%';
                liveProgressText.textContent = `${progress}% (抽出: ${runningTotal}語)`;

                if (currentDelay > 0) {
                    await new Promise(r => setTimeout(r, currentDelay));
                }
            }

            // 文の合間のウェイト
            if (currentDelay > 0) {
                await new Promise(r => setTimeout(r, Math.max(currentDelay * 1.2, 50)));
            }
        }

        liveProgressFill.style.width = '100%';
        liveProgressText.textContent = '100% 完了';
        liveBadge.textContent = '解析完了！';

        // 最終集計の完全反映
        updateFullResults(tokens);
    }

    // 全件集計
    function updateFullResults(tokens) {
        const wordCounts = {};
        const wordPos = {};
        let total = 0;

        for (let i = 0; i < tokens.length; i++) {
            const check = checkWordTarget(tokens[i]);
            if (check.isTarget) {
                total++;
                wordCounts[check.word] = (wordCounts[check.word] || 0) + 1;
                wordPos[check.word] = check.pos;
            }
        }

        renderChartAndTable(wordCounts, wordPos, total);
        resultSection.style.display = 'block';
    }

    let measureCanvasCtx = null;
    function getTextWidth(text, font = 'bold 1.15rem sans-serif') {
        if (!measureCanvasCtx) {
            const canvas = document.createElement('canvas');
            measureCanvasCtx = canvas.getContext('2d');
        }
        measureCanvasCtx.font = font;
        return measureCanvasCtx.measureText(text).width;
    }

    // グラフ ＆ テーブル描画（上位n件、角丸なし、品詞色分け、先端に個数表示、グリッドなし）
    function renderChartAndTable(wordCounts, wordPos, total) {
        latestSortedList = Object.keys(wordCounts)
            .map(w => ({ word: w, count: wordCounts[w], pos: wordPos[w] }))
            .sort((a, b) => b.count - a.count);
        latestTotalCount = total;

        const uniqueCount = latestSortedList.length;
        totalCountDisplay.textContent = total.toLocaleString();
        uniqueCountDisplay.textContent = uniqueCount.toLocaleString();

        // 上位 n 件の取得
        const n = Math.max(1, parseInt(chartNInput.value, 10) || 30);
        const topWords = latestSortedList.slice(0, n);

        // 最長単語幅に応じたラベル幅・グラフ左余白の動的調整
        const minLabelWidth = 125;
        let maxWordWidth = 0;
        topWords.forEach(item => {
            const w = getTextWidth(item.word);
            if (w > maxWordWidth) maxWordWidth = w;
        });
        const labelWidth = Math.max(minLabelWidth, Math.ceil(maxWordWidth) + 8);
        const chartMarginLeft = labelWidth + 16;

        const chartLayout = document.querySelector('.horizontal-chart-layout');
        if (chartLayout) {
            chartLayout.style.setProperty('--label-width', `${labelWidth}px`);
            chartLayout.style.setProperty('--chart-margin-left', `${chartMarginLeft}px`);
        }

        let maxPercent = 0;
        topWords.forEach(item => {
            const p = total > 0 ? (item.count / total) * 100 : 0;
            if (p > maxPercent) maxPercent = p;
        });

        // X軸の目盛り（偶数刻み）
        let axisMax = 2;
        if (maxPercent > 0) {
            axisMax = Math.ceil(maxPercent / 2) * 2;
        }

        let ticksHTML = `<div class="x-tick zero">0%</div>`;
        for (let tick = 2; tick <= axisMax; tick += 2) {
            const posPercent = (tick / axisMax) * 100;
            ticksHTML += `<div class="x-tick" style="left: ${posPercent}%">${tick}%</div>`;
        }
        xAxisTicks.innerHTML = ticksHTML;

        // 横棒バーの生成（四角いバー・品詞色分け・先端に個数常時表示）
        barsContainer.innerHTML = '';
        topWords.forEach(item => {
            const p = total > 0 ? (item.count / total) * 100 : 0;
            const barWidth = axisMax > 0 ? (p / axisMax) * 100 : 0;

            // 品詞別クラス
            let posClass = 'noun';
            if (item.pos === '動詞') posClass = 'verb';
            else if (item.pos === '形容詞') posClass = 'adj';
            else if (item.pos === '代名詞') posClass = 'pronoun';
            else if (item.pos === '副詞') posClass = 'adverb';

            const row = document.createElement('div');
            row.className = 'bar-row';
            row.innerHTML = `
                <span class="bar-row-label" title="${escapeHtml(item.word)}">${escapeHtml(item.word)}</span>
                <div class="bar-row-track">
                    <div class="bar-row-fill ${posClass}" style="width: ${barWidth}%;">
                        <div class="tooltip-h">${escapeHtml(item.word)}: ${p.toFixed(1)}% (${item.count}回)</div>
                        <span class="bar-row-value">${item.count}回 (${p.toFixed(1)}%)</span>
                    </div>
                </div>
            `;

            row.addEventListener('click', (e) => {
                e.stopPropagation();
                const wasShowing = row.classList.contains('show-tooltip');
                document.querySelectorAll('.bar-row').forEach(r => r.classList.remove('show-tooltip'));
                if (!wasShowing) {
                    row.classList.add('show-tooltip');
                }
            });

            barsContainer.appendChild(row);
        });

        // ランキング表の生成
        const tableWords = latestSortedList.slice(0, 50);
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

    // 上位n件切り替えイベント
    const updateChartLimit = () => {
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
    chartNInput.addEventListener('input', updateChartLimit);
    chartNInput.addEventListener('change', updateChartLimit);

    // 画面外クリックでフキダシを閉じる
    document.addEventListener('click', () => {
        document.querySelectorAll('.bar-row').forEach(r => r.classList.remove('show-tooltip'));
    });

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
});

