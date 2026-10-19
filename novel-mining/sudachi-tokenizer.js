/**
 * Sudachi (WebAssembly) Tokenizer Wrapper
 */
(function (global) {
    'use strict';

    const DB_NAME = 'sudachi_cache_db';
    const STORE_NAME = 'dict_store';
    const DICT_KEY = 'sudachidict_small_20240409';
    const DB_VERSION = 1;

    const DICT_ZIP_URL = 'https://s3.ap-northeast-1.amazonaws.com/sudachi/sudachidict/sudachi-dictionary-20240409-small.zip';
    const DICT_FALLBACK_URL = 'https://unpkg.com/sudachi-wasm333@1.0.4/resources/system.dic';
    const WASM_JS_URL = 'https://cdn.jsdelivr.net/npm/sudachi-wasm333@1.0.4/sudachi.js';

    function openDB() {
        return new Promise((resolve, reject) => {
            if (!global.indexedDB) return reject(new Error('IndexedDB is not supported'));
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function getCachedDict() {
        try {
            const db = await openDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const req = store.get(DICT_KEY);
                req.onsuccess = () => resolve(req.result ? new Uint8Array(req.result) : null);
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            console.warn('IndexedDB get failed:', e);
            return null;
        }
    }

    async function setCachedDict(bytes) {
        try {
            const db = await openDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                const req = store.put(bytes.buffer, DICT_KEY);
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            console.warn('IndexedDB set failed:', e);
        }
    }

    async function downloadWithProgress(url, onProgress) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        const contentLength = response.headers.get('content-length');
        const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

        if (!response.body || !totalBytes) {
            const buffer = await response.arrayBuffer();
            if (onProgress) onProgress(100, buffer.byteLength, buffer.byteLength, false);
            return buffer;
        }

        const reader = response.body.getReader();
        let loadedBytes = 0;
        const chunks = [];

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loadedBytes += value.length;
            if (onProgress) {
                const percent = Math.min(Math.round((loadedBytes / totalBytes) * 100), 99);
                onProgress(percent, loadedBytes, totalBytes, false);

            }
        }

        const fullBuffer = new Uint8Array(loadedBytes);
        let offset = 0;
        for (const chunk of chunks) {
            fullBuffer.set(chunk, offset);
            offset += chunk.length;
        }
        return fullBuffer.buffer;
    }

    async function extractDictFromZip(zipBuffer, onProgress) {
        if (onProgress) onProgress(99, zipBuffer.byteLength, zipBuffer.byteLength, false, '辞書データを展開中...');
        if (!global.JSZip) throw new Error('JSZip library is required to extract dictionary zip');
        const zip = await global.JSZip.loadAsync(zipBuffer);
        const dicEntry = Object.values(zip.files).find(f => f.name.endsWith('.dic'));
        if (!dicEntry) throw new Error('Zip内に .dic ファイルが見つかりませんでした');
        return await dicEntry.async('uint8array');
    }

    function adaptSudachiToken(tok) {
        const poses = tok.poses || [];
        const p0 = poses[0] || '';
        const p1 = poses[1] || '';

        let pos = p0;
        let pos_detail_1 = p1;

        if (p0 === '代名詞') {
            pos = '名詞';
            pos_detail_1 = '代名詞';
        } else if (p0 === '形状詞') {
            pos = '形容詞';
            pos_detail_1 = p1;
        } else if (p0 === '接尾辞' || p1.includes('接尾')) {
            pos_detail_1 = '接尾';
        } else if (p1 === '数詞') {
            pos_detail_1 = '数';
        }

        const surface = tok.surface || '';
        const basic = tok.dictionary_form && tok.dictionary_form !== '*' ? tok.dictionary_form : surface;

        return {
            surface_form: surface,
            basic_form: basic,
            pos: pos,
            pos_detail_1: pos_detail_1,
            reading: tok.reading_form || '',
            normalized_form: tok.normalized_form || surface
        };
    }

    function splitTextIntoChunks(text, maxChars = 8000) {
        if (!text || text.length <= maxChars) return [text];
        const chunks = [];
        let start = 0;
        while (start < text.length) {
            if (text.length - start <= maxChars) {
                chunks.push(text.slice(start));
                break;
            }
            const searchRegion = text.slice(start, start + maxChars);
            let splitIdx = -1;
            const lastNewline = searchRegion.lastIndexOf('\n');
            if (lastNewline > maxChars * 0.5) {
                splitIdx = lastNewline + 1;
            } else {
                const match = searchRegion.match(/[。！？][^。！？]*$/);
                if (match && match.index > maxChars * 0.4) {
                    splitIdx = match.index + 1;
                }
            }
            if (splitIdx === -1) {
                splitIdx = maxChars;
            }
            chunks.push(text.slice(start, start + splitIdx));
            start += splitIdx;
        }
        return chunks;
    }

    let sudachiInstance = null;
    let currentMode = 2; // TokenizeMode.C (長単位)
    let initPromise = null;

    const SudachiTokenizer = {
        TokenizeMode: { A: 0, B: 1, C: 2 },
        setMode(mode) {
            currentMode = Number(mode);
            if (sudachiInstance) sudachiInstance.mode = currentMode;
        },
        getMode() { return currentMode; },
        isReady() { return sudachiInstance !== null; },
        async init(onProgress) {
            if (sudachiInstance) return this;
            if (initPromise) return initPromise;

            initPromise = (async () => {
                const wasmModule = await import(WASM_JS_URL);
                const { SudachiStateful, TokenizeMode } = wasmModule;

                let dicBytes = await getCachedDict();
                if (dicBytes) {
                    if (onProgress) onProgress(100, dicBytes.byteLength, dicBytes.byteLength, true);
                } else {
                    let zipBuffer;
                    try {
                        zipBuffer = await downloadWithProgress(DICT_ZIP_URL, onProgress);
                    } catch (e) {
                        console.warn('S3からの取得に失敗したため、代替URLを試みます...', e);
                        try {
                            const rawBuffer = await downloadWithProgress(DICT_FALLBACK_URL, onProgress);
                            dicBytes = new Uint8Array(rawBuffer);
                        } catch (e2) {
                            throw new Error('辞書データのダウンロードに失敗しました: ' + (e2.message || e2));
                        }
                    }

                    if (!dicBytes && zipBuffer) {
                        dicBytes = await extractDictFromZip(zipBuffer, onProgress);
                    }

                    if (dicBytes) {
                        setCachedDict(dicBytes).catch(err => console.warn('Cache write failed:', err));
                    }
                }

                if (!dicBytes) throw new Error('辞書バイナリの取得に失敗しました');

                const instance = new SudachiStateful();
                instance.initialize_from_bytes(dicBytes, currentMode);
                sudachiInstance = instance;
                return this;
            })();

            return initPromise;
        },
        tokenize(text, mode = currentMode) {
            if (!sudachiInstance) throw new Error('Sudachi はまだ初期化されていません');
            if (!text) return [];

            const targetMode = Number(mode !== undefined ? mode : currentMode);
            const chunks = splitTextIntoChunks(text, 4000);
            const allTokens = [];

            for (const chunk of chunks) {
                if (!chunk) continue;
                try {
                    const rawTokens = sudachiInstance.tokenize_raw(chunk, targetMode);
                    if (Array.isArray(rawTokens)) {
                        for (let i = 0; i < rawTokens.length; i++) {
                            allTokens.push(adaptSudachiToken(rawTokens[i]));
                        }
                    }
                } catch (err) {
                    const msg = (err && (err.message || err.details || err.error)) || String(err);
                    throw new Error(`Sudachi 解析エラー: ${msg}`);
                }
            }

            return allTokens;
        },
        async tokenizeAsync(text, mode = currentMode, onProgress = null) {
            if (!sudachiInstance) throw new Error('Sudachi はまだ初期化されていません');
            if (!text) {
                if (onProgress) onProgress(100);
                return [];
            }

            const targetMode = Number(mode !== undefined ? mode : currentMode);
            const chunks = splitTextIntoChunks(text, 4000);
            const allTokens = [];
            const totalChunks = chunks.length;

            if (onProgress) onProgress(0);

            for (let i = 0; i < totalChunks; i++) {
                const chunk = chunks[i];
                if (chunk) {
                    try {
                        const rawTokens = sudachiInstance.tokenize_raw(chunk, targetMode);
                        if (Array.isArray(rawTokens)) {
                            for (let j = 0; j < rawTokens.length; j++) {
                                allTokens.push(adaptSudachiToken(rawTokens[j]));
                            }
                        }
                    } catch (err) {
                        const msg = (err && (err.message || err.details || err.error)) || String(err);
                        throw new Error(`Sudachi 解析エラー: ${msg}`);
                    }
                }
                const percent = Math.min(100, Math.round(((i + 1) / totalChunks) * 100));
                if (onProgress) {
                    onProgress(percent);
                }
                // UI再描画を許可するためにイベントループに yield
                await new Promise(resolve => setTimeout(resolve, 0));
            }

            return allTokens;
        }
    };

    global.SudachiTokenizer = SudachiTokenizer;

})(typeof window !== 'undefined' ? window : globalThis);

