/**
 * 3D作品リンク集 (3D Model Expo)
 * 
 * GitHub APIでディレクトリ内のExcelファイル（.xlsx）を自動検知し、
 * SheetJSでパースしてクラス別・作品一覧のSPAサイトを生成します。
 */

// ==========================================
// 設定：GitHubリポジトリ情報（手動変更可能）
// ==========================================
const GITHUB_USER = 'SodeClass';
const GITHUB_REPO = 'joho2';
const TARGET_DIR = '3Dmodel-expo'; // Excelファイルを配置するディレクトリ

// 状態管理
let allWorks = [];            // パース済みの全作品リスト
let detectedFileName = '';    // 読み込んだファイル名

// DOM要素の参照
const loadingBox = document.getElementById('loading-box');
const loadingText = document.getElementById('loading-text');
const errorBox = document.getElementById('error-box');
const errorTitle = document.getElementById('error-title');
const errorDesc = document.getElementById('error-desc');
const mainContent = document.getElementById('main-content');
const viewClassList = document.getElementById('view-class-list');
const viewWorkList = document.getElementById('view-work-list');
const emptyState = document.getElementById('empty-state');
const emptyMessage = document.getElementById('empty-message');
const classGrid = document.getElementById('class-grid');
const workGrid = document.getElementById('work-grid');
const classSummary = document.getElementById('class-summary');
const currentClassTitle = document.getElementById('current-class-title');
const workCountBadge = document.getElementById('work-count-badge');
const classQuickButtons = document.getElementById('class-quick-buttons');
const statusBadge = document.getElementById('status-badge');
const badgeDot = document.getElementById('badge-dot');
const badgeText = document.getElementById('badge-text');
const manualFileInput = document.getElementById('manual-file');
const btnRetryFetch = document.getElementById('btn-retry-fetch');

// ==========================================
// 初期化 & イベントリスナー
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    window.addEventListener('popstate', () => {
        renderCurrentRoute();
    });

    if (manualFileInput) {
        manualFileInput.addEventListener('change', handleManualFileSelect);
    }

    if (btnRetryFetch) {
        btnRetryFetch.addEventListener('click', () => {
            initData();
        });
    }

    initData();
});
// ==========================================
// データ読み込み処理 (GitHub API & フォールバック)
// ==========================================
function isSpreadsheetFile(filename) {
    if (!filename) return false;
    const lower = filename.toLowerCase();
    return lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.csv');
}

async function initData() {
    showLoading(true, 'GitHubリポジトリから作品データ（Excel）を探しています...');
    hideError();
    setBadge('loading', 'データ読込中...');

    try {
        const cleanDir = TARGET_DIR ? TARGET_DIR.replace(/^\/+|\/+$/g, '') : '';
        const apiUrl = cleanDir
            ? `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${cleanDir}`
            : `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/`;
        let targetFile = null;

        try {
            const res = await fetch(apiUrl, {
                headers: { 'Accept': 'application/vnd.github.v3+json' }
            });

            if (res.ok) {
                const files = await res.json();
                if (Array.isArray(files)) {
                    // .xlsx を最優先、無ければ .xls や .csv
                    const xlsxFiles = files.filter(f => f.name && f.name.toLowerCase().endsWith('.xlsx'));
                    if (xlsxFiles.length > 0) {
                        targetFile = xlsxFiles[0];
                    } else {
                        const otherFiles = files.filter(f => isSpreadsheetFile(f.name));
                        if (otherFiles.length > 0) targetFile = otherFiles[0];
                    }
                }
            } else if (res.status === 403) {
                console.warn('GitHub API rate limit exceeded or access forbidden.');
            }
        } catch (apiErr) {
            console.warn('GitHub API fetch failed:', apiErr);
        }

        // 指定フォルダで見つからず、かつTARGET_DIRがルート以外だった場合、ルートも探索
        if (!targetFile && cleanDir) {
            try {
                const rootApiUrl = `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/`;
                const rootRes = await fetch(rootApiUrl, {
                    headers: { 'Accept': 'application/vnd.github.v3+json' }
                });
                if (rootRes.ok) {
                    const rootFiles = await rootRes.json();
                    if (Array.isArray(rootFiles)) {
                        const rootXlsx = rootFiles.filter(f => f.name && f.name.toLowerCase().endsWith('.xlsx'));
                        if (rootXlsx.length > 0) {
                            targetFile = rootXlsx[0];
                        } else {
                            const other = rootFiles.filter(f => isSpreadsheetFile(f.name));
                            if (other.length > 0) targetFile = other[0];
                        }
                    }
                }
            } catch (rootApiErr) {
                console.warn('GitHub API root fetch failed:', rootApiErr);
            }
        }

        let arrayBuffer = null;

        if (targetFile && targetFile.download_url) {
            detectedFileName = targetFile.name;
            showLoading(true, `ファイル「${detectedFileName}」をダウンロード中...`);
            const downloadRes = await fetch(targetFile.download_url);
            if (!downloadRes.ok) {
                throw new Error(`ダウンロードに失敗しました (${downloadRes.status})`);
            }
            arrayBuffer = await downloadRes.arrayBuffer();
        } else {
            // ローカルテストや静的配信用フォールバック
            const fallbackPaths = [
                './３Dの新製品　提出用フォーム(1-2).xlsx',
                './３Dの新製品　提出用フォーム(1-1) (1).xlsx',
                './sample.xlsx',
                './data.xlsx',
                '../sample.xlsx',
                './sample.csv'
            ];
            let fallbackSuccess = false;

            for (const path of fallbackPaths) {
                try {
                    const fallbackRes = await fetch(encodeURI(path));
                    if (fallbackRes.ok) {
                        arrayBuffer = await fallbackRes.arrayBuffer();
                        detectedFileName = decodeURIComponent(path.split('/').pop());
                        fallbackSuccess = true;
                        break;
                    }
                } catch {
                    // 次の候補へ
                }
            }

            if (!fallbackSuccess) {
                const targetLocation = cleanDir ? `${GITHUB_USER}/${GITHUB_REPO}/${cleanDir}` : `${GITHUB_USER}/${GITHUB_REPO}`;
                throw new Error(`GitHub APIからリポジトリ (${targetLocation}) 内のExcelファイル (.xlsx) を検知できませんでした。ファイルがプッシュされているか、またはAPI制限をご確認ください。`);
            }
        }

        parseAndLoadSpreadsheet(arrayBuffer, detectedFileName);

    } catch (err) {
        console.error('Data load error:', err);
        showLoading(false);
        showError(
            'データファイルの自動取得に失敗しました',
            `${err.message}<br><br>ローカル環境のファイルや別のデータを確認する場合は、下のボタンからファイル（.xlsx）を選択してください。`
        );
        setBadge('error', '読み込みエラー');
    }
}

function handleManualFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    detectedFileName = file.name;
    showLoading(true, `選択されたファイル「${file.name}」を解析中...`);
    hideError();

    const reader = new FileReader();
    reader.onload = (e) => {
        const buffer = e.target.result;
        parseAndLoadSpreadsheet(buffer, file.name);
    };
    reader.onerror = () => {
        showLoading(false);
        showError('ファイル読み込み失敗', 'ファイルの読み込み中にエラーが発生しました。');
        setBadge('error', '読み込みエラー');
    };
    reader.readAsArrayBuffer(file);
}

// SheetJSによるExcel/CSVパース
function parseAndLoadSpreadsheet(dataBuffer, fileName) {
    if (!window.XLSX) {
        showError('エラー', 'SheetJS (xlsx) ライブラリのロードに失敗しました。');
        setBadge('error', 'ライブラリ未ロード');
        return;
    }

    try {
        const workbook = XLSX.read(dataBuffer, { type: 'array' });
        if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
            throw new Error('ワークブックにシートが存在しません。');
        }

        // 最初のシートを取得
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];

        // 1行目をヘッダーとしてJSON配列に変換
        const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

        processParsedData(rows, fileName);

    } catch (error) {
        console.error('SheetJS parse error:', error);
        showLoading(false);
        showError('ファイル解析エラー', `Excelファイルの解析に失敗しました: ${error.message}`);
        setBadge('error', '解析エラー');
    }
}

function processParsedData(rows, fileName) {
    if (!rows || rows.length === 0) {
        showLoading(false);
        showError('データがありません', 'ファイル内に有効なデータ行が見つかりませんでした。');
        setBadge('error', 'データなし');
        return;
    }

    const headers = Object.keys(rows[0] || {});
    const classKey = findMatchingKey(headers, ['クラスを選択してください', 'クラス', '学級']);
    const titleKey = findMatchingKey(headers, ['作品タイトル', 'タイトル', '作品名']);
    const sceneKey = findMatchingKey(headers, ['使い方', '使いかた', '使用方法', '活用場面', '場面', '活用']);
    const urlKey = findMatchingKey(headers, ['作品のＵＲＬ', '作品のURL', 'ＵＲＬ', 'URL', 'url', 'リンク']);

    allWorks = [];

    rows.forEach((row, index) => {
        const className = (classKey && row[classKey] !== undefined ? String(row[classKey]).trim() : '').trim();
        const title = (titleKey && row[titleKey] !== undefined ? String(row[titleKey]).trim() : '').trim();
        const scene = (sceneKey && row[sceneKey] !== undefined ? String(row[sceneKey]).trim() : '').trim();
        let url = (urlKey && row[urlKey] !== undefined ? String(row[urlKey]).trim() : '').trim();

        if (className || title) {
            allWorks.push({
                id: index + 1,
                className: className || '未設定',
                title: title || '（無題）',
                scene: scene || '（記載なし）',
                url: url
            });
        }
    });

    showLoading(false);

    if (allWorks.length === 0) {
        showError('有効なデータがありません', '指定のヘッダーに該当する有効なレコードが見つかりませんでした。');
        setBadge('error', 'データなし');
        return;
    }

    setBadge('ready', fileName);
    mainContent.style.display = 'block';

    renderCurrentRoute();
}

function findMatchingKey(headers, candidates) {
    for (const c of candidates) {
        if (headers.includes(c)) return c;
    }
    for (const c of candidates) {
        const lowerC = c.toLowerCase();
        const found = headers.find(h => h.trim().toLowerCase() === lowerC || h.includes(c));
        if (found) return found;
    }
    return null;
}

// ==========================================
// SPA ルーティング & 画面描画
// ==========================================

function renderCurrentRoute() {
    const urlParams = new URLSearchParams(window.location.search);
    const selectedClass = urlParams.get('class');

    if (selectedClass) {
        renderWorkList(selectedClass);
    } else {
        renderClassList();
    }
}

function navigateToClass(className) {
    const currentUrl = new URL(window.location.href);
    if (className) {
        currentUrl.searchParams.set('class', className);
    } else {
        currentUrl.searchParams.delete('class');
    }
    window.history.pushState({ class: className }, '', currentUrl.toString());
    renderCurrentRoute();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// [画面A] クラス一覧の描画
function renderClassList() {
    viewWorkList.style.display = 'none';
    viewClassList.style.display = 'block';
    emptyState.style.display = 'none';

    const classMap = new Map();
    allWorks.forEach(work => {
        const c = work.className;
        classMap.set(c, (classMap.get(c) || 0) + 1);
    });

    const uniqueClasses = Array.from(classMap.keys()).sort((a, b) => {
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });

    classSummary.textContent = `全 ${uniqueClasses.length} クラス`;
    classGrid.innerHTML = '';

    if (uniqueClasses.length === 0) {
        showEmpty('登録されているクラスがありません。');
        return;
    }

    uniqueClasses.forEach(cls => {
        const card = document.createElement('a');
        card.className = 'class-card btn-class-select';
        card.href = `?class=${encodeURIComponent(cls)}`;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', `${cls}の作品一覧へ`);

        card.addEventListener('click', (e) => {
            e.preventDefault();
            navigateToClass(cls);
        });

        card.innerHTML = `
            <div class="class-card-body">
                <div class="class-card-title">${escapeHtml(cls)}</div>
                <div class="class-card-btn-action">
                    <span>このクラスを見る</span>
                </div>
            </div>
        `;

        classGrid.appendChild(card);
    });
}

// [画面B] クラス別作品一覧の描画
function renderWorkList(className) {
    viewClassList.style.display = 'none';
    viewWorkList.style.display = 'block';
    emptyState.style.display = 'none';

    currentClassTitle.textContent = `${className} の作品一覧`;

    // クラス切り替えバーのボタンを動的生成
    if (classQuickButtons) {
        const classMap = new Map();
        allWorks.forEach(work => {
            const c = work.className;
            classMap.set(c, (classMap.get(c) || 0) + 1);
        });

        const uniqueClasses = Array.from(classMap.keys()).sort((a, b) => {
            return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
        });

        classQuickButtons.innerHTML = '';
        uniqueClasses.forEach(cls => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `btn-quick-class ${cls === className ? 'active' : ''}`;
            btn.textContent = cls;
            btn.setAttribute('aria-pressed', cls === className ? 'true' : 'false');
            btn.addEventListener('click', () => {
                if (cls !== className) {
                    navigateToClass(cls);
                }
            });
            classQuickButtons.appendChild(btn);
        });
    }

    const filteredWorks = allWorks.filter(w => w.className === className);
    if (workCountBadge) {
        workCountBadge.textContent = '';
    }
    workGrid.innerHTML = '';

    if (filteredWorks.length === 0) {
        showEmpty(`「${className}」の作品は登録されていません。`);
        return;
    }

    filteredWorks.forEach(work => {
        const card = document.createElement('div');
        card.className = 'work-card';

        const hasValidUrl = work.url && (work.url.startsWith('http://') || work.url.startsWith('https://'));
        const safeUrl = hasValidUrl ? escapeHtml(work.url) : '#';

        const actionBtnHtml = hasValidUrl
            ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="btn-view-work">
                 作品を見る
               </a>`
            : `<button type="button" class="btn-view-work disabled" disabled>URL未設定</button>`;

        card.innerHTML = `
            <div class="work-card-top">
                <span class="work-card-class-badge">${escapeHtml(work.className)}</span>
                <h3 class="work-title">${escapeHtml(work.title)}</h3>
                <div class="work-scene-container">
                    <span class="work-scene-label">【使い方】</span>
                    <p class="work-scene-text">${escapeHtml(work.scene)}</p>
                </div>
            </div>
            <div class="work-card-bottom">
                ${actionBtnHtml}
            </div>
        `;

        workGrid.appendChild(card);
    });
}

// ==========================================
// UIヘルパー関数
// ==========================================

function showLoading(show, message = '') {
    if (show) {
        loadingBox.style.display = 'flex';
        if (message) loadingText.textContent = message;
    } else {
        loadingBox.style.display = 'none';
    }
}

function showError(title, message) {
    errorBox.style.display = 'block';
    errorTitle.textContent = title;
    errorDesc.innerHTML = message;
}

function hideError() {
    errorBox.style.display = 'none';
}

function showEmpty(message) {
    emptyState.style.display = 'block';
    emptyMessage.textContent = message;
}

function setBadge(state, text) {
    badgeText.textContent = text;
    badgeDot.className = 'badge-dot';
    if (state === 'ready') {
        badgeDot.classList.add('ready');
    } else if (state === 'error') {
        badgeDot.classList.add('error');
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

