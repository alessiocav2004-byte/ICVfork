const express = require('express');
const axios = require('axios');
const router = express.Router();
const dbHelper = require('./db-helper.cjs');
const packFilesHandler = require('./pack-files-handler.cjs');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// Import ID Converter for TMDB support
let idConverter;
try {
    idConverter = require('./lib/id-converter.cjs');
} catch (e) {
    console.warn("⚠️ [MANUAL-IMPORT] Could not load id-converter. TMDB support might be limited.", e);
}

// Multer config for file uploads.
// fieldSize must accommodate base64-encoded torrent payloads sent as text fields
// (FormData.append('torrentFileBase64', ...)). Default multer fieldSize=1MB rejects
// any torrent file > ~750 KB on the wire and crashes with HTML 500 ('Unexpected
// token "<"' on the client). 25 MB allows real-world .torrent files up to ~18 MB.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 25 * 1024 * 1024,
        fieldSize: 25 * 1024 * 1024
    }
});

// ✅ CONFIGURA QUI O PASSA NEL BODY
// Se vuoto, cercherà nel body della richiesta
const DEFAULT_RD_KEY = process.env.REALDEBRID_API_KEY;
const DEFAULT_TB_KEY = process.env.TORBOX_API_KEY;

// HELPER: Normalize infoHash from Hex (40 chars) or Base32 (32 chars) to 40-char Hex
function normalizeInfoHash(hashOrMagnet) {
    if (!hashOrMagnet || typeof hashOrMagnet !== 'string') return null;
    let raw = hashOrMagnet.trim();
    const match = raw.match(/xt=urn:btih:([a-zA-Z0-9]+)/i) || raw.match(/\b([a-zA-Z0-9]{32,40})\b/i);
    if (match) raw = match[1];

    if (/^[0-9a-fA-F]{40}$/.test(raw)) {
        return raw.toLowerCase();
    }
    if (/^[2-7a-zA-Z]{32}$/.test(raw)) {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        let bits = "";
        const clean = raw.toUpperCase();
        for (let i = 0; i < clean.length; i++) {
            const val = alphabet.indexOf(clean[i]);
            if (val === -1) return null;
            bits += val.toString(2).padStart(5, "0");
        }
        let hex = "";
        for (let i = 0; i + 4 <= bits.length; i += 4) {
            hex += parseInt(bits.substring(i, i + 4), 2).toString(16);
        }
        return hex.toLowerCase();
    }
    return null;
}

// HELPER: Extract display name (dn=) from a magnet link
function extractDnFromMagnet(magnetLink) {
    if (!magnetLink || typeof magnetLink !== 'string') return null;
    const m = magnetLink.match(/[?&]dn=([^&]+)/i);
    if (!m) return null;
    try {
        // dn is URL-encoded; spaces may be '+' or '%20'
        return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim() || null;
    } catch {
        return m[1];
    }
}

// HELPER: Extract season from full path (e.g., "Show/Season 4/Episode 1.mkv")
function parseSeasonFromPath(fullPath) {
    if (!fullPath) return null;
    const parts = fullPath.split('/');
    // Check parent folders for "Season X" or "S0X" or "Stagione X"
    // Iterate backwards from parent of file
    for (let i = parts.length - 2; i >= 0; i--) {
        const folder = parts[i];
        // Match:
        // 1. "Season 1", "Stagione 1"
        // 2. "S01", "S1" (Start/End of string or surrounded by separators)
        // 3. "Show Name S01"
        const seasonMatch = folder.match(/([sS]eason|[sS]tagione)\s*(\d{1,2})/i) ||
            folder.match(/(?:^|[^a-zA-Z])[sS](\d{1,2})(?:$|[^a-zA-Z])/);

        if (seasonMatch) {
            // If match is from the second regex group (S01), capturing group is 1.
            // If first (Season 01), capturing group is 2.
            // We need to check which match succeeded.
            const val = seasonMatch[2] ? seasonMatch[2] : seasonMatch[1];
            return parseInt(val);
        }
    }
    return null;
}

/**
 * HELPER: fetchFilesFromRealDebrid (Copiato da pack-files-handler.cjs perché non esportato)
 */
async function fetchFilesFromRealDebrid(infoHash, rdKey) {
    const baseUrl = 'https://api.real-debrid.com/rest/1.0';
    const headers = { 'Authorization': `Bearer ${rdKey}` };

    try {
        console.log(`📦 [MANUAL-IMPORT] Adding magnet to RD check: ${infoHash}`);


        const magnetLink = `magnet:?xt=urn:btih:${infoHash}`;

        // 1. Add Magnet
        const addResponse = await axios.post(
            `${baseUrl}/torrents/addMagnet`,
            `magnet=${encodeURIComponent(magnetLink)}`,
            { headers, timeout: 30000 }
        );

        if (!addResponse.data || !addResponse.data.id) throw new Error('Failed to add magnet to RD');
        const torrentId = addResponse.data.id;

        // 2. Get Info
        const infoResponse = await axios.get(
            `${baseUrl}/torrents/info/${torrentId}`,
            { headers, timeout: 30000 }
        );

        if (!infoResponse.data || !infoResponse.data.files) {
            await axios.delete(`${baseUrl}/torrents/delete/${torrentId}`, { headers }).catch(() => { });
            throw new Error('No files in torrent info');
        }

        const files = infoResponse.data.files.map((f) => ({
            id: f.id,
            path: f.path,
            bytes: f.bytes,
            selected: f.selected
        }));

        // 3. Delete
        await axios.delete(`${baseUrl}/torrents/delete/${torrentId}`, { headers }).catch(() => { });

        // ✅ SMART FILENAME SELECTION (Robust Check)
        const rdFilename = infoResponse.data.filename;
        const rdOriginalFilename = infoResponse.data.original_filename;

        const invalidTerms = ['invalid magnet', 'magnet', 'torrent', 'download', 'error', 'unavailable', '404 not found'];
        const isInvalid = (name) => {
            if (!name) return true;
            const lower = name.toLowerCase();
            return invalidTerms.some(term => lower.includes(term)) || name.length < 5;
        };

        // Algorithm:
        // 1. Try Original Filename (Priority) -> If valid, use it.
        // 2. If invalid, Try Filename -> If valid, use it.
        // 3. If both invalid, fallback to Original (usually contains the real title even if "invalid" somehow) or Filename

        let finalFilename = rdOriginalFilename;

        if (!isInvalid(rdOriginalFilename)) {
            finalFilename = rdOriginalFilename;
        } else if (!isInvalid(rdFilename)) {
            finalFilename = rdFilename;
        } else {
            // Both are "bad" or Original is missing. Fallback.
            finalFilename = rdOriginalFilename || rdFilename;
        }

        return {
            torrentId,
            files,
            filename: finalFilename
        };

    } catch (error) {
        console.error(`❌ [MANUAL-IMPORT] RD API error: ${error.message}`);
        throw error;
    }
}

/**
 * HELPER: fetchFilesFromTorboxCache (fast, read-only — checkcached only)
 * Returns null if hash is not in TB cache. Does NOT add the torrent.
 */
async function fetchFilesFromTorboxCache(infoHash, torboxKey) {
    const baseUrl = 'https://api.torbox.app/v1/api';
    const headers = { 'Authorization': `Bearer ${torboxKey}` };
    try {
        const cacheResponse = await axios.get(`${baseUrl}/torrents/checkcached`, {
            headers,
            params: { hash: infoHash.toUpperCase(), format: 'object', list_files: true },
            timeout: 10000
        });
        const cacheData = cacheResponse.data?.data;
        if (cacheData) {
            const hashKey = Object.keys(cacheData).find(k => k.toLowerCase() === infoHash.toLowerCase());
            if (hashKey && cacheData[hashKey]?.files?.length > 0) {
                const sortedFiles = [...cacheData[hashKey].files].sort((a, b) => (a.name || a.path || '').localeCompare(b.name || b.path || ''));
                let cachedName = cacheData[hashKey].name || cacheData[hashKey].title || null;
                if (!cachedName && sortedFiles.length > 0) {
                    const firstPath = sortedFiles[0].name || sortedFiles[0].path || '';
                    if (firstPath.includes('/')) cachedName = firstPath.split('/')[0];
                }
                return {
                    torrentId: 'cached',
                    files: sortedFiles.map((f, idx) => ({ id: idx, path: f.name || f.path, bytes: f.size || 0 })),
                    filename: cachedName
                };
            }
        }
        return null;
    } catch (e) {
        console.warn(`⚠️ [MANUAL-IMPORT] TB cache check failed: ${e.message}`);
        return null;
    }
}

/**
 * HELPER: fetchFilesFromTorboxCreate (slow, side-effect — createtorrent + delete)
 * Adds the magnet to Torbox to retrieve file list, then deletes it.
 */
async function fetchFilesFromTorboxCreate(infoHash, torboxKey) {
    const baseUrl = 'https://api.torbox.app/v1/api';
    const headers = { 'Authorization': `Bearer ${torboxKey}` };

    try {
        const magnetLink = `magnet:?xt=urn:btih:${infoHash}`;
        const addResponse = await axios.post(`${baseUrl}/torrents/createtorrent`, { magnet: magnetLink }, { headers });
        const torrentId = addResponse.data?.data?.torrent_id;
        if (!torrentId) throw new Error('Failed to add to Torbox');

        await new Promise(r => setTimeout(r, 2000));

        const infoResponse = await axios.get(`${baseUrl}/torrents/mylist`, { headers, params: { id: torrentId } });
        const torrent = infoResponse.data?.data?.find(t => t.id === torrentId);

        // Per Torbox API docs: delete uses POST /torrents/controltorrent with JSON body
        await axios.post(
            `${baseUrl}/torrents/controltorrent`,
            { torrent_id: torrentId, operation: 'delete' },
            { headers: { ...headers, 'Content-Type': 'application/json' } }
        ).catch(e => console.warn(`⚠️ [MANUAL-IMPORT] TB delete failed for ${torrentId}: ${e.message}`));

        if (!torrent || !torrent.files) throw new Error('No files found in Torbox');

        const sortedFiles = [...torrent.files].sort((a, b) => (a.name || a.path || '').localeCompare(b.name || b.path || ''));
        return {
            torrentId,
            files: sortedFiles.map((f, idx) => ({ id: f.id !== undefined ? f.id : idx, path: f.name || f.path, bytes: f.size || 0 })),
            filename: torrent.name || torrent.title || null
        };
    } catch (error) {
        console.error(`❌ [MANUAL-IMPORT] Torbox createtorrent error: ${error.message}`);
        throw error;
    }
}

/**
 * HELPER: fetchFilesFromTorbox (legacy combined — tries cache then create)
 * Kept for backward compatibility with /preview-files.
 */
async function fetchFilesFromTorbox(infoHash, torboxKey) {
    const cached = await fetchFilesFromTorboxCache(infoHash, torboxKey);
    if (cached) return cached;
    return fetchFilesFromTorboxCreate(infoHash, torboxKey);
}

/**
 * fetchTorrentFromDHT
 * Recupera il file .torrent (metadata) di un magnet collegandosi direttamente
 * a DHT/peer via webtorrent. Non scarica il contenuto, solo i metadata (pochi KB).
 * Richiede outbound UDP+TCP — disabilitare con ENABLE_DHT_FALLBACK=false su
 * host che bloccano UDP (es. alcuni PaaS).
 */
async function fetchTorrentFromDHT(infoHash, magnetLink = null, timeoutMs = 20000) {
    if (process.env.ENABLE_DHT_FALLBACK === 'false') {
        console.log(`⏭️ [MANUAL-IMPORT] DHT fallback disabled via env`);
        return null;
    }

    let WebTorrent;
    try {
        const mod = await import('webtorrent');
        WebTorrent = mod.default || mod;
    } catch (e) {
        console.warn(`⚠️ [MANUAL-IMPORT] webtorrent not available: ${e.message}`);
        return null;
    }

    const magnet = magnetLink || `magnet:?xt=urn:btih:${infoHash}`;
    console.log(`🛰️ [MANUAL-IMPORT] DHT/peers lookup for ${infoHash.substring(0, 8)}... (timeout ${timeoutMs}ms)`);
    const t0 = Date.now();

    return new Promise((resolve) => {
        let client;
        try {
            client = new WebTorrent();
        } catch (e) {
            console.warn(`⚠️ [MANUAL-IMPORT] DHT init failed: ${e.message}`);
            return resolve(null);
        }

        let done = false;
        const cleanup = (result) => {
            if (done) return;
            done = true;
            try { client.destroy(() => {}); } catch (_) {}
            resolve(result);
        };

        const timer = setTimeout(() => {
            console.warn(`⌛ [MANUAL-IMPORT] DHT timeout after ${timeoutMs}ms`);
            cleanup(null);
        }, timeoutMs);

        client.on('error', (err) => {
            console.warn(`⚠️ [MANUAL-IMPORT] DHT client error: ${err.message}`);
            clearTimeout(timer);
            cleanup(null);
        });

        try {
            // path:false → no disk write; deselect → don't download any piece
            const torrent = client.add(magnet, { path: false, deselect: true }, (t) => {
                clearTimeout(timer);
                const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                const files = (t.files || []).map((f, idx) => ({
                    id: idx,
                    path: f.path,
                    bytes: f.length
                }));
                console.log(`✅ [MANUAL-IMPORT] DHT got "${t.name}" (${files.length} files) in ${elapsed}s`);
                cleanup({
                    torrentId: 'dht',
                    files,
                    filename: t.name || null
                });
            });

            torrent.on('error', (err) => {
                console.warn(`⚠️ [MANUAL-IMPORT] DHT torrent error: ${err.message}`);
                clearTimeout(timer);
                cleanup(null);
            });
        } catch (e) {
            console.warn(`⚠️ [MANUAL-IMPORT] DHT add failed: ${e.message}`);
            clearTimeout(timer);
            cleanup(null);
        }
    });
}

/**
 * NEW: fetchTorrentFromCaches (Optimized Parallel)
 * Tries to download .torrent file from public caches effectively
 */
async function fetchTorrentFromCaches(infoHash) {
    const hashUpper = infoHash.toUpperCase();
    // Active caches as of 2026:
    //  - itorrents.net (primary; .org redirects here)
    //  - itorrents.org (kept as fallback in case .net is unreachable)
    // Removed:
    //  - torrage.info (returns HTML landing page for every request)
    //  - btcache.me   (returns 403 Forbidden globally)
    const urls = [
        `https://itorrents.net/torrent/${hashUpper}.torrent`,
        `https://itorrents.org/torrent/${hashUpper}.torrent`
    ];

    console.log(`🔍 [MANUAL-IMPORT] Parallel fetch for .torrent from ${urls.length} caches for ${infoHash}...`);

    // Helper to fetch from one URL
    const fetchOne = async (url) => {
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 8000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });

            if (response.status === 200 && response.data) {
                const buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
                if (buffer.length > 500 && buffer[0] === 0x64) {
                    const base64 = buffer.toString('base64');
                    return parseTorrentFile(base64);
                }
            }
            throw new Error('Invalid data');
        } catch (e) {
            throw new Error(`Failed ${url}: ${e.message}`);
        }
    };

    try {
        const result = await Promise.any(urls.map(u => fetchOne(u)));
        console.log(`✅ [MANUAL-IMPORT] Cache Hit for ${infoHash}`);
        return result;
    } catch (aggregateError) {
        console.warn(`❌ [MANUAL-IMPORT] Cache Miss for ${infoHash} (All sources failed)`);
        return null;
    }
}


/**
 * Simple Bencode decoder for parsing .torrent files
 * Extracts info_hash by hashing the 'info' dictionary
 */
const crypto = require('crypto');

function decodeBencode(buffer, start = 0) {
    const char = String.fromCharCode(buffer[start]);

    if (char === 'i') {
        // Integer: i<number>e
        let end = start + 1;
        while (buffer[end] !== 0x65) end++; // 'e'
        const num = parseInt(buffer.slice(start + 1, end).toString());
        return { value: num, end: end + 1 };
    } else if (char === 'l') {
        // List: l<items>e
        const list = [];
        let pos = start + 1;
        while (buffer[pos] !== 0x65) {
            const result = decodeBencode(buffer, pos);
            list.push(result.value);
            pos = result.end;
        }
        return { value: list, end: pos + 1 };
    } else if (char === 'd') {
        // Dictionary: d<key><value>...e
        const dict = {};
        let pos = start + 1;
        while (buffer[pos] !== 0x65) {
            const keyResult = decodeBencode(buffer, pos);
            const valResult = decodeBencode(buffer, keyResult.end);
            dict[keyResult.value] = valResult.value;
            pos = valResult.end;
        }
        return { value: dict, end: pos + 1 };
    } else if (char >= '0' && char <= '9') {
        // String: <length>:<data>
        let colonPos = start;
        while (buffer[colonPos] !== 0x3A) colonPos++; // ':'
        const len = parseInt(buffer.slice(start, colonPos).toString());
        const strStart = colonPos + 1;
        const strEnd = strStart + len;
        // Return as string if ASCII, otherwise as buffer
        const data = buffer.slice(strStart, strEnd);
        try {
            return { value: data.toString('utf8'), end: strEnd };
        } catch {
            return { value: data, end: strEnd };
        }
    }
    throw new Error('Invalid bencode at position ' + start);
}

function parseTorrentFile(base64Data) {
    const buffer = Buffer.from(base64Data, 'base64');
    const decoded = decodeBencode(buffer, 0).value;

    if (!decoded.info) throw new Error('No info dictionary in torrent');

    // Find the raw bytes of the info dict to hash it
    // We need to re-encode it or find it in the original buffer
    const infoStart = buffer.indexOf('4:info') + 6;
    const infoResult = decodeBencode(buffer, infoStart);
    const infoBytes = buffer.slice(infoStart, infoResult.end);

    const hash = crypto.createHash('sha1');
    hash.update(infoBytes);
    const infoHash = hash.digest('hex');

    // Extract file list
    const info = decoded.info;
    const files = [];
    const torrentName = info.name || 'Unknown';

    if (info.files) {
        // Multi-file torrent
        info.files.forEach((f, idx) => {
            const path = Array.isArray(f.path) ? f.path.join('/') : f.path;
            files.push({ id: idx, path: torrentName + '/' + path, bytes: f.length });
        });
    } else {
        // Single file
        files.push({ id: 0, path: info.name, bytes: info.length });
    }

    return { infoHash, files, filename: torrentName };
}

// ══════ HELPER SPECIFICHE MEDIA & TAGS ══════
function detectTorrentSpecs(titleOrPath) {
    if (!titleOrPath) return { audioLanguages: [], subLanguages: [], resolution: 'auto', quality: 'auto', codec: 'auto', visualTags: [], audioTags: [] };
    const str = String(titleOrPath);

    // Risoluzione
    let resolution = 'auto';
    if (/2160p?|4k|uhd/i.test(str)) resolution = '2160p';
    else if (/1080p?/i.test(str)) resolution = '1080p';
    else if (/720p?/i.test(str)) resolution = '720p';
    else if (/576p?/i.test(str)) resolution = '576p';
    else if (/480p?|sd\b/i.test(str)) resolution = '480p';
    else if (/dvdrip/i.test(str)) resolution = 'DVDRip';

    // Qualità
    let quality = 'auto';
    if (/\bremux\b/i.test(str)) quality = 'Remux';
    else if (/blu.?ray|bdrip|brrip/i.test(str)) quality = 'BluRay';
    else if (/web.?dl/i.test(str)) quality = 'WEB-DL';
    else if (/web.?rip/i.test(str)) quality = 'WEBRip';
    else if (/hdtv/i.test(str)) quality = 'HDTV';
    else if (/dvd.?rip/i.test(str)) quality = 'DVDRip';
    else if (/\bcam\b|telesync|\bts\b/i.test(str)) quality = 'CAM';

    // Codec
    let codec = 'auto';
    if (/hevc|x.?265|h.?265/i.test(str)) codec = 'HEVC';
    else if (/avc|x.?264|h.?264/i.test(str)) codec = 'AVC';
    else if (/\bav1\b/i.test(str)) codec = 'AV1';
    else if (/xvid|divx/i.test(str)) codec = 'XviD';

    // Visual tags
    const visualTags = [];
    if (/dolby.?vision|dovi|\bdv\b/i.test(str)) visualTags.push('DV');
    if (/hdr10\+/i.test(str)) visualTags.push('HDR10+');
    else if (/hdr10/i.test(str)) visualTags.push('HDR10');
    else if (/\bhdr\b/i.test(str)) visualTags.push('HDR');

    // Audio tags
    const audioTags = [];
    if (/atmos/i.test(str)) audioTags.push('Atmos');
    if (/dts.?hd/i.test(str)) audioTags.push('DTS-HD');
    if (/7\.?1/i.test(str)) audioTags.push('7.1');
    else if (/5\.?1/i.test(str)) audioTags.push('5.1');
    if (/dd\+|ddp|eac3/i.test(str)) audioTags.push('AC3');
    else if (/ac3/i.test(str)) audioTags.push('AC3');
    if (/\baac\b/i.test(str)) audioTags.push('AAC');

    // Subtitle Languages
    const subLanguages = [];
    if (/\b(sub[._ -]?(ita|italian)|(ita|italian)[._ -]?sub(?![._ -]?(ita|eng|jap|fre|ger|spa|por)))\b/i.test(str)) subLanguages.push('Italian');
    if (/\b(sub[._ -]?(eng|english)|(eng|english)[._ -]?sub(?![._ -]?(ita|eng|jap|fre|ger|spa|por)))\b/i.test(str)) subLanguages.push('English');
    if (/\b(sub[._ -]?(jap|japanese|jpn)|(jap|japanese|jpn)[._ -]?sub(?![._ -]?(ita|eng|jap|fre|ger|spa|por)))\b/i.test(str)) subLanguages.push('Japanese');
    if (/\b(sub[._ -]?(fre|french|fra)|(fre|french|fra)[._ -]?sub(?![._ -]?(ita|eng|jap|fre|ger|spa|por)))\b/i.test(str)) subLanguages.push('French');
    if (/\b(sub[._ -]?(ger|german|deu)|(ger|german|deu)[._ -]?sub(?![._ -]?(ita|eng|jap|fre|ger|spa|por)))\b/i.test(str)) subLanguages.push('German');
    if (/\b(sub[._ -]?(spa|spanish|esp)|(spa|spanish|esp)[._ -]?sub(?![._ -]?(ita|eng|jap|fre|ger|spa|por)))\b/i.test(str)) subLanguages.push('Spanish');
    if (/\b(sub[._ -]?(por|portuguese|pt|pt-br)|(por|portuguese)[._ -]?sub(?![._ -]?(ita|eng|jap|fre|ger|spa|por)))\b/i.test(str)) subLanguages.push('Portuguese');
    if (/\b(msubs?|multi[._ -]?subs?)\b/i.test(str)) subLanguages.push('Multi');

    // Audio Languages (strip subtitle tags first)
    let audioStr = str;
    audioStr = audioStr.replace(/\bsub[._ -]?(ita|italian|eng|english|jap|japanese|jpn|fre|french|fra|ger|german|deu|spa|spanish|esp|por|portuguese|pt|multi)\b/gi, ' ');
    audioStr = audioStr.replace(/\b(ita|italian|eng|english|jap|japanese|jpn|fre|french|fra|ger|german|deu|spa|spanish|esp|por|portuguese|pt)[._ -]?sub\b/gi, ' ');
    audioStr = audioStr.replace(/\b(msubs?|multi[._ -]?subs?)\b/gi, ' ');

    const audioLanguages = [];
    if (/\b(ita|italian)\b/i.test(audioStr)) audioLanguages.push('Italian');
    if (/\b(eng|english)\b/i.test(audioStr)) audioLanguages.push('English');
    if (/\b(jap|japanese|jpn)\b/i.test(audioStr)) audioLanguages.push('Japanese');
    if (/\b(fre|french|fra)\b/i.test(audioStr)) audioLanguages.push('French');
    if (/\b(ger|german|deu)\b/i.test(audioStr)) audioLanguages.push('German');
    if (/\b(spa|spanish|esp)\b/i.test(audioStr)) audioLanguages.push('Spanish');
    if (/\b(por|portuguese|pt|pt-br)\b/i.test(audioStr)) audioLanguages.push('Portuguese');
    if (/\bmulti\b/i.test(audioStr)) audioLanguages.push('Multi');
    if (/\bdual\b/i.test(audioStr)) audioLanguages.push('Dual Audio');

    return {
        audioLanguages,
        subLanguages,
        resolution,
        quality,
        codec,
        visualTags,
        audioTags
    };
}

function enrichCustomTorrentTitle(originalTitle, specs = {}) {
    let title = (originalTitle || '').trim();
    if (!title) return 'Custom.Release-ICV';

    const {
        audioLanguages,
        subLanguages,
        resolution,
        quality,
        codec,
        visualTags,
        audioTags
    } = specs;

    let audioLangs = [];
    if (Array.isArray(audioLanguages)) audioLangs = audioLanguages;
    else if (typeof audioLanguages === 'string' && audioLanguages.trim()) {
        try { audioLangs = JSON.parse(audioLanguages); } catch (_) { audioLangs = audioLanguages.split(',').map(s => s.trim()).filter(Boolean); }
    }

    let subLangs = [];
    if (Array.isArray(subLanguages)) subLangs = subLanguages;
    else if (typeof subLanguages === 'string' && subLanguages.trim()) {
        try { subLangs = JSON.parse(subLanguages); } catch (_) { subLangs = subLanguages.split(',').map(s => s.trim()).filter(Boolean); }
    }

    let visual = [];
    if (Array.isArray(visualTags)) visual = visualTags;
    else if (typeof visualTags === 'string' && visualTags.trim()) {
        try { visual = JSON.parse(visualTags); } catch (_) { visual = visualTags.split(',').map(s => s.trim()).filter(Boolean); }
    }

    let audio = [];
    if (Array.isArray(audioTags)) audio = audioTags;
    else if (typeof audioTags === 'string' && audioTags.trim()) {
        try { audio = JSON.parse(audioTags); } catch (_) { audio = audioTags.split(',').map(s => s.trim()).filter(Boolean); }
    }

    const langTagMap = {
        'Italian': 'ITA', 'English': 'ENG', 'French': 'FRA', 'German': 'GER',
        'Spanish': 'SPA', 'Portuguese': 'POR', 'Russian': 'RUS', 'Japanese': 'JAP',
        'Korean': 'KOR', 'Chinese': 'CHI', 'Multi': 'MULTI', 'Dual Audio': 'DUAL'
    };

    const extMatch = title.match(/\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i);
    let ext = '';
    if (extMatch) {
        ext = extMatch[0];
        title = title.substring(0, title.length - ext.length);
    }

    // 1. Clean unselected subtitles from title if user explicitly selected subtitle languages
    if (subLangs.length > 0) {
        const selectedSubTags = subLangs.map(l => (langTagMap[l] || l).toUpperCase());
        Object.entries(langTagMap).forEach(([lName, lTag]) => {
            if (!selectedSubTags.includes(lTag.toUpperCase())) {
                title = title.replace(new RegExp(`[._ -]?Sub[._ -]?(${lTag}|${lName})(?=[._ -]|$)`, 'gi'), '');
                title = title.replace(new RegExp(`[._ -]?(${lTag}|${lName})[._ -]?Sub(?=[._ -]|$)`, 'gi'), '');
            }
        });
        if (!subLangs.includes('Multi') && !subLangs.includes('Multi Subs')) {
            title = title.replace(/[._ -]?(msubs?|multi[._ -]?subs?)(?=[._ -]|$)/gi, '');
        }
    }

    // 2. Clean unselected audio languages from title if user explicitly selected audio languages
    if (audioLangs.length > 0) {
        const selectedAudioTags = audioLangs.map(l => (langTagMap[l] || l).toUpperCase());
        Object.entries(langTagMap).forEach(([lName, lTag]) => {
            if (!selectedAudioTags.includes(lTag.toUpperCase())) {
                title = title.replace(new RegExp(`[._ -](${lTag}|${lName})(?=[._ -]|$)`, 'gi'), '');
            }
        });
    }

    // Clean multiple dots or trailing/leading dots
    title = title.replace(/\.{2,}/g, '.').replace(/^\.|\.$/, '');

    const tagsToAdd = [];

    if (resolution && resolution !== 'auto' && !new RegExp(`\\b${resolution}\\b`, 'i').test(title)) {
        tagsToAdd.push(resolution);
    }
    if (quality && quality !== 'auto' && !new RegExp(`\\b${quality.replace('-', '[- ]?')}\\b`, 'i').test(title)) {
        tagsToAdd.push(quality);
    }
    if (codec && codec !== 'auto' && !new RegExp(`\\b${codec}\\b`, 'i').test(title)) {
        tagsToAdd.push(codec);
    }
    visual.forEach(v => {
        if (v && v !== 'auto' && v !== 'SDR' && !new RegExp(`\\b${v}\\b`, 'i').test(title)) {
            tagsToAdd.push(v);
        }
    });
    audio.forEach(a => {
        if (a && a !== 'auto' && !new RegExp(`\\b${a.replace('.', '\\.')}\\b`, 'i').test(title)) {
            tagsToAdd.push(a);
        }
    });
    audioLangs.forEach(l => {
        const tag = langTagMap[l] || l.toUpperCase();
        if (tag && !new RegExp(`\\b${tag}\\b`, 'i').test(title)) {
            tagsToAdd.push(tag);
        }
    });
    subLangs.forEach(l => {
        if (l === 'None') return;
        const subTag = (l === 'Multi' || l === 'Multi Subs') ? 'MSubs' : `Sub.${langTagMap[l] || l.toUpperCase()}`;
        if (subTag && !new RegExp(`\\b${subTag.replace('.', '\\.')}\\b`, 'i').test(title)) {
            tagsToAdd.push(subTag);
        }
    });

    if (tagsToAdd.length > 0) {
        title = `${title}.${tagsToAdd.join('.')}`;
    }
    return title + ext;
}

// GET /scrape/resolve-title - Fast title resolver for raw magnet/hash without dn=
router.get('/resolve-title', async (req, res) => {
    const hash = normalizeInfoHash(req.query.hash);
    if (!hash) return res.json({ found: false });
    try {
        const cached = await fetchTorrentFromCaches(hash);
        if (cached && cached.filename) {
            const detectedSpecs = detectTorrentSpecs(cached.filename);
            return res.json({ found: true, title: cached.filename, detectedSpecs });
        }
        return res.json({ found: false });
    } catch (e) {
        return res.json({ found: false, error: e.message });
    }
});

// GET /meta - Fetch metadata for preview (IMDb/TMDB)
router.get('/meta', async (req, res) => {
    const { id, type } = req.query;
    if (!id || !type) return res.status(400).json({ error: 'Missing id or type' });

    let detectedType = type;
    let warning = null;

    // Helper to fetch metadata
    const fetchMeta = async (tid, tType) => {
        try {
            // 1. Convert TMDB -> IMDb if needed
            let currentImdbId = tid;
            let resolvedTmdbId = null;

            if (!tid.startsWith('tt')) {
                let tmdbId = tid;
                if (tid.startsWith('tmdb:')) tmdbId = tid.split(':')[1];

                // Track resolved TMDB ID for response
                resolvedTmdbId = tmdbId;

                if (idConverter) {
                    const converted = await idConverter.tmdbToImdb(tmdbId, tType);
                    if (converted) {
                        currentImdbId = converted;
                    } else {
                        return null;
                    }
                } else {
                    return null;
                }
            } else if (tid.match(/^\d+$/) || tid.startsWith('tmdb:')) {
                // If it looks like numeric string but wasn't caught above, it's TMDB
                resolvedTmdbId = tid.replace('tmdb:', '');
            }

            // 2. Fetch from Cinemeta
            const metaUrl = `https://v3-cinemeta.strem.io/meta/${tType}/${currentImdbId}.json`;
            console.log(`🔍 [MANUAL-META] Fetching (${tType}): ${metaUrl}`);
            const response = await axios.get(metaUrl, { timeout: 4000 });

            if (response.data && response.data.meta) {
                return {
                    meta: response.data.meta,
                    imdbId: currentImdbId,
                    tmdbId: resolvedTmdbId,
                    type: tType
                };
            }
            return null;
        } catch (e) {
            return null;
        }
    };

    // 🔥 PARALLEL FETCH STRATEGY
    // We fetch BOTH "movie" and "series" to detect collisions (e.g. Breaking Bad ID returning "Mirror" as movie)
    // BUT ONLY if ID is IMDb (tt...). TMDB IDs are unique per type (Movie 123 != TV 123).
    const cleanId = id.trim();
    const isTmdb = cleanId.startsWith('tmdb:') || /^\d+$/.test(cleanId);

    console.log(`🔎 [MANUAL-META] ID: "${cleanId}", Type: "${type}", isTmdb: ${isTmdb}`);

    const otherType = (isTmdb) ? null : ((type === 'movie') ? 'series' : 'movie');

    if (isTmdb) console.log("🔒 [MANUAL-META] TMDB ID detected: Disabling parallel check for collision.");

    // Launch requests (skip otherType if null)
    const [resultUserType, resultOtherType] = await Promise.all([
        fetchMeta(cleanId, type),
        otherType ? fetchMeta(cleanId, otherType) : Promise.resolve(null)
    ]);

    let finalResult = null;

    // 🧠 LOGIC: Decide which result is "correct"
    if (resultUserType && !resultOtherType) {
        // Only user type found - easy
        finalResult = resultUserType;
    } else if (!resultUserType && resultOtherType) {
        // Only other type found - auto-correct
        finalResult = resultOtherType;
        detectedType = otherType;
        warning = `Tipo corretto automaticamente in: ${otherType === 'movie' ? 'Film' : 'Serie'}`;
    } else if (resultUserType && resultOtherType) {
        // ⚔️ COLLISION DETECTED: Both return data!
        // This happens when an ID exists as both (or mapped incorrectly in Cinemeta)

        console.log(`⚠️ [MANUAL-META] Collision! Found valid data for BOTH '${type}' and '${otherType}'. Applying heuristics...`);

        // Check for "Series Indicators" (presence of videos (episodes) array)
        const userHasEpisodes = resultUserType.meta.videos && resultUserType.meta.videos.length > 0;
        const otherHasEpisodes = resultOtherType.meta.videos && resultOtherType.meta.videos.length > 0;

        if (type === 'movie') {
            // User asked for Movie.
            // If "other" (Series) has episodes, it is definitely a Series.
            // (Movies usually have empty videos or trailers, not full episode lists in Cinemeta)
            if (otherHasEpisodes && !userHasEpisodes) {
                console.log(`💡 [MANUAL-META] Detected episodes in Series result. Correcting to SERIES.`);
                finalResult = resultOtherType;
                detectedType = 'series';
                warning = `Tipo corretto automaticamente in: Serie (Rilevati episodi)`;
            } else {
                // Otherwise trust user input (assuming it's a valid movie)
                finalResult = resultUserType;
            }
        } else {
            // User asked for Series.
            // If user result has NO episodes, but "other" (Movie) exists... doubtful.
            // But if user result HAS episodes, keep it.
            if (userHasEpisodes) {
                finalResult = resultUserType;
            } else if (!userHasEpisodes && !otherHasEpisodes) {
                // Neither has episodes. Prefer Movie as default for ambiguity? or Trust user?
                // Usually Series WITHOUT episodes is weird/broken.
                // Let's stick to User Input if ambiguous, or check release year/popularity?
                // For now: Keep User Input.
                finalResult = resultUserType;
            } else if (!userHasEpisodes && otherHasEpisodes) {
                // Impossible case (Series has no eps, Movie has eps? Unlikely).
                finalResult = resultUserType;
            } else {
                finalResult = resultUserType;
            }
        }
    }

    if (finalResult && finalResult.meta) {
        const m = finalResult.meta;
        return res.json({
            found: true,
            title: m.name,
            year: m.year,
            poster: m.poster,
            background: m.background,
            description: m.description,
            imdb_id: finalResult.imdbId,
            tmdb_id: finalResult.tmdbId,
            original_id: id,
            detected_type: detectedType,
            warning
        });
    } else {
        return res.json({ found: false, error: 'Metadata not found on Cinemeta (checked both types)', warning });
    }
});

// GET /scrape - Serve UI
router.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="it">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Importazione Manuale | ICV Scrape</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --neon-primary: #a855f7;
            --neon-secondary: #06b6d4;
            --bg-dark: #050507;
            --card-bg: rgba(15, 23, 42, 0.7);
            --text-glow: rgba(168, 85, 247, 0.5);
            --border-low: rgba(255, 255, 255, 0.1);
        }

        * { box-sizing: border-box; transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1); }

        body {
            font-family: 'Inter', sans-serif;
            margin: 0;
            padding: 0;
            background-color: var(--bg-dark);
            color: #f8fafc;
            overflow-x: hidden;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        #bg-vanta {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: -1;
            background: radial-gradient(circle at 50% 50%, #120a2b 0%, #050507 100%);
        }

        .container {
            width: 100%;
            max-width: 960px;
            margin: 20px;
            padding: 50px;
            background: var(--card-bg);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid var(--border-low);
            border-radius: 32px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8),
                        inset 0 0 20px rgba(168, 85, 247, 0.05);
            position: relative;
            z-index: 1;
        }

        .header-section { text-align: center; margin-bottom: 40px; }

        h1 {
            font-family: 'Outfit', sans-serif;
            margin: 0;
            background: linear-gradient(135deg, white 30%, var(--neon-secondary) 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            font-weight: 600;
            letter-spacing: -1px;
            font-size: 2.8rem;
            filter: drop-shadow(0 0 10px rgba(6, 182, 212, 0.3));
        }

        .subtitle {
            color: #94a3b8;
            font-size: 0.9rem;
            margin-top: 8px;
            letter-spacing: 2px;
            text-transform: uppercase;
        }

        .form-group { margin-bottom: 28px; }

        label {
            display: block;
            margin-bottom: 10px;
            font-weight: 600;
            font-size: 0.85rem;
            color: #cbd5e1;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        input, select {
            width: 100%;
            padding: 16px 20px;
            border: 1px solid var(--border-low);
            border-radius: 16px;
            background: rgba(0, 0, 0, 0.3);
            font-size: 1rem;
            font-family: inherit;
            color: white;
            box-shadow: inset 0 2px 4px rgba(0,0,0,0.2);
        }

        input:focus, select:focus {
            outline: none;
            border-color: var(--neon-secondary);
            background: rgba(0, 0, 0, 0.5);
            box-shadow: 0 0 20px rgba(6, 182, 212, 0.15),
                        inset 0 0 10px rgba(6, 182, 212, 0.05);
        }

        .or-divider {
            text-align: center;
            margin: 30px 0;
            color: #475569;
            font-size: 0.8rem;
            font-weight: 800;
            position: relative;
        }
        .or-divider::before, .or-divider::after {
            content: "";
            position: absolute;
            top: 50%;
            width: 42%;
            height: 1px;
            background: var(--border-low);
        }
        .or-divider::before { left: 0; }
        .or-divider::after { right: 0; }

        .btn-glow {
            width: 100%;
            padding: 18px;
            background: linear-gradient(135deg, var(--neon-primary) 0%, #7e22ce 100%);
            color: white;
            border: none;
            border-radius: 18px;
            cursor: pointer;
            font-size: 1.2rem;
            font-weight: 600;
            font-family: 'Outfit', sans-serif;
            text-transform: uppercase;
            letter-spacing: 1px;
            box-shadow: 0 0 20px rgba(168, 85, 247, 0.4);
            position: relative;
            overflow: hidden;
        }

        .btn-glow:hover {
            transform: scale(1.02);
            box-shadow: 0 0 35px rgba(168, 85, 247, 0.6);
            filter: brightness(1.2);
        }

        .btn-glow:active { transform: scale(0.98); }

        .btn-glow:disabled {
            background: #334155;
            box-shadow: none;
            cursor: not-allowed;
            animation: none !important;
            opacity: 0.5;
        }

        /* ENERGY PULSE ANIMATION */
        @keyframes energy-pulse {
            0% { box-shadow: 0 0 15px rgba(168, 85, 247, 0.4); }
            50% { box-shadow: 0 0 30px rgba(168, 85, 247, 0.7); }
            100% { box-shadow: 0 0 15px rgba(168, 85, 247, 0.4); }
        }

        .pulse-active:not(:disabled) {
            animation: energy-pulse 2s infinite ease-in-out;
        }

        #result {
            margin-top: 30px;
            padding: 20px;
            border-radius: 20px;
            display: none;
            white-space: pre-wrap;
            word-break: break-all;
            max-height: 250px;
            overflow-y: auto;
            font-family: 'Google Sans Code', monospace;
            font-size: 0.85rem;
            border: 1px solid transparent;
        }

        .success {
            background: rgba(20, 83, 45, 0.2);
            color: #4ade80;
            border-color: rgba(74, 222, 128, 0.2) !important;
            box-shadow: 0 0 20px rgba(74, 222, 128, 0.1);
        }
        .error {
            background: rgba(127, 29, 29, 0.2);
            color: #f87171;
            border-color: rgba(248, 113, 113, 0.2) !important;
        }

        #debug {
            margin-top: 20px;
            font-size: 0.8rem;
            color: #64748b;
            text-align: center;
        }

        .grid-half { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }

        /* Custom Scrollbar for Neon */
        #result::-webkit-scrollbar { width: 4px; }
        #result::-webkit-scrollbar-thumb { background: var(--neon-secondary); border-radius: 10px; }

        /* PREVIEW CARD */
        .preview-card {
            display: flex;
            flex-direction: column; /* Stack vertically for bigger image */
            gap: 20px;
            background: rgba(0, 0, 0, 0.4);
            padding: 20px;
            border-radius: 16px;
            margin-bottom: 28px;
            border: 1px solid var(--neon-primary);
            box-shadow: 0 0 20px rgba(168, 85, 247, 0.15);
            align-items: center; /* Center everything */
            text-align: center;
            animation: fadeIn 0.5s ease;
        }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }

        .preview-poster {
            width: 160px; /* 200% Bigger */
            height: 240px;
            border-radius: 12px;
            object-fit: cover;
            box-shadow: 0 5px 15px rgba(0,0,0,0.5);
            border: 1px solid rgba(255,255,255,0.1);
        }
        .preview-info { flex: 1; width: 100%; }
        .preview-info h3 { margin: 0 0 8px 0; font-size: 1.4rem; color: white; font-family: 'Outfit', sans-serif; }
        .preview-info p { margin: 0; color: #cbd5e1; font-size: 0.95rem; line-height: 1.5; }
        .preview-tag {
            display: inline-block;
            background: var(--neon-secondary);
            color: #000;
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 0.85rem;
            font-weight: bold;
            margin-top: 10px;
        }

        .check-btn {
            position: absolute;
            right: 8px;
            top: 50%; /* Adjusted via JS or layout */
            transform: translateY(-50%); /* If possible */
            background: rgba(168, 85, 247, 0.2);
            color: #a855f7;
            border: 1px solid rgba(168, 85, 247, 0.5);
            padding: 8px 12px;
            border-radius: 8px;
            cursor: pointer;
            font-size: 0.8rem;
            font-weight: 600;
            transition: all 0.2s;
        }
        .check-btn:hover { background: rgba(168, 85, 247, 0.4); }

        .mapping-section {
            margin-top: 30px;
            padding: 20px;
            border-radius: 18px;
            border: 1px solid rgba(6, 182, 212, 0.25);
            background: rgba(2, 6, 23, 0.6);
            box-shadow: 0 0 25px rgba(6, 182, 212, 0.08);
        }

        .mapping-title {
            font-family: 'Outfit', sans-serif;
            font-size: 1.1rem;
            letter-spacing: 0.5px;
            margin-bottom: 14px;
            color: #e2e8f0;
        }

        .mapping-controls {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            align-items: center;
            margin-bottom: 16px;
        }

        .mapping-controls select {
            flex: 1;
            min-width: 140px;
        }

        .mapping-status {
            font-size: 0.85rem;
            color: #94a3b8;
        }

        .mapping-table {
            width: 100%;
            display: grid;
            gap: 8px;
            margin-bottom: 16px;
        }

        .mapping-row {
            display: grid;
            grid-template-columns: 70px 1fr 1.2fr;
            gap: 10px;
            align-items: center;
            padding: 10px 12px;
            border-radius: 12px;
            background: rgba(15, 23, 42, 0.55);
            border: 1px solid rgba(255, 255, 255, 0.06);
        }

        .mapping-row strong {
            color: #f8fafc;
            font-size: 0.9rem;
        }

        .mapping-row span {
            color: #cbd5e1;
            font-size: 0.85rem;
        }

        .mapping-select {
            width: 100%;
            padding: 10px 12px;
            border-radius: 10px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            background: rgba(2, 6, 23, 0.6);
            color: #f8fafc;
            font-size: 0.85rem;
        }

        .btn-small {
            width: auto;
            padding: 12px 16px;
            font-size: 0.85rem;
            border-radius: 12px;
        }

        /* 📦 Movie Pack Mapping Styling */
        .pack-movie-card {
            background: rgba(15, 23, 42, 0.65);
            border: 1px solid rgba(6, 182, 212, 0.25);
            border-radius: 14px;
            padding: 14px 16px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .pack-movie-card:hover {
            border-color: rgba(6, 182, 212, 0.5);
            box-shadow: 0 4px 20px rgba(6, 182, 212, 0.08);
        }
        .pack-movie-header {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 10px;
        }
        .pack-movie-name {
            font-size: 0.88rem;
            color: #f1f5f9;
            font-weight: 500;
            word-break: break-all;
            line-height: 1.4;
        }
        .pack-movie-size {
            font-size: 0.78rem;
            color: #38bdf8;
            background: rgba(56, 189, 248, 0.1);
            border: 1px solid rgba(56, 189, 248, 0.25);
            padding: 3px 8px;
            border-radius: 6px;
            white-space: nowrap;
        }
        .pack-movie-input-row {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        .pack-movie-input {
            flex: 1;
            padding: 9px 12px;
            border-radius: 10px;
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: rgba(2, 6, 23, 0.7);
            color: #f8fafc;
            font-size: 0.85rem;
            outline: none;
            transition: border-color 0.2s;
        }
        .pack-movie-input:focus {
            border-color: var(--neon-secondary);
        }
        .pack-movie-preview {
            display: none;
            align-items: center;
            gap: 12px;
            padding: 8px 12px;
            background: rgba(34, 197, 94, 0.08);
            border: 1px solid rgba(34, 197, 94, 0.25);
            border-radius: 10px;
        }
        .pack-movie-poster {
            width: 36px;
            height: 52px;
            object-fit: cover;
            border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .pack-movie-info {
            display: flex;
            flex-direction: column;
            gap: 2px;
            flex: 1;
        }
        .pack-movie-title {
            font-size: 0.85rem;
            color: #f8fafc;
            font-weight: 600;
        }
        .pack-movie-meta {
            font-size: 0.75rem;
            color: #86efac;
        }

        /* 🎛️ Media Specs & Tracks Styling */
        .specs-box {
            margin-bottom: 24px;
            padding: 20px 24px;
            border-radius: 20px;
            background: rgba(15, 23, 42, 0.6);
            border: 1px solid rgba(168, 85, 247, 0.25);
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
        }
        .specs-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            cursor: pointer;
            user-select: none;
        }
        .specs-header:hover #specsChevron {
            transform: scale(1.15);
        }
        .chip-group {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 6px;
        }
        .chip-btn {
            padding: 7px 13px;
            border-radius: 20px;
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: rgba(2, 6, 23, 0.65);
            color: #94a3b8;
            cursor: pointer;
            font-size: 0.85rem;
            font-weight: 500;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            display: inline-flex;
            align-items: center;
            gap: 5px;
            user-select: none;
        }
        .chip-btn:hover {
            border-color: var(--neon-secondary);
            color: #f8fafc;
            transform: translateY(-1px);
        }
        .chip-btn.active {
            background: linear-gradient(135deg, rgba(168, 85, 247, 0.45) 0%, rgba(6, 182, 212, 0.45) 100%);
            border-color: var(--neon-secondary);
            color: #fff;
            font-weight: 600;
            box-shadow: 0 0 14px rgba(6, 182, 212, 0.35);
        }
        .detected-badge {
            font-size: 0.8rem;
            padding: 6px 12px;
            border-radius: 12px;
            background: rgba(6, 182, 212, 0.12);
            border: 1px solid rgba(6, 182, 212, 0.35);
            color: #38bdf8;
            margin-top: 10px;
            display: none;
            line-height: 1.4;
        }

        /* Responsive: schermi piccoli */
        @media (max-width: 640px) {
            .container {
                margin: 10px;
                padding: 24px;
                border-radius: 20px;
            }
            h1 { font-size: 2rem; }
        }

        @media (min-width: 641px) and (max-width: 1024px) {
            .container {
                max-width: 90%;
                padding: 36px;
            }
        }
    </style>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r134/three.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/vanta@0.5.24/dist/vanta.waves.min.js"></script>
</head>
<body>
    <div id="bg-vanta"></div>

    <div class="container">
        <div class="header-section">
            <h1>ICV Scrape</h1>
            <div class="subtitle">Importazione Torrent</div>
        </div>

        <div class="form-group">
            <label>Metodo di Importazione</label>
            <select id="modeSelector">
                <option value="debrid">Debrid Search (VELOCE)</option>
                <option value="nodebrid">No Debrid (LENTO)</option>
            </select>
        </div>

        <div class="form-group" id="magnetGroup">
            <label>Magnet Link o Info Hash</label>
            <input type="text" id="magnetLink" placeholder="magnet:?xt=urn:btih:...">
        </div>

        <div class="or-divider">OPPURE</div>

        <div class="form-group" id="fileGroup">
            <label>Carica File .torrent</label>
            <input type="file" id="torrentFile" accept=".torrent">
        </div>

        <div class="grid-half">
            <div class="form-group" style="position: relative;">
                <!-- TABS: ID vs Search -->
                <div style="display:flex; gap:15px; margin-bottom:12px; font-size:0.85rem; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 5px;">
                    <span id="tabId" style="cursor:pointer; color:var(--neon-secondary); font-weight:bold; border-bottom:2px solid var(--neon-secondary); padding-bottom: 5px;">🆔 ID Diretto</span>
                    <span id="tabSearch" style="cursor:pointer; color:#94a3b8; padding-bottom: 5px; transition: color 0.3s;">🔍 Cerca Titolo</span>
                </div>

                <label id="labelId">ID IMDb o TMDB</label>

                <!-- ID INPUT MODE -->
                <div id="idInputContainer" style="position: relative; display: flex; align-items: center;">
                    <input type="text" id="imdbId" placeholder="Es: tt1234567 o 550" style="padding-right: 90px;">
                    <button id="checkBtn" type="button" class="check-btn" style="top: 50%; right: 5px;">🔍 Verifica</button>
                </div>

                <!-- SEARCH INPUT MODE -->
                <div id="searchInputContainer" style="display:none;">
                    <div style="display: flex; gap: 10px;">
                        <input type="text" id="searchTerm" placeholder="Nome Film o Serie..." style="flex:1;">
                        <button id="searchBtn" type="button" class="btn-glow" style="width: auto; padding: 12px 20px; font-size: 0.9rem; border-radius: 12px;">Cerca</button>
                    </div>
                    <!-- Results Dropdown -->
                    <div id="searchResults" style="
                        margin-top: 10px;
                        max-height: 250px;
                        overflow-y: auto;
                        background: rgba(15, 23, 42, 0.95);
                        border: 1px solid var(--border-low);
                        border-radius: 12px;
                        display:none;
                        position: absolute;
                        width: 100%;
                        z-index: 100;
                        box-shadow: 0 10px 25px rgba(0,0,0,0.5);
                    "></div>
                </div>
            </div>
            <div class="form-group">
                <label>Tipo Contenuto</label>
                <select id="type">
                    <option value="series">Serie TV / Stagione</option>
                    <option value="movie">Film</option>
                    <option value="pack" style="color: #4EC9B0; font-weight: bold;">📦 Pack Multi-Film (No ID)</option>
                </select>
                <!-- Checkbox replaced by Dropdown Option -->
            </div>
        </div>

        <div id="metaPreview" style="display: none;"></div>

        <div id="debridKeys">
            <div class="grid-half">
                <div class="form-group">
                    <label>Real-Debrid <a href="https://real-debrid.com/apitoken" target="_blank" style="text-decoration:none; cursor:pointer;" title="Recupera API Key">API 🔑</a></label>
                    <input type="password" id="rdKey" placeholder="Opzionale se impostata">
                </div>
                <div class="form-group">
                    <label>Chiave Torbox <a href="https://torbox.app/settings" target="_blank" style="text-decoration:none; cursor:pointer;" title="Recupera API Key">API 🔑</a></label>
                    <input type="password" id="tbKey" placeholder="Opzionale se impostata">
                </div>
            </div>
        </div>

        <div class="form-group">
            <label>Seeders (Opzionale)</label>
            <input type="number" id="seeders" placeholder="Lascia vuoto per auto-check">
        </div>

        <!-- 🎛️ MEDIA SPECS & TRACKS SECTION -->
        <div class="specs-box" id="mediaSpecsSection">
            <div class="specs-header" onclick="toggleSpecsAccordion()">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span style="font-size: 1.3rem;">🎛️</span>
                    <div>
                        <div style="font-weight: 600; color: #e2e8f0; font-size: 0.95rem; font-family: 'Outfit', sans-serif;">Specifiche Media & Tracce</div>
                        <div style="font-size: 0.75rem; color: #94a3b8;">Personalizza lingue audio, sottotitoli e qualità video (Auto-detect)</div>
                    </div>
                </div>
                <span id="specsChevron" style="color: var(--neon-secondary); font-size: 1rem; transition: transform 0.3s;">▼</span>
            </div>

            <div id="detectedSpecsBadge" class="detected-badge">
                <span id="detectedSpecsText"></span>
            </div>

            <div id="specsContent">
                <!-- AUDIO LANGUAGES CHIPS -->
                <div style="margin-top: 14px;">
                    <label style="font-size: 0.8rem; margin-bottom: 6px;">Lingue Audio</label>
                    <div class="chip-group" id="audioLangChips">
                        <span class="chip-btn" data-val="Italian" onclick="toggleChip(this, 'audio')">🇮🇹 Italiano</span>
                        <span class="chip-btn" data-val="English" onclick="toggleChip(this, 'audio')">🇬🇧 English</span>
                        <span class="chip-btn" data-val="Japanese" onclick="toggleChip(this, 'audio')">🇯🇵 Japanese</span>
                        <span class="chip-btn" data-val="French" onclick="toggleChip(this, 'audio')">🇫🇷 Français</span>
                        <span class="chip-btn" data-val="German" onclick="toggleChip(this, 'audio')">🇩🇪 Deutsch</span>
                        <span class="chip-btn" data-val="Spanish" onclick="toggleChip(this, 'audio')">🇪🇸 Español</span>
                        <span class="chip-btn" data-val="Portuguese" onclick="toggleChip(this, 'audio')">🇵🇹 Português</span>
                        <span class="chip-btn" data-val="Multi" onclick="toggleChip(this, 'audio')">🌎 Multi Audio</span>
                        <span class="chip-btn" data-val="Dual Audio" onclick="toggleChip(this, 'audio')">🎙️ Dual Audio</span>
                    </div>
                </div>

                <!-- SUBTITLE LANGUAGES CHIPS -->
                <div style="margin-top: 14px;">
                    <label style="font-size: 0.8rem; margin-bottom: 6px;">Sottotitoli</label>
                    <div class="chip-group" id="subLangChips">
                        <span class="chip-btn" data-val="Italian" onclick="toggleChip(this, 'sub')">🇮🇹 Sub ITA</span>
                        <span class="chip-btn" data-val="English" onclick="toggleChip(this, 'sub')">🇬🇧 Sub ENG</span>
                        <span class="chip-btn" data-val="Japanese" onclick="toggleChip(this, 'sub')">🇯🇵 Sub JAP</span>
                        <span class="chip-btn" data-val="French" onclick="toggleChip(this, 'sub')">🇫🇷 Sub FRA</span>
                        <span class="chip-btn" data-val="Spanish" onclick="toggleChip(this, 'sub')">🇪🇸 Sub SPA</span>
                        <span class="chip-btn" data-val="German" onclick="toggleChip(this, 'sub')">🇩🇪 Sub DEU</span>
                        <span class="chip-btn" data-val="Portuguese" onclick="toggleChip(this, 'sub')">🇵🇹 Sub POR</span>
                        <span class="chip-btn" data-val="Multi" onclick="toggleChip(this, 'sub')">🌎 Multi Subs</span>
                        <span class="chip-btn" data-val="None" onclick="toggleChip(this, 'sub')">🚫 Nessuno</span>
                    </div>
                </div>

                <!-- QUALITY / RESOLUTION / CODEC GRID -->
                <div class="grid-half" style="margin-top: 14px; gap: 14px;">
                    <div>
                        <label style="font-size: 0.8rem; margin-bottom: 6px;">Risoluzione</label>
                        <select id="specResolution" style="padding: 10px 14px; font-size: 0.9rem; border-radius: 12px;">
                            <option value="auto">Auto (dal nome)</option>
                            <option value="2160p">4K UHD (2160p)</option>
                            <option value="1080p">FHD (1080p)</option>
                            <option value="720p">HD (720p)</option>
                            <option value="576p">576p</option>
                            <option value="480p">SD (480p)</option>
                            <option value="DVDRip">DVDRip</option>
                        </select>
                    </div>
                    <div>
                        <label style="font-size: 0.8rem; margin-bottom: 6px;">Sorgente Video</label>
                        <select id="specQuality" style="padding: 10px 14px; font-size: 0.9rem; border-radius: 12px;">
                            <option value="auto">Auto (dal nome)</option>
                            <option value="WEB-DL">WEB-DL</option>
                            <option value="WEBRip">WEBRip</option>
                            <option value="BluRay">BluRay</option>
                            <option value="Remux">Remux</option>
                            <option value="HDTV">HDTV</option>
                            <option value="DVDRip">DVDRip</option>
                            <option value="CAM">CAM / TeleSync</option>
                        </select>
                    </div>
                </div>

                <div class="grid-half" style="margin-top: 14px; gap: 14px;">
                    <div>
                        <label style="font-size: 0.8rem; margin-bottom: 6px;">Codec Video</label>
                        <select id="specCodec" style="padding: 10px 14px; font-size: 0.9rem; border-radius: 12px;">
                            <option value="auto">Auto (dal nome)</option>
                            <option value="HEVC">HEVC (x265 / H.265)</option>
                            <option value="AVC">AVC (x264 / H.264)</option>
                            <option value="AV1">AV1</option>
                            <option value="XviD">XviD / DivX</option>
                        </select>
                    </div>
                    <div>
                        <label style="font-size: 0.8rem; margin-bottom: 6px;">Gamma Dinamica (HDR/DV)</label>
                        <select id="specHdr" style="padding: 10px 14px; font-size: 0.9rem; border-radius: 12px;">
                            <option value="auto">Auto (dal nome)</option>
                            <option value="SDR">SDR</option>
                            <option value="HDR">HDR</option>
                            <option value="HDR10">HDR10</option>
                            <option value="HDR10+">HDR10+</option>
                            <option value="DV">Dolby Vision (DV)</option>
                            <option value="DV-HDR">DV + HDR</option>
                        </select>
                    </div>
                </div>

                <div style="margin-top: 14px;">
                    <label style="font-size: 0.8rem; margin-bottom: 6px;">Canali / Formato Audio</label>
                    <select id="specAudio" style="padding: 10px 14px; font-size: 0.9rem; border-radius: 12px;">
                        <option value="auto">Auto (dal nome)</option>
                        <option value="5.1">5.1 Surround</option>
                        <option value="7.1">7.1 Surround</option>
                        <option value="2.0">2.0 Stereo</option>
                        <option value="Atmos">Dolby Atmos</option>
                        <option value="DTS-HD">DTS-HD MA</option>
                        <option value="AC3">Dolby Digital (AC3 / DD+)</option>
                        <option value="AAC">AAC</option>
                    </select>
                </div>
            </div>
        </div>

        <div style="display: flex; align-items: center; gap: 12px;">
            <button id="submitBtn" class="btn-glow pulse-active" disabled style="opacity: 0.5; cursor: not-allowed;">Avvia Importazione</button>
            <label style="display: flex; align-items: center; gap: 8px; margin: 0; font-size: 0.75rem; letter-spacing: 0.5px; text-transform: uppercase; color: #cbd5e1;">
                <input type="checkbox" id="manualMapToggle" style="width: 18px; height: 18px;"> Mappatura Manuale Serie
            </label>
        </div>
        <div id="result"></div>
        <div id="mappingSection" class="mapping-section" style="display: none;">
            <div class="mapping-title">Mappatura Episodi (TMDB)</div>
            <div class="mapping-controls">
                <button id="autoMatchBtn" type="button" class="btn-glow btn-small">AutoMatch</button>
                <select id="seasonSelect"></select>
                <select id="episodeSelect"></select>
                <div id="mappingStatus" class="mapping-status">Seleziona una stagione per iniziare.</div>
            </div>
            <div id="episodesTable" class="mapping-table"></div>
            <button id="saveMappingBtn" class="btn-glow" disabled>Salva Mappatura</button>
        </div>

        <!-- 📦 MOVIE PACK MAPPING SECTION -->
        <div id="moviePackMappingSection" class="mapping-section" style="display: none; border-color: rgba(6, 182, 212, 0.4); margin-top: 20px;">
            <div class="mapping-title" style="color: var(--neon-secondary); display: flex; align-items: center; justify-content: space-between;">
                <span>📦 Mappatura Film nel Pack</span>
                <span id="packFilesCountBadge" style="font-size: 0.8rem; font-weight: normal; color: #94a3b8;">0 file</span>
            </div>
            <div id="packFilesStatus" class="mapping-status" style="margin-bottom: 14px;">Inserisci l'ID IMDb (o cerca per titolo) per ciascun film del pack:</div>
            <div id="packFilesList" style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 18px;"></div>
            <div style="display: flex; gap: 10px;">
                <button id="savePackMappingBtn" type="button" class="btn-glow pulse-active" style="flex: 1;">💾 Salva & Importa Pack Film</button>
            </div>
        </div>

        <div id="debug">In attesa...</div>
    </div>

    <!-- 💜 CONTRIBUTOR POPUP -->
    <div id="contributorOverlay" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); backdrop-filter:blur(6px); z-index:9999; align-items:center; justify-content:center;">
        <div style="background:linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%); border:1px solid rgba(168,85,247,0.3); border-radius:16px; padding:28px 32px; max-width:380px; width:90%; box-shadow:0 0 40px rgba(168,85,247,0.15);">
            <div style="text-align:center; margin-bottom:18px;">
                <span style="font-size:1.4rem;">💜</span>
                <span style="font-family:'Outfit',sans-serif; font-size:1.1rem; font-weight:600; color:#e2e8f0; margin-left:8px;">Nome Contributore</span>
            </div>
            <input type="text" id="contributorInput" placeholder="Lascia vuoto per anonimo" style="width:100%; padding:10px 14px; background:rgba(30,27,75,0.6); border:1px solid rgba(168,85,247,0.25); border-radius:10px; color:#e2e8f0; font-size:0.95rem; font-family:'Inter',sans-serif; outline:none; box-sizing:border-box; transition:border 0.2s;" onfocus="this.style.borderColor='rgba(168,85,247,0.6)'" onblur="this.style.borderColor='rgba(168,85,247,0.25)'">
            <div style="display:flex; gap:10px; margin-top:16px;">
                <button id="contributorCancel" style="flex:1; padding:10px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); border-radius:10px; color:#94a3b8; font-size:0.9rem; cursor:pointer; font-family:'Inter',sans-serif;">Annulla</button>
                <button id="contributorConfirm" style="flex:1; padding:10px; background:linear-gradient(135deg,#22c55e,#16a34a); border:none; border-radius:10px; color:#fff; font-size:0.9rem; font-weight:600; cursor:pointer; font-family:'Inter',sans-serif;">INVIA</button>
            </div>
        </div>
    </div>

    <script>
        // --- VANTA WAVES BACKGROUND (darker + lighter than neural canvas) ---
        (function initVantaBackground() {
            function run() {
                if (typeof VANTA === 'undefined' || !VANTA.WAVES) {
                    return setTimeout(run, 100);
                }

                VANTA.WAVES({
                    el: '#bg-vanta',
                    mouseControls: true,
                    touchControls: true,
                    gyroControls: false,
                    minHeight: 200.00,
                    minWidth: 200.00,
                    scale: 1.00,
                    scaleMobile: 1.00,
                    color: 0x22124a,
                    shininess: 28.00,
                    waveHeight: 18.00,
                    waveSpeed: 0.45,
                    zoom: 0.90
                });
            }

            run();
        })();

        // --- CORE LOGIC ---
        const modeSelector = document.getElementById('modeSelector');
        const debridKeys = document.getElementById('debridKeys');
        const imdbInput = document.getElementById('imdbId');
        const typeSelect = document.getElementById('type');
        const previewDiv = document.getElementById('metaPreview');
        const submitBtn = document.getElementById('submitBtn');
        const checkBtn = document.getElementById('checkBtn');
        const mappingSection = document.getElementById('mappingSection');
        const seasonSelect = document.getElementById('seasonSelect');
        const episodeSelect = document.getElementById('episodeSelect');
        const episodesTable = document.getElementById('episodesTable');
        const mappingStatus = document.getElementById('mappingStatus');
        const autoMatchBtn = document.getElementById('autoMatchBtn');
        const saveMappingBtn = document.getElementById('saveMappingBtn');
        const manualMapToggle = document.getElementById('manualMapToggle');
        const moviePackMappingSection = document.getElementById('moviePackMappingSection');
        const packFilesList = document.getElementById('packFilesList');
        const packFilesCountBadge = document.getElementById('packFilesCountBadge');
        const packFilesStatus = document.getElementById('packFilesStatus');
        const savePackMappingBtn = document.getElementById('savePackMappingBtn');

        // Initial validation state
        let isValidated = false;
        let currentTmdbId = null; // Store detected TMDB ID
        let lastImport = null;
        let currentEpisodes = [];
        let pendingPreview = null; // ✅ Stores preview data when manual mapping (torrent NOT yet imported)
        let mappingSelections = new Map(); // key: "season-episode" -> fileId

        // 🎛️ MEDIA SPECS & TRACKS UI CONTROLLERS
        function toggleSpecsAccordion() {
            const content = document.getElementById('specsContent');
            const chevron = document.getElementById('specsChevron');
            if (content.style.display === 'none') {
                content.style.display = 'block';
                chevron.style.transform = 'rotate(0deg)';
            } else {
                content.style.display = 'none';
                chevron.style.transform = 'rotate(-90deg)';
            }
        }

        function toggleChip(el, type) {
            const val = el.getAttribute('data-val');
            if (type === 'sub') {
                if (val === 'None') {
                    document.querySelectorAll('#subLangChips .chip-btn').forEach(btn => btn.classList.remove('active'));
                    el.classList.add('active');
                    return;
                } else {
                    const noneChip = document.querySelector('#subLangChips .chip-btn[data-val="None"]');
                    if (noneChip) noneChip.classList.remove('active');
                    el.classList.toggle('active');
                }
            } else {
                el.classList.toggle('active');
            }
        }

        function getSelectedSpecs() {
            const audioLangs = [];
            document.querySelectorAll('#audioLangChips .chip-btn.active').forEach(btn => {
                const v = btn.getAttribute('data-val');
                if (v) audioLangs.push(v);
            });

            const subLangs = [];
            document.querySelectorAll('#subLangChips .chip-btn.active').forEach(btn => {
                const v = btn.getAttribute('data-val');
                if (v && v !== 'None') subLangs.push(v);
            });

            const resolution = document.getElementById('specResolution').value;
            const quality = document.getElementById('specQuality').value;
            const codec = document.getElementById('specCodec').value;
            const hdrVal = document.getElementById('specHdr').value;
            const audioVal = document.getElementById('specAudio').value;

            const visualTags = [];
            if (hdrVal && hdrVal !== 'auto') visualTags.push(hdrVal);

            const audioTags = [];
            if (audioVal && audioVal !== 'auto') audioTags.push(audioVal);

            return {
                audioLanguages: audioLangs,
                subLanguages: subLangs,
                resolution,
                quality,
                codec,
                visualTags,
                audioTags
            };
        }

        function autoDetectSpecs(title) {
            if (!title) return;
            const str = String(title);
            const detectedItems = [];

            // Subtitles detection first
            const subChips = document.querySelectorAll('#subLangChips .chip-btn');
            subChips.forEach(btn => btn.classList.remove('active'));

            const hasSubIta = /\\b(sub[._ -]?(ita|italian)|(ita|italian)[._ -]?sub(?![._ -]?(ita|eng|jap|fre|ger|spa|por)))\\b/i.test(str);
            const hasSubEng = /\\b(sub[._ -]?(eng|english)|(eng|english)[._ -]?sub(?![._ -]?(ita|eng|jap|fre|ger|spa|por)))\\b/i.test(str);
            const hasSubJap = /\\b(sub[._ -]?(jap|japanese|jpn)|(jap|japanese|jpn)[._ -]?sub(?![._ -]?(ita|eng|jap|fre|ger|spa|por)))\\b/i.test(str);
            const hasSubFra = /\\b(sub[._ -]?(fre|french|fra)|(fre|french|fra)[._ -]?sub(?![._ -]?(ita|eng|jap|fre|ger|spa|por)))\\b/i.test(str);
            const hasSubGer = /\\b(sub[._ -]?(ger|german|deu)|(ger|german|deu)[._ -]?sub(?![._ -]?(ita|eng|jap|fre|ger|spa|por)))\\b/i.test(str);
            const hasSubSpa = /\\b(sub[._ -]?(spa|spanish|esp)|(spa|spanish|esp)[._ -]?sub(?![._ -]?(ita|eng|jap|fre|ger|spa|por)))\\b/i.test(str);
            const hasSubPor = /\\b(sub[._ -]?(por|portuguese|pt|pt-br)|(por|portuguese)[._ -]?sub(?![._ -]?(ita|eng|jap|fre|ger|spa|por)))\\b/i.test(str);
            const hasSubMulti = /\\b(msubs?|multi[._ -]?subs?)\\b/i.test(str);

            if (hasSubIta) { document.querySelector('#subLangChips .chip-btn[data-val="Italian"]')?.classList.add('active'); detectedItems.push('Sub ITA'); }
            if (hasSubEng) { document.querySelector('#subLangChips .chip-btn[data-val="English"]')?.classList.add('active'); detectedItems.push('Sub ENG'); }
            if (hasSubJap) { document.querySelector('#subLangChips .chip-btn[data-val="Japanese"]')?.classList.add('active'); detectedItems.push('Sub JAP'); }
            if (hasSubFra) { document.querySelector('#subLangChips .chip-btn[data-val="French"]')?.classList.add('active'); detectedItems.push('Sub FRA'); }
            if (hasSubGer) { document.querySelector('#subLangChips .chip-btn[data-val="German"]')?.classList.add('active'); detectedItems.push('Sub GER'); }
            if (hasSubSpa) { document.querySelector('#subLangChips .chip-btn[data-val="Spanish"]')?.classList.add('active'); detectedItems.push('Sub SPA'); }
            if (hasSubPor) { document.querySelector('#subLangChips .chip-btn[data-val="Portuguese"]')?.classList.add('active'); detectedItems.push('Sub POR'); }
            if (hasSubMulti) { document.querySelector('#subLangChips .chip-btn[data-val="Multi"]')?.classList.add('active'); detectedItems.push('Multi Subs'); }

            // Audio Languages (strip subtitle tags first)
            let audioStr = str;
            audioStr = audioStr.replace(/\\bsub[._ -]?(ita|italian|eng|english|jap|japanese|jpn|fre|french|fra|ger|german|deu|spa|spanish|esp|por|portuguese|pt|multi)\\b/gi, ' ');
            audioStr = audioStr.replace(/\\b(ita|italian|eng|english|jap|japanese|jpn|fre|french|fra|ger|german|deu|spa|spanish|esp|por|portuguese|pt)[._ -]?sub\\b/gi, ' ');
            audioStr = audioStr.replace(/\\b(msubs?|multi[._ -]?subs?)\\b/gi, ' ');

            const audioChips = document.querySelectorAll('#audioLangChips .chip-btn');
            audioChips.forEach(btn => btn.classList.remove('active'));

            const hasIta = /\\b(ita|italian)\\b/i.test(audioStr);
            const hasEng = /\\b(eng|english)\\b/i.test(audioStr);
            const hasJap = /\\b(jap|japanese|jpn)\\b/i.test(audioStr);
            const hasFra = /\\b(fre|french|fra)\\b/i.test(audioStr);
            const hasGer = /\\b(ger|german|deu)\\b/i.test(audioStr);
            const hasSpa = /\\b(spa|spanish|esp)\\b/i.test(audioStr);
            const hasPor = /\\b(por|portuguese|pt|pt-br)\\b/i.test(audioStr);
            const hasMulti = /\\bmulti\\b/i.test(audioStr);
            const hasDual = /\\bdual\\b/i.test(audioStr);

            if (hasIta) { document.querySelector('#audioLangChips .chip-btn[data-val="Italian"]')?.classList.add('active'); detectedItems.push('🇮🇹 ITA'); }
            if (hasEng) { document.querySelector('#audioLangChips .chip-btn[data-val="English"]')?.classList.add('active'); detectedItems.push('🇬🇧 ENG'); }
            if (hasJap) { document.querySelector('#audioLangChips .chip-btn[data-val="Japanese"]')?.classList.add('active'); detectedItems.push('🇯🇵 JAP'); }
            if (hasFra) { document.querySelector('#audioLangChips .chip-btn[data-val="French"]')?.classList.add('active'); detectedItems.push('🇫🇷 FRA'); }
            if (hasGer) { document.querySelector('#audioLangChips .chip-btn[data-val="German"]')?.classList.add('active'); detectedItems.push('🇩🇪 GER'); }
            if (hasSpa) { document.querySelector('#audioLangChips .chip-btn[data-val="Spanish"]')?.classList.add('active'); detectedItems.push('🇪🇸 SPA'); }
            if (hasPor) { document.querySelector('#audioLangChips .chip-btn[data-val="Portuguese"]')?.classList.add('active'); detectedItems.push('🇵🇹 POR'); }
            if (hasMulti) { document.querySelector('#audioLangChips .chip-btn[data-val="Multi"]')?.classList.add('active'); detectedItems.push('🌎 MULTI'); }
            if (hasDual) { document.querySelector('#audioLangChips .chip-btn[data-val="Dual Audio"]')?.classList.add('active'); detectedItems.push('🎙️ DUAL'); }

            // Resolution
            const resSelect = document.getElementById('specResolution');
            if (/2160p?|4k|uhd/i.test(str)) { resSelect.value = '2160p'; detectedItems.push('4K'); }
            else if (/1080p?/i.test(str)) { resSelect.value = '1080p'; detectedItems.push('1080p'); }
            else if (/720p?/i.test(str)) { resSelect.value = '720p'; detectedItems.push('720p'); }
            else if (/576p?/i.test(str)) { resSelect.value = '576p'; detectedItems.push('576p'); }
            else if (/480p?|sd\\b/i.test(str)) { resSelect.value = '480p'; detectedItems.push('480p'); }
            else if (/dvdrip/i.test(str)) { resSelect.value = 'DVDRip'; detectedItems.push('DVDRip'); }
            else { resSelect.value = 'auto'; }

            // Quality
            const qualSelect = document.getElementById('specQuality');
            if (/\\bremux\\b/i.test(str)) { qualSelect.value = 'Remux'; detectedItems.push('Remux'); }
            else if (/blu.?ray|bdrip|brrip/i.test(str)) { qualSelect.value = 'BluRay'; detectedItems.push('BluRay'); }
            else if (/web.?dl/i.test(str)) { qualSelect.value = 'WEB-DL'; detectedItems.push('WEB-DL'); }
            else if (/web.?rip/i.test(str)) { qualSelect.value = 'WEBRip'; detectedItems.push('WEBRip'); }
            else if (/hdtv/i.test(str)) { qualSelect.value = 'HDTV'; detectedItems.push('HDTV'); }
            else if (/dvd.?rip/i.test(str)) { qualSelect.value = 'DVDRip'; detectedItems.push('DVDRip'); }
            else if (/\\bcam\\b|telesync|\\bts\\b/i.test(str)) { qualSelect.value = 'CAM'; detectedItems.push('CAM'); }
            else { qualSelect.value = 'auto'; }

            // Codec
            const codecSelect = document.getElementById('specCodec');
            if (/hevc|x.?265|h.?265/i.test(str)) { codecSelect.value = 'HEVC'; detectedItems.push('HEVC'); }
            else if (/avc|x.?264|h.?264/i.test(str)) { codecSelect.value = 'AVC'; detectedItems.push('AVC'); }
            else if (/\\bav1\\b/i.test(str)) { codecSelect.value = 'AV1'; detectedItems.push('AV1'); }
            else if (/xvid|divx/i.test(str)) { codecSelect.value = 'XviD'; detectedItems.push('XviD'); }
            else { codecSelect.value = 'auto'; }

            // HDR
            const hdrSelect = document.getElementById('specHdr');
            if (/dolby.?vision|dovi|\\bdv\\b/i.test(str)) { hdrSelect.value = 'DV'; detectedItems.push('DV'); }
            else if (/hdr10\\+/i.test(str)) { hdrSelect.value = 'HDR10+'; detectedItems.push('HDR10+'); }
            else if (/hdr10/i.test(str)) { hdrSelect.value = 'HDR10'; detectedItems.push('HDR10'); }
            else if (/\\bhdr\\b/i.test(str)) { hdrSelect.value = 'HDR'; detectedItems.push('HDR'); }
            else { hdrSelect.value = 'auto'; }

            // Audio format
            const audioSelect = document.getElementById('specAudio');
            if (/atmos/i.test(str)) { audioSelect.value = 'Atmos'; detectedItems.push('Atmos'); }
            else if (/dts.?hd/i.test(str)) { audioSelect.value = 'DTS-HD'; detectedItems.push('DTS-HD'); }
            else if (/7\\.1/i.test(str)) { audioSelect.value = '7.1'; detectedItems.push('7.1'); }
            else if (/5\\.1/i.test(str)) { audioSelect.value = '5.1'; detectedItems.push('5.1'); }
            else if (/dd\\+|ddp|eac3|ac3/i.test(str)) { audioSelect.value = 'AC3'; detectedItems.push('AC3'); }
            else if (/\\baac\\b/i.test(str)) { audioSelect.value = 'AAC'; detectedItems.push('AAC'); }
            else { audioSelect.value = 'auto'; }

            // Show badge if items detected
            const badge = document.getElementById('detectedSpecsBadge');
            const badgeText = document.getElementById('detectedSpecsText');
            if (detectedItems.length > 0) {
                badgeText.innerHTML = '✨ <b>Rilevato:</b> ' + detectedItems.join(' • ');
                badge.style.display = 'block';
            } else {
                badge.style.display = 'none';
            }
        }

        // 💜 Ask contributor name via popup - returns Promise<string|null> (null = cancelled)
        function askContributorName() {
            return new Promise((resolve) => {
                const overlay = document.getElementById('contributorOverlay');
                const input = document.getElementById('contributorInput');
                const confirmBtn = document.getElementById('contributorConfirm');
                const cancelBtn = document.getElementById('contributorCancel');
                input.value = '';
                overlay.style.display = 'flex';
                input.focus();

                function cleanup() {
                    overlay.style.display = 'none';
                    confirmBtn.removeEventListener('click', onConfirm);
                    cancelBtn.removeEventListener('click', onCancel);
                    input.removeEventListener('keydown', onKey);
                }
                function onConfirm() { cleanup(); resolve(input.value.trim()); }
                function onCancel() { cleanup(); resolve(null); }
                function onKey(e) { if (e.key === 'Enter') onConfirm(); if (e.key === 'Escape') onCancel(); }

                confirmBtn.addEventListener('click', onConfirm);
                cancelBtn.addEventListener('click', onCancel);
                input.addEventListener('keydown', onKey);
            });
        }

        // ✅ Update button text based on mode and selection
        function updateSubmitButtonText() {
            if (typeSelect.value === 'pack') {
                submitBtn.innerText = '📦 Inizia Mappatura Pack';
            } else if (manualMapToggle.checked && typeSelect.value === 'series') {
                submitBtn.innerText = 'Inizia Collegamento Puntate';
            } else {
                submitBtn.innerText = 'Avvia Importazione';
            }
        }

        // Reset validation on input change
        imdbInput.addEventListener('input', () => {
            isValidated = false;
            currentTmdbId = null; // Reset
            submitBtn.disabled = true;
            submitBtn.style.opacity = '0.5';
            submitBtn.style.cursor = 'not-allowed';
            previewDiv.style.display = 'none';
        });

        // ✅ NEW: Handle Pack Mode (No ID required)
        function checkPackMode() {
            const isPack = typeSelect.value === 'pack';
            const imdbGroup = document.getElementById('imdbId').parentNode.parentNode; // Form group

            if (isPack) {
                // Disable ID, look for magnet/file
                imdbInput.disabled = true;
                checkBtn.disabled = true;
                imdbInput.placeholder = "NON RICHIESTO per Pack (Mappatura su file)";
                imdbInput.style.opacity = '0.5';

                // Disable Search Tabs in Pack Mode
                document.getElementById('tabSearch').style.pointerEvents = 'none';
                document.getElementById('tabSearch').style.opacity = '0.3';
                document.getElementById('tabId').click(); // Force ID tab

                updateSubmitButtonText();

                // Enable Submit if file/magnet exists
                const hasFile = document.getElementById('magnetLink').value.trim() || document.getElementById('torrentFile').files.length > 0;
                if (hasFile) {
                    submitBtn.disabled = false;
                    submitBtn.style.opacity = '1';
                    submitBtn.style.cursor = 'pointer';
                } else {
                    submitBtn.disabled = true;
                    submitBtn.style.opacity = '0.5';
                    submitBtn.style.cursor = 'not-allowed';
                }
            } else {
                // Restore Normal Mode
                imdbInput.disabled = false;
                checkBtn.disabled = false;
                imdbInput.placeholder = "Es: tt1234567 o 550";
                imdbInput.style.opacity = '1';

                // Re-enable tabs
                document.getElementById('tabSearch').style.pointerEvents = 'auto';
                document.getElementById('tabSearch').style.opacity = '1';

                updateSubmitButtonText();

                // Reset submit unless validated
                if (!isValidated) {
                    submitBtn.disabled = true;
                    submitBtn.style.opacity = '0.5';
                    submitBtn.style.cursor = 'not-allowed';
                }
            }
        }

        // --- SEARCH LOGIC ---
        const tabId = document.getElementById('tabId');
        const tabSearch = document.getElementById('tabSearch');
        const idContainer = document.getElementById('idInputContainer');
        const searchContainer = document.getElementById('searchInputContainer');
        const labelId = document.getElementById('labelId');

        tabId.addEventListener('click', () => {
            idContainer.style.display = 'flex';
            searchContainer.style.display = 'none';
            tabId.style.color = 'var(--neon-secondary)'; tabId.style.borderBottom = '2px solid var(--neon-secondary)';
            tabSearch.style.color = '#94a3b8'; tabSearch.style.borderBottom = 'transparent';
            labelId.innerText = 'ID IMDb o TMDB';
        });

        tabSearch.addEventListener('click', () => {
            idContainer.style.display = 'none';
            searchContainer.style.display = 'block';
            tabSearch.style.color = 'var(--neon-secondary)'; tabSearch.style.borderBottom = '2px solid var(--neon-secondary)';
            tabId.style.color = '#94a3b8'; tabId.style.borderBottom = 'transparent';
            labelId.innerText = 'Cerca Titolo (Cinemeta)';
        });

        document.getElementById('searchBtn').addEventListener('click', async () => {
            const q = document.getElementById('searchTerm').value.trim();
            const typeRaw = typeSelect.value;
            const type = typeRaw === 'pack' ? 'movie' : typeRaw; // Search as movie for packs

            if(q.length < 2) return;

            const resDiv = document.getElementById('searchResults');
            resDiv.style.display = 'block';
            resDiv.innerHTML = '<div style="padding:15px; text-align:center; color:#94a3b8;">⏳ Ricerca in corso...</div>';

            try {
                // Use absolute path /scrape/search because relative 'search' might hit root /search if trailing slash missing
                const res = await fetch(\`/scrape/search?q=\${encodeURIComponent(q)}&type=\${type}\`);
                const data = await res.json();

                if(data.results && data.results.length > 0) {
                    resDiv.innerHTML = data.results.map(r => \`
                        <div class="search-item" onclick="selectResult('\${r.imdb_id || r.id}')" style="
                            padding:12px;
                            border-bottom:1px solid rgba(255,255,255,0.05);
                            cursor:pointer;
                            display:flex;
                            align-items:center;
                            gap:15px;
                            transition: background 0.2s;
                        " onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">
                            <img src="\${r.poster}" style="width:35px; height:52px; object-fit:cover; border-radius:4px; background:#1e293b;" onerror="this.style.display='none'">
                            <div style="flex:1;">
                                <div style="font-weight:bold; color:white; font-size:0.95rem;">\${r.name}</div>
                                <div style="font-size:0.8rem; color:#94a3b8;">\${r.releaseInfo || r.year || 'N/A'} • \${r.type === 'movie' ? 'Film' : 'Serie'}</div>
                            </div>
                        </div>
                    \`).join('');
                } else {
                     resDiv.innerHTML = '<div style="padding:15px; text-align:center; color:#f87171;">⚠️ Nessun risultato trovato.</div>';
                }

            } catch(e) {
                resDiv.innerHTML = '<div style="padding:15px; text-align:center; color:#f87171;">❌ Errore durante la ricerca.</div>';
            }
        });

        // Enter key for search
        document.getElementById('searchTerm').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') document.getElementById('searchBtn').click();
        });

        window.selectResult = (id) => {
            imdbInput.value = id;
            document.getElementById('searchResults').style.display = 'none';
            // Switch to ID tab
            tabId.click();
            // Trigger verify
            fetchMetadata();
        };

        typeSelect.addEventListener('change', () => {
             // Reset validation logic when switching types
             if(typeSelect.value !== 'pack') {
                 if(imdbInput.value) { isValidated = false; }
             }
             checkPackMode();
             updateSubmitButtonText();
             updateSubmitButtonState();
        });

        // Validation & State updater for Submit Button
        function updateSubmitButtonState() {
            const isPack = typeSelect.value === 'pack';
            const magnetVal = document.getElementById('magnetLink').value.trim();
            const fileInput = document.getElementById('torrentFile');
            const hasFile = magnetVal.length > 0 || (fileInput.files && fileInput.files.length > 0);

            if (isPack) {
                if (hasFile) {
                    submitBtn.disabled = false;
                    submitBtn.style.opacity = '1';
                    submitBtn.style.cursor = 'pointer';
                    submitBtn.classList.add('pulse-active');
                    submitBtn.title = "";
                } else {
                    submitBtn.disabled = true;
                    submitBtn.style.opacity = '0.5';
                    submitBtn.style.cursor = 'not-allowed';
                    submitBtn.classList.remove('pulse-active');
                    submitBtn.title = "Inserisci un Magnet Link o carica un file .torrent";
                }
                return;
            }

            if (isValidated && hasFile) {
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
                submitBtn.style.cursor = 'pointer';
                submitBtn.classList.add('pulse-active');
                submitBtn.title = "";
            } else {
                submitBtn.disabled = true;
                submitBtn.style.opacity = '0.5';
                submitBtn.style.cursor = 'not-allowed';
                submitBtn.classList.remove('pulse-active');
                if (!isValidated) submitBtn.title = "Verifica prima l'ID IMDb/TMDB";
                else if (!hasFile) submitBtn.title = "Inserisci un Magnet Link o carica un file .torrent";
            }
        }



        function escapeHtml(value) {
            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function formatBytes(bytes) {
            if (!bytes || bytes <= 0) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB'];
            const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
            const value = bytes / Math.pow(1024, index);
            return \`\${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} \${units[index]}\`;
        }

        function setMappingStatus(text, isError = false) {
            mappingStatus.textContent = text;
            mappingStatus.style.color = isError ? '#fca5a5' : '#94a3b8';
        }

        function updateSaveButtonState() {
            const hasSelection = [...mappingSelections.values()].some(value => value);
            saveMappingBtn.disabled = !hasSelection;
            saveMappingBtn.style.opacity = hasSelection ? '1' : '0.5';
            saveMappingBtn.style.cursor = hasSelection ? 'pointer' : 'not-allowed';
        }

        function getMappingKey(seasonNumber, episodeNumber) {
            return \`\${seasonNumber}-\${episodeNumber}\`;
        }

        function buildFileOptions(selectedId) {
            const files = lastImport?.videoFiles || [];
            const sorted = [...files].sort((a, b) => (a.filename || '').localeCompare(b.filename || ''));
            const options = ['<option value="">-- Non assegnato --</option>'];
            const usedFileIds = new Set(
                [...mappingSelections.values()]
                    .filter(value => value !== null && value !== undefined && value !== '')
                    .map(value => String(value))
            );

            for (const file of sorted) {
                const label = \`\${file.filename} (\${formatBytes(file.bytes || 0)})\`;
                const fileId = String(file.id);
                if (usedFileIds.has(fileId) && String(selectedId) !== fileId) continue;
                const selected = fileId === String(selectedId) ? ' selected' : '';
                options.push(\`<option value="\${file.id}"\${selected}>\${escapeHtml(label)}<\/option>\`);
            }

            return options.join('');
        }

        function renderEpisodes(episodes, seasonNumber) {
            if (!episodes || episodes.length === 0) {
                episodesTable.innerHTML = '<div style="color:#94a3b8; padding:10px 0;">Nessun episodio trovato.</div>';
                updateSaveButtonState();
                return;
            }

            const sNum = String(seasonNumber).padStart(2, '0');
            episodesTable.innerHTML = episodes.map(ep => {
                const key = getMappingKey(seasonNumber, ep.episode_number);
                // Only use explicit user/autoMatch selections — never auto-fill from parsedMap
                const preselected = mappingSelections.has(key) ? (mappingSelections.get(key) || '') : '';
                return \`
                    <div class="mapping-row" data-episode="\${ep.episode_number}">
                        <strong>S\${sNum}E\${String(ep.episode_number).padStart(2, '0')}</strong>
                        <span>\${escapeHtml(ep.name || '')}</span>
                        <select class="mapping-select">\${buildFileOptions(preselected)}</select>
                    </div>
                \`;
            }).join('');

            updateSaveButtonState();
        }

        function updateEpisodeSelect() {
            const sNum = String(seasonSelect.value).padStart(2, '0');
            const options = ['<option value="">Tutti gli episodi</option>'];
            for (const ep of currentEpisodes) {
                options.push(\`<option value="\${ep.episode_number}">S\${sNum}E\${String(ep.episode_number).padStart(2, '0')}</option>\`);
            }
            episodeSelect.innerHTML = options.join('');
        }

        async function loadSeasons(tmdbId) {
            seasonSelect.innerHTML = '<option>Caricamento stagioni...</option>';
            try {
                const res = await fetch(\`/scrape/tmdb/seasons?tmdbId=\${tmdbId}\`);
                const data = await res.json();
                const seasons = (data.seasons || []).filter(s => s.season_number !== null && s.season_number !== undefined);

                if (!seasons.length) {
                    seasonSelect.innerHTML = '<option>Nessuna stagione</option>';
                    setMappingStatus('Nessuna stagione disponibile su TMDB.', true);
                    return;
                }

                seasonSelect.innerHTML = '<option value="" disabled selected>-- Seleziona stagione --</option>' + seasons.map(s =>
                    \`<option value="\${s.season_number}">Stagione \${s.season_number} \u2014 \${escapeHtml(s.name)} (\${s.episode_count || 0} ep)</option>\`
                ).join('');

                // Don't auto-load episodes — wait for user to pick a season
                episodesTable.innerHTML = '<div style="color:#94a3b8; padding:10px 0;">Seleziona una stagione per iniziare.</div>';
                autoMatchBtn.disabled = true;
                autoMatchBtn.style.opacity = '0.5';
                saveMappingBtn.disabled = true;
                saveMappingBtn.style.opacity = '0.5';
            } catch (e) {
                seasonSelect.innerHTML = '<option>Errore TMDB</option>';
                setMappingStatus('Errore durante il caricamento stagioni.', true);
            }
        }

        async function loadSeasonEpisodes(seasonNumber, tmdbId) {
            setMappingStatus('Caricamento episodi...');
            episodesTable.innerHTML = '';
            try {
                const res = await fetch(\`/scrape/tmdb/season?tmdbId=\${tmdbId}&season=\${seasonNumber}\`);
                const data = await res.json();
                currentEpisodes = data.episodes || [];
                renderEpisodes(currentEpisodes, parseInt(seasonNumber, 10));
                updateEpisodeSelect();
                setMappingStatus(\`Stagione \${seasonNumber} caricata. Seleziona i file.\`);
            } catch (e) {
                setMappingStatus('Errore durante il caricamento episodi.', true);
            }
        }

        async function initMappingUI(payload) {
            if (!payload || !payload.infoHash || !payload.videoFiles) return;

            const tmdbId = payload.tmdbId;
            if (!tmdbId) {
                mappingSection.style.display = 'block';
                setMappingStatus('TMDB ID non disponibile. Verifica la scheda metadata.', true);
                return;
            }

            lastImport = payload;
            mappingSection.style.display = 'block';
            await loadSeasons(tmdbId);
        }

        // Add listeners for keys and mode
        document.getElementById('rdKey').addEventListener('input', updateSubmitButtonState);
        document.getElementById('tbKey').addEventListener('input', updateSubmitButtonState);
        modeSelector.addEventListener('change', updateSubmitButtonState);

        episodesTable.addEventListener('change', (event) => {
            if (event.target && event.target.classList.contains('mapping-select')) {
                const row = event.target.closest('.mapping-row');
                const episodeNumber = parseInt(row?.dataset?.episode, 10);
                const seasonNumber = parseInt(seasonSelect.value, 10);
                if (!Number.isNaN(seasonNumber) && !Number.isNaN(episodeNumber)) {
                    const key = getMappingKey(seasonNumber, episodeNumber);
                    const newFileId = event.target.value ? String(event.target.value) : '';
                    // If assigning a file, clear it from any other episode (prevent duplicates)
                    if (newFileId) {
                        for (const [otherKey, otherVal] of mappingSelections.entries()) {
                            if (otherKey !== key && String(otherVal) === newFileId) {
                                mappingSelections.set(otherKey, '');
                            }
                        }
                    }
                    // Set explicit selection (empty string = "non assegnato")
                    mappingSelections.set(key, newFileId);
                    renderEpisodes(currentEpisodes, seasonNumber);
                }
                updateSaveButtonState();
            }
        });

        manualMapToggle.addEventListener('change', () => {
            if (!manualMapToggle.checked) {
                mappingSection.style.display = 'none';
                lastImport = null;
                pendingPreview = null;
                mappingSelections = new Map();
            }
            updateSubmitButtonText();
        });

        seasonSelect.addEventListener('change', async () => {
            if (!lastImport || !lastImport.tmdbId) return;
            if (!seasonSelect.value) return;
            // Enable buttons now that a season is selected
            autoMatchBtn.disabled = false;
            autoMatchBtn.style.opacity = '1';
            await loadSeasonEpisodes(seasonSelect.value, lastImport.tmdbId);
        });

        episodeSelect.addEventListener('change', () => {
            const targetEpisode = episodeSelect.value;
            if (!targetEpisode) return;
            const row = episodesTable.querySelector(\`[data-episode="\${targetEpisode}"]\`);
            if (row) {
                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                row.style.boxShadow = '0 0 0 2px rgba(168, 85, 247, 0.5)';
                setTimeout(() => { row.style.boxShadow = ''; }, 1200);
            }
        });

        autoMatchBtn.addEventListener('click', async () => {
            if (!lastImport) return;
            autoMatchBtn.disabled = true;
            setMappingStatus('AutoMatch in corso...');

            try {
                const res = await fetch('/scrape/automatch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        infoHash: lastImport.infoHash,
                        imdbId: lastImport.imdbId,
                        type: 'series',
                        files: lastImport.videoFiles,
                        manualMapping: manualMapToggle.checked
                    })
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'AutoMatch fallito');

                // Populate mappingSelections from parsed file data
                for (const file of lastImport.videoFiles) {
                    if (file.parsedSeason && file.parsedEpisode) {
                        const key = getMappingKey(file.parsedSeason, file.parsedEpisode);
                        if (!mappingSelections.has(key) || !mappingSelections.get(key)) {
                            mappingSelections.set(key, String(file.id));
                        }
                    }
                }
                renderEpisodes(currentEpisodes, parseInt(seasonSelect.value, 10));

                setMappingStatus(\`AutoMatch completato: \${data.matched} trovati, \${data.unmatched} da mappare.\`);
            } catch (e) {
                setMappingStatus(e.message, true);
            } finally {
                autoMatchBtn.disabled = false;
            }
        });

        saveMappingBtn.addEventListener('click', async () => {
            if (!lastImport) return;

            const mappings = [];
            for (const [key, fileId] of mappingSelections.entries()) {
                if (!fileId) continue;
                const [seasonStr, episodeStr] = key.split('-');
                const seasonNumber = parseInt(seasonStr, 10);
                const episodeNumber = parseInt(episodeStr, 10);
                if (Number.isNaN(seasonNumber) || Number.isNaN(episodeNumber)) continue;

                const file = lastImport.videoFiles.find(f => String(f.id) === String(fileId));
                if (!file) continue;

                mappings.push({
                    season: seasonNumber,
                    episode: episodeNumber,
                    file_index: file.id,
                    file_path: file.path,
                    file_size: file.bytes || 0
                });
            }

            if (mappings.length === 0) {
                setMappingStatus('Seleziona almeno un file per salvare.', true);
                return;
            }

            saveMappingBtn.disabled = true;
            const resDiv = document.getElementById('result');
            const dbg = document.getElementById('debug');

            // 💜 Ask contributor name before saving
            const contributorName = await askContributorName();
            if (contributorName === null) { saveMappingBtn.disabled = false; return; }

            try {
                // ✅ If pendingPreview exists, import torrent FIRST, then save mappings
                if (pendingPreview) {
                    setMappingStatus('Importazione torrent in corso...');
                    dbg.innerText = 'Importazione torrent + mappatura...';

                    const formData = new FormData();
                    formData.append('method', pendingPreview.mode);
                    formData.append('imdbId', pendingPreview.imdbId);
                    if (pendingPreview.tmdbId) formData.append('tmdbId', pendingPreview.tmdbId);
                    formData.append('type', pendingPreview.typeVal);
                    formData.append('manualMapping', 'true');
                    formData.append('contributor', contributorName || '');
                    if (pendingPreview.seedersVal) formData.append('seeders', pendingPreview.seedersVal);
                    if (pendingPreview.rdKey) formData.append('rdKey', pendingPreview.rdKey);
                    if (pendingPreview.tbKey) formData.append('tbKey', pendingPreview.tbKey);

                    // 🎛️ Media specs
                    if (pendingPreview.specs) {
                        if (pendingPreview.specs.audioLanguages) formData.append('audioLanguages', JSON.stringify(pendingPreview.specs.audioLanguages));
                        if (pendingPreview.specs.subLanguages) formData.append('subLanguages', JSON.stringify(pendingPreview.specs.subLanguages));
                        if (pendingPreview.specs.resolution) formData.append('resolution', pendingPreview.specs.resolution);
                        if (pendingPreview.specs.quality) formData.append('quality', pendingPreview.specs.quality);
                        if (pendingPreview.specs.codec) formData.append('codec', pendingPreview.specs.codec);
                        if (pendingPreview.specs.visualTags) formData.append('visualTags', JSON.stringify(pendingPreview.specs.visualTags));
                        if (pendingPreview.specs.audioTags) formData.append('audioTags', JSON.stringify(pendingPreview.specs.audioTags));
                    }

                    if (pendingPreview.torrentBase64) {
                        formData.append('torrentFileBase64', pendingPreview.torrentBase64);
                    } else {
                        formData.append('magnetLink', pendingPreview.magnetLink);
                    }

                    const importRes = await fetch('/scrape/add', {
                        method: 'POST',
                        body: formData
                    });

                    const importData = await importRes.json();
                    if (!importRes.ok) {
                        throw new Error(importData.error || 'Importazione torrent fallita');
                    }

                    setMappingStatus('Torrent importato. Salvataggio mappatura...');
                }

                // Save mappings
                setMappingStatus('Salvataggio mappatura...');
                const mapRes = await fetch('/scrape/map', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        infoHash: lastImport.infoHash,
                        imdbId: lastImport.imdbId,
                        contributor: contributorName || '',
                        mappings
                    })
                });

                const mapData = await mapRes.json();
                if (!mapRes.ok) throw new Error(mapData.error || 'Salvataggio fallito');

                if (pendingPreview) {
                    resDiv.style.display = 'block';
                    resDiv.className = 'success';
                    resDiv.innerHTML = \`⚡ <b>Importazione + Mappatura Completata</b><br><small>\${mapData.updated} episodi collegati con successo.</small>\`;
                    dbg.innerText = 'Operazione completata.';
                    pendingPreview = null;
                }

                setMappingStatus(\`✅ Mappatura salvata: \${mapData.updated} collegati, \${mapData.failed} falliti.\`);
            } catch (e) {
                setMappingStatus('❌ ' + e.message, true);
                if (pendingPreview) {
                    resDiv.style.display = 'block';
                    resDiv.className = 'error';
                    resDiv.innerText = 'Errore: ' + e.message;
                    dbg.innerText = 'Problema riscontrato.';
                }
            } finally {
                saveMappingBtn.disabled = false;
                updateSaveButtonState();
            }
        });

        // 📦 MOVIE PACK MAPPING LOGIC
        let pendingPackPreview = null;

        function cleanMovieFileName(filename) {
            if (!filename) return '';
            const parts = filename.split('/');
            let name = parts[parts.length - 1] || '';
            name = name.replace(/\\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i, '');
            return name.replace(/[._]/g, ' ').trim();
        }

        async function verifyPackMovieRow(card, fileId) {
            const input = card.querySelector('.pack-movie-input');
            const preview = document.getElementById('packPreview_' + fileId);
            const query = input.value.trim();
            if (!query) {
                preview.style.display = 'none';
                card.dataset.imdbId = '';
                return;
            }

            preview.style.display = 'flex';
            preview.innerHTML = '<span style="font-size:0.8rem; color:#cbd5e1;">Ricerca in corso...</span>';

            try {
                // If starts with tt or is numeric ID, check /meta
                if (query.toLowerCase().startsWith('tt') || /^\d+$/.test(query)) {
                    const res = await fetch(\`/scrape/meta?id=\${encodeURIComponent(query)}&type=movie\`);
                    const d = await res.json();
                    if (d && (d.title || d.imdb_id)) {
                        const imdb = d.imdb_id || d.imdbId || query;
                        card.dataset.imdbId = imdb;
                        preview.innerHTML = \`
                            \${d.poster ? \`<img src="\${d.poster}" class="pack-movie-poster">\` : ''}
                            <div class="pack-movie-info">
                                <div class="pack-movie-title">\${d.title || 'Film'}</div>
                                <div class="pack-movie-meta">\${d.year || ''} • <span style="background:rgba(34,197,94,0.2); color:#4ade80; padding:1px 6px; border-radius:4px; font-weight:600;">✓ \${imdb}</span></div>
                            </div>
                        \`;
                        return;
                    }
                }

                // Otherwise search TMDB by title
                const res = await fetch(\`/scrape/search?q=\${encodeURIComponent(query)}&type=movie\`);
                const d = await res.json();
                if (d.results && d.results.length > 0) {
                    const first = d.results[0];
                    let imdb = null;
                    let poster = first.poster_path ? \`https://image.tmdb.org/t/p/w92\${first.poster_path}\` : '';
                    let title = first.title || first.name || '';
                    let year = (first.release_date || '').substring(0, 4);

                    try {
                        const metaRes = await fetch(\`/scrape/meta?id=\${first.id}&type=movie\`);
                        const metaData = await metaRes.json();
                        if (metaData) {
                            imdb = metaData.imdb_id || metaData.imdbId || null;
                            if (metaData.poster) poster = metaData.poster;
                            if (metaData.title) title = metaData.title;
                            if (metaData.year) year = metaData.year;
                        }
                    } catch (_) {}

                    const resolvedId = imdb || String(first.id);
                    card.dataset.imdbId = resolvedId;
                    input.value = resolvedId;

                    preview.innerHTML = \`
                        \${poster ? \`<img src="\${poster}" class="pack-movie-poster">\` : ''}
                        <div class="pack-movie-info">
                            <div class="pack-movie-title">\${title}</div>
                            <div class="pack-movie-meta">\${year} • <span style="background:rgba(34,197,94,0.2); color:#4ade80; padding:1px 6px; border-radius:4px; font-weight:600;">✓ \${resolvedId}</span></div>
                        </div>
                    \`;
                } else {
                    preview.innerHTML = '<span style="font-size:0.8rem; color:#f87171;">⚠️ Nessun film trovato. Prova con ID IMDb es: tt1234567</span>';
                }
            } catch (err) {
                preview.innerHTML = '<span style="font-size:0.8rem; color:#f87171;">Errore di ricerca metadata.</span>';
            }
        }

        function initMoviePackMappingUI(videoFiles, torrentName, previewContext) {
            pendingPackPreview = previewContext;
            packFilesList.innerHTML = '';
            packFilesCountBadge.innerText = \`\${videoFiles.length} file video\`;
            moviePackMappingSection.style.display = 'block';

            videoFiles.forEach((file, index) => {
                const cleanName = cleanMovieFileName(file.path || file.title || '');
                const sizeGb = ((file.bytes || file.size || 0) / (1024 * 1024 * 1024)).toFixed(2);
                const sizeMb = ((file.bytes || file.size || 0) / (1024 * 1024)).toFixed(0);
                const sizeLabel = (parseFloat(sizeGb) >= 1) ? \`\${sizeGb} GB\` : \`\${sizeMb} MB\`;

                const card = document.createElement('div');
                card.className = 'pack-movie-card';
                card.dataset.fileIndex = file.id !== undefined ? file.id : index;
                card.dataset.filePath = file.path || file.title || '';
                card.dataset.fileSize = file.bytes || file.size || 0;
                card.dataset.imdbId = '';

                card.innerHTML = \`
                    <div class="pack-movie-header">
                        <div class="pack-movie-name">📁 <b>#\${file.id !== undefined ? file.id : index + 1}</b> \${file.path || file.title || ''}</div>
                        <div class="pack-movie-size">\${sizeLabel}</div>
                    </div>
                    <div class="pack-movie-input-row">
                        <input type="text" class="pack-movie-input" placeholder="ID IMDb (es. tt2313197) o Cerca Titolo..." value="">
                        <button type="button" class="btn-glow btn-small pack-search-btn">🔍 Cerca</button>
                    </div>
                    <div class="pack-movie-preview" id="packPreview_\${file.id !== undefined ? file.id : index}"></div>
                \`;

                const input = card.querySelector('.pack-movie-input');
                const btn = card.querySelector('.pack-search-btn');

                btn.addEventListener('click', () => verifyPackMovieRow(card, file.id !== undefined ? file.id : index));
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        verifyPackMovieRow(card, file.id !== undefined ? file.id : index);
                    }
                });

                packFilesList.appendChild(card);
            });

            moviePackMappingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        savePackMappingBtn.addEventListener('click', async () => {
            if (!pendingPackPreview) return;
            const btn = savePackMappingBtn;
            const resDiv = document.getElementById('result');
            const dbg = document.getElementById('debug');

            btn.disabled = true;
            btn.innerText = 'Salvataggio in corso...';
            dbg.innerText = 'Importazione Pack con Mappatura...';

            const packMappings = [];
            for (const card of packFilesList.querySelectorAll('.pack-movie-card')) {
                const fileIndex = card.dataset.fileIndex;
                const filePath = card.dataset.filePath;
                const fileSize = card.dataset.fileSize;
                const inputVal = card.querySelector('.pack-movie-input').value.trim();
                const imdbId = card.dataset.imdbId || (inputVal.toLowerCase().startsWith('tt') ? inputVal : null);
                packMappings.push({
                    file_index: parseInt(fileIndex, 10),
                    file_path: filePath,
                    file_size: parseInt(fileSize, 10) || 0,
                    imdb_id: imdbId || null
                });
            }

            // Ask contributor name
            const contributor = await askContributorName();

            const formData = new FormData();
            formData.append('type', 'pack');
            formData.append('forcePackMode', 'true');
            formData.append('method', pendingPackPreview.mode || 'debrid');
            if (pendingPackPreview.rdKey) formData.append('rdKey', pendingPackPreview.rdKey);
            if (pendingPackPreview.tbKey) formData.append('tbKey', pendingPackPreview.tbKey);
            if (pendingPackPreview.seedersVal) formData.append('seeders', pendingPackPreview.seedersVal);
            if (contributor) formData.append('contributor', contributor);

            if (pendingPackPreview.torrentBase64) {
                formData.append('torrentFileBase64', pendingPackPreview.torrentBase64);
            } else {
                formData.append('magnetLink', pendingPackPreview.magnetLink);
            }

            formData.append('packMappings', JSON.stringify(packMappings));

            // Custom media specs
            const specs = getSelectedSpecs();
            formData.append('audioLanguages', JSON.stringify(specs.audioLanguages));
            formData.append('subLanguages', JSON.stringify(specs.subLanguages));
            formData.append('resolution', specs.resolution);
            formData.append('quality', specs.quality);
            formData.append('codec', specs.codec);
            formData.append('visualTags', JSON.stringify(specs.visualTags));
            formData.append('audioTags', JSON.stringify(specs.audioTags));

            try {
                const response = await fetch('/scrape/add', {
                    method: 'POST',
                    body: formData
                });
                const data = await response.json();
                resDiv.style.display = 'block';

                if (response.ok && data.status === 'success') {
                    const mappedCount = packMappings.filter(m => m.imdb_id).length;
                    resDiv.className = 'success';
                    resDiv.innerHTML = \`🎉 <b>Pack Multi-Film Importato con Successo!</b><br>
                    <small>📦 Salvati <b>\${packMappings.length} file</b> nella tabella pack_files (di cui <b>\${mappedCount}</b> con ID IMDb associato).</small>\`;
                    dbg.innerText = 'Completato con successo!';
                    moviePackMappingSection.style.display = 'none';
                    resDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
                } else {
                    resDiv.className = 'error';
                    resDiv.innerText = 'Errore: ' + (data.error || 'Salvataggio fallito');
                    dbg.innerText = 'Errore durante il salvataggio.';
                }
            } catch (err) {
                resDiv.style.display = 'block';
                resDiv.className = 'error';
                resDiv.innerText = 'Errore di rete: ' + err.message;
                dbg.innerText = 'Errore di rete.';
            } finally {
                btn.disabled = false;
                btn.innerText = '💾 Salva & Importa Pack Film';
            }
        });
        function onMagnetOrFileChanged() {
            checkPackMode();
            const magnetVal = document.getElementById('magnetLink').value.trim();
            const fileInput = document.getElementById('torrentFile');
            if (fileInput.files && fileInput.files[0]) {
                autoDetectSpecs(fileInput.files[0].name);
            } else if (magnetVal) {
                const match = magnetVal.match(/dn=([^&]+)/i);
                if (match) {
                    try {
                        autoDetectSpecs(decodeURIComponent(match[1].split('+').join(' ')));
                    } catch (_) {
                        autoDetectSpecs(match[1]);
                    }
                } else {
                    const hashMatch = magnetVal.match(/xt=urn:btih:([a-zA-Z0-9]{32,40})/i) || magnetVal.match(/\b([a-zA-Z0-9]{32,40})\b/);
                    if (hashMatch) {
                        const hash = hashMatch[1];
                        clearTimeout(resolveHashTimer);
                        resolveHashTimer = setTimeout(async () => {
                            try {
                                const r = await fetch(\`/scrape/resolve-title?hash=\${hash}\`);
                                const d = await r.json();
                                if (d.found && d.title) {
                                    autoDetectSpecs(d.title);
                                }
                            } catch (_) {}
                        }, 250);
                    } else {
                        autoDetectSpecs(magnetVal);
                    }
                }
            }
        }

        // Add listeners to Inputs to trigger Pack check & Specs auto-detect
        const magnetEl = document.getElementById('magnetLink');
        magnetEl.addEventListener('input', onMagnetOrFileChanged);
        magnetEl.addEventListener('change', onMagnetOrFileChanged);
        magnetEl.addEventListener('keyup', onMagnetOrFileChanged);
        magnetEl.addEventListener('paste', () => setTimeout(onMagnetOrFileChanged, 50));

        const torrentFileEl = document.getElementById('torrentFile');
        torrentFileEl.addEventListener('change', onMagnetOrFileChanged);

        // METADATA CHECK LOGIC
        async function fetchMetadata() {
            const id = imdbInput.value.trim();
            const type = typeSelect.value;

            if (id.length < 3) return;

            checkBtn.innerText = '⏳';
            checkBtn.disabled = true;

            previewDiv.style.display = 'block';
            previewDiv.innerHTML = '<div style="text-align:center; color:#94a3b8;">🔍 Verifica in corso...</div>';
            previewDiv.className = 'preview-card';

            try {
                const res = await fetch(\`/scrape/meta?id=\${id}&type=\${type}\`);
                const data = await res.json();

                if (data.found) {
                    // Auto-Correct Type if needed
                    if (data.detected_type && data.detected_type !== type) {
                        typeSelect.value = data.detected_type;
                    }

                    previewDiv.innerHTML = \`
                        <img src="\${data.poster}" class="preview-poster" onerror="this.onerror=null; this.src='https://via.placeholder.com/80x120?text=No+Img'">
                        <div class="preview-info">
                            <h3>\${data.title} (\${data.year ? data.year.split('–')[0] : 'N/A'})</h3>
                            <p>\${data.description ? data.description.substring(0, 100) + '...' : 'Nessuna descrizione.'}</p>
                            <span class="preview-tag">\${data.imdb_id}</span>
                            \${data.original_id !== data.imdb_id ? '<span class="preview-tag" style="background:#a855f7; color:white;">TMDB Converted</span>' : ''}
                            \${data.warning ? '<div style="color: #fca5a5; font-size: 0.8rem; margin-top:5px;">⚠️ ' + data.warning + '</div>' : ''}
                        </div>
                    \`;

                    if (data.imdb_id !== id) {
                        imdbInput.value = data.imdb_id;
                    }

                    // Save TMDB ID if present
                    if (data.tmdb_id) {
                        currentTmdbId = data.tmdb_id;
                    }

                    isValidated = true;
                    updateSubmitButtonState();

                } else {
                    previewDiv.innerHTML = '<div style="color:#f87171;">⚠️ Nessun risultato trovato. Verifica ID.</div>';
                    isValidated = false;
                    updateSubmitButtonState();
                }
            } catch (e) {
                previewDiv.style.display = 'none';
                alert('Errore di connessione verifica');
            } finally {
                checkBtn.innerText = '🔍 Verifica';
                checkBtn.disabled = false;
            }
        }

        checkBtn.addEventListener('click', fetchMetadata);
        // Also trigger on Enter in input
        imdbInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') fetchMetadata(); });

        modeSelector.addEventListener('change', () => {
            debridKeys.style.display = (modeSelector.value === 'nodebrid') ? 'none' : 'block';
            updateSubmitButtonState();
        });

        document.getElementById('submitBtn').addEventListener('click', async function() {
            const btn = this;
            const resDiv = document.getElementById('result');
            const dbg = document.getElementById('debug');

            const isManualMappingMode = manualMapToggle.checked && typeSelect.value === 'series';

            dbg.innerText = 'Inizializzazione in corso...';
            btn.disabled = true;
            btn.innerText = 'Elaborazione...';
            resDiv.style.display = 'none';
            mappingSection.style.display = 'none';
            lastImport = null;
            pendingPreview = null;
            mappingSelections = new Map();

            const magnetLink = document.getElementById('magnetLink').value.trim();
            const torrentFile = document.getElementById('torrentFile').files[0];
            const imdbId = document.getElementById('imdbId').value.trim();
            const typeVal = document.getElementById('type').value;
            const seedersVal = document.getElementById('seeders').value.trim();
            const rdKey = document.getElementById('rdKey').value.trim();
            const tbKey = document.getElementById('tbKey').value.trim();
            const mode = modeSelector.value;
            const specs = getSelectedSpecs();

            const btnLabel = isManualMappingMode ? 'Inizia Collegamento Puntate' : 'Avvia Importazione';

            if (!imdbId && typeVal !== 'pack') { alert('Inserisci un ID IMDb valido'); btn.disabled = false; btn.innerText = btnLabel; return; }
            if (!torrentFile && !magnetLink) { alert('Inserisci un Magnet Link o carica un file .torrent'); btn.disabled = false; btn.innerText = btnLabel; return; }

            // ✅ Prepare base64 once (used by both preview and import paths)
            let torrentBase64 = null;
            if (torrentFile) {
                dbg.innerText = 'Caricamento file torrent...';
                torrentBase64 = await new Promise((res, rej) => {
                    const r = new FileReader();
                    r.onload = () => res(r.result.split(',')[1]);
                    r.onerror = rej;
                    r.readAsDataURL(torrentFile);
                });
            }

            try {
                if (typeVal === 'pack') {
                    // 📦 MOVIE PACK FLOW: Preview files and show per-movie mapping UI
                    dbg.innerText = 'Recupero file del pack...';
                    const formData = new FormData();
                    formData.append('method', mode);
                    if (rdKey) formData.append('rdKey', rdKey);
                    if (tbKey) formData.append('tbKey', tbKey);
                    if (torrentBase64) {
                        formData.append('torrentFileBase64', torrentBase64);
                    } else {
                        formData.append('magnetLink', magnetLink);
                    }

                    const response = await fetch('/scrape/preview-files', {
                        method: 'POST',
                        body: formData
                    });

                    const data = await response.json();
                    resDiv.style.display = 'block';

                    if (response.ok && data.videoFiles && data.videoFiles.length > 0) {
                        resDiv.className = 'success';
                        resDiv.innerHTML = \`📦 <b>Trovati \${data.videoFiles.length} file video nel Pack</b><br><small>\${data.torrentName} — Inserisci gli ID IMDb o cerca i titoli qui sotto, poi clicca <b>Salva & Importa Pack Film</b>.</small>\`;
                        dbg.innerText = 'File recuperati. Completa la mappatura e salva.';

                        // Auto-select detected specs
                        if (data.detectedSpecs) {
                            if (specs.audioLanguages.length === 0 && data.detectedSpecs.audioLanguages) {
                                data.detectedSpecs.audioLanguages.forEach(l => {
                                    document.querySelector(\`#audioLangChips .chip-btn[data-val="\${l}"]\`)?.classList.add('active');
                                });
                            }
                        }

                        initMoviePackMappingUI(data.videoFiles, data.torrentName, {
                            infoHash: data.infoHash,
                            torrentName: data.torrentName,
                            totalSize: data.totalSize,
                            magnetLink,
                            torrentBase64,
                            mode,
                            rdKey,
                            tbKey,
                            seedersVal
                        });
                    } else {
                        resDiv.className = 'error';
                        resDiv.innerText = 'Errore: ' + (data.error || 'Nessun file video trovato nel torrent');
                        dbg.innerText = 'Problema riscontrato.';
                    }
                } else if (isManualMappingMode) {
                    // ✅ MANUAL MAPPING: Preview files only (NO DB import)
                    dbg.innerText = 'Recupero file dal torrent...';
                    const formData = new FormData();
                    formData.append('method', mode);
                    if (rdKey) formData.append('rdKey', rdKey);
                    if (tbKey) formData.append('tbKey', tbKey);
                    if (torrentBase64) {
                        formData.append('torrentFileBase64', torrentBase64);
                    } else {
                        formData.append('magnetLink', magnetLink);
                    }

                    const response = await fetch('/scrape/preview-files', {
                        method: 'POST',
                        body: formData
                    });

                    const data = await response.json();
                    resDiv.style.display = 'block';

                    if (response.ok && data.videoFiles && data.videoFiles.length > 0) {
                        resDiv.className = 'success';
                        resDiv.innerHTML = \`📁 <b>Trovati \${data.videoFiles.length} file video</b><br><small>\${data.torrentName} — Seleziona la stagione e collega le puntate, poi clicca <b>Salva Mappatura</b> per importare.</small>\`;
                        dbg.innerText = 'File recuperati. Collega le puntate e salva.';

                        // If backend detected specs and frontend specs are auto/empty, auto-select them
                        if (data.detectedSpecs) {
                            if (specs.audioLanguages.length === 0 && data.detectedSpecs.audioLanguages) {
                                data.detectedSpecs.audioLanguages.forEach(l => {
                                    document.querySelector(\`#audioLangChips .chip-btn[data-val="\${l}"]\`)?.classList.add('active');
                                });
                            }
                        }

                        // ✅ Store preview for later import by saveMappingBtn
                        pendingPreview = {
                            infoHash: data.infoHash,
                            torrentName: data.torrentName,
                            totalSize: data.totalSize,
                            magnetLink,
                            torrentBase64,
                            imdbId,
                            tmdbId: currentTmdbId,
                            typeVal,
                            seedersVal,
                            rdKey,
                            tbKey,
                            mode,
                            specs: getSelectedSpecs()
                        };

                        await initMappingUI({
                            infoHash: data.infoHash,
                            imdbId: imdbId,
                            tmdbId: currentTmdbId,
                            videoFiles: data.videoFiles
                        });
                    } else {
                        resDiv.className = 'error';
                        resDiv.innerText = 'Errore: ' + (data.error || 'Nessun file video trovato nel torrent');
                        dbg.innerText = 'Problema riscontrato.';
                    }
                } else {
                    // ✅ NORMAL FLOW: Import directly
                    // 💜 Ask contributor name
                    const contributorName = await askContributorName();
                    if (contributorName === null) { btn.disabled = false; btn.innerText = btnLabel; return; }

                    const formData = new FormData();
                    formData.append('method', mode);
                    formData.append('imdbId', imdbId);
                    if (currentTmdbId) formData.append('tmdbId', currentTmdbId);
                    formData.append('type', typeVal);
                    formData.append('manualMapping', 'false');
                    formData.append('contributor', contributorName || '');
                    if (seedersVal) formData.append('seeders', seedersVal);
                    if (rdKey) formData.append('rdKey', rdKey);
                    if (tbKey) formData.append('tbKey', tbKey);
                    if (typeVal === 'pack') formData.append('forcePackMode', 'true');

                    // 🎛️ Media specs
                    if (specs.audioLanguages) formData.append('audioLanguages', JSON.stringify(specs.audioLanguages));
                    if (specs.subLanguages) formData.append('subLanguages', JSON.stringify(specs.subLanguages));
                    if (specs.resolution) formData.append('resolution', specs.resolution);
                    if (specs.quality) formData.append('quality', specs.quality);
                    if (specs.codec) formData.append('codec', specs.codec);
                    if (specs.visualTags) formData.append('visualTags', JSON.stringify(specs.visualTags));
                    if (specs.audioTags) formData.append('audioTags', JSON.stringify(specs.audioTags));

                    if (torrentBase64) {
                        formData.append('torrentFileBase64', torrentBase64);
                    } else {
                        formData.append('magnetLink', magnetLink);
                    }

                    dbg.innerText = 'Invio dati al server...';
                    const response = await fetch('/scrape/add', {
                        method: 'POST',
                        body: formData
                    });

                    const data = await response.json();
                    resDiv.style.display = 'block';

                    if (response.ok) {
                        resDiv.className = 'success';
                        resDiv.innerHTML = '⚡ <b>Importazione Completata</b><br><small>' + data.torrent.title + ' è stato aggiunto con successo.</small>';
                        dbg.innerText = 'Operazione terminata.';
                    } else {
                        resDiv.className = 'error';
                        resDiv.innerText = 'Errore: ' + (data.error || 'Si è verificato un errore imprevisto');
                        dbg.innerText = 'Problema riscontrato.';
                    }
                }
            } catch (err) {
                resDiv.style.display = 'block';
                resDiv.className = 'error';
                resDiv.innerText = 'Errore di rete: ' + err.message;
                dbg.innerText = 'Connessione fallita.';
            } finally {
                btn.disabled = false;
                updateSubmitButtonText();
            }
        });
    </script>
</body>
</html>`);
});

// GET /manual/search (TMDB Proxy)
const TMDB_SEARCH_KEY = '5462f78469f3d80bf5201645294c16e4'; // User provided / code context

async function fetchTmdbSeasons(tmdbId) {
    const url = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_SEARCH_KEY}&language=it-IT`;
    const resp = await axios.get(url, { timeout: 5000 });
    const seasons = resp.data?.seasons || [];
    return seasons
        .filter(s => typeof s.season_number === 'number')
        .map(s => ({
            season_number: s.season_number,
            name: s.name || `Stagione ${s.season_number}`,
            episode_count: s.episode_count || 0
        }))
        .sort((a, b) => a.season_number - b.season_number);
}

async function fetchTmdbSeasonEpisodes(tmdbId, seasonNumber) {
    const url = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}?api_key=${TMDB_SEARCH_KEY}&language=it-IT`;
    const resp = await axios.get(url, { timeout: 5000 });
    const episodes = resp.data?.episodes || [];
    return episodes
        .filter(e => typeof e.episode_number === 'number')
        .map(e => ({
            episode_number: e.episode_number,
            name: e.name || `Episodio ${e.episode_number}`,
            overview: e.overview || '',
            air_date: e.air_date || null
        }))
        .sort((a, b) => a.episode_number - b.episode_number);
}

router.get('/search', async (req, res) => {
    const { q, type } = req.query;
    if (!q) return res.json({ results: [] });

    // TMDB uses 'tv' or 'movie'
    const tmdbType = (type === 'serie' || type === 'series' || type === 'tv') ? 'tv' : 'movie';

    try {
        console.log(`🔍 [MANUAL] Searching TMDB for: "${q}" (${tmdbType})`);
        const url = `https://api.themoviedb.org/3/search/${tmdbType}?api_key=${TMDB_SEARCH_KEY}&query=${encodeURIComponent(q)}&language=it-IT&include_adult=false`;

        const resp = await axios.get(url, { timeout: 5000 });

        if (resp.data && resp.data.results) {
            // Map TMDB results to common format
            const results = resp.data.results.map(r => ({
                id: 'tmdb:' + r.id, // Prefix to ensure it is treated as TMDB ID
                name: r.title || r.name,
                year: r.release_date ? r.release_date.split('-')[0] : (r.first_air_date ? r.first_air_date.split('-')[0] : 'N/A'),
                poster: r.poster_path ? `https://image.tmdb.org/t/p/w92${r.poster_path}` : 'https://via.placeholder.com/92x138?text=No+Img',
                type: tmdbType === 'tv' ? 'series' : 'movie'
            })).slice(0, 10); // Limit to 10 results

            return res.json({ results });
        }
        res.json({ results: [] });
    } catch (e) {
        console.error("❌ [MANUAL] Search Error:", e.message);
        res.status(500).json({ error: "Search failed" });
    }
});

// GET /scrape/tmdb/seasons - TMDB seasons list
router.get('/tmdb/seasons', async (req, res) => {
    const { tmdbId } = req.query;
    if (!tmdbId) return res.status(400).json({ error: 'Missing tmdbId' });

    try {
        const seasons = await fetchTmdbSeasons(tmdbId);
        return res.json({ seasons });
    } catch (e) {
        console.error('❌ [MANUAL] TMDB seasons error:', e.message);
        return res.status(500).json({ error: 'TMDB seasons fetch failed' });
    }
});

// GET /scrape/tmdb/season - TMDB episode list for a season
router.get('/tmdb/season', async (req, res) => {
    const { tmdbId, season } = req.query;
    if (!tmdbId || season === undefined) return res.status(400).json({ error: 'Missing tmdbId or season' });

    const seasonNumber = parseInt(season, 10);
    if (Number.isNaN(seasonNumber)) return res.status(400).json({ error: 'Invalid season number' });

    try {
        const episodes = await fetchTmdbSeasonEpisodes(tmdbId, seasonNumber);
        return res.json({ episodes });
    } catch (e) {
        console.error('❌ [MANUAL] TMDB season error:', e.message);
        return res.status(500).json({ error: 'TMDB season fetch failed' });
    }
});

// POST /scrape/automatch - Try existing logic to auto-map episodes
router.post('/automatch', async (req, res) => {
    try {
        const { infoHash, imdbId, type, files, manualMapping } = req.body || {};

        if (!infoHash || !imdbId || type !== 'series' || !Array.isArray(files)) {
            return res.status(400).json({ error: 'Missing or invalid infoHash, imdbId, type, or files' });
        }

        const filesToInsert = [];
        const unmatchedFiles = [];
        const processed = [];

        for (const file of files) {
            if (!file || !file.path) continue;
            if (!packFilesHandler.isVideoFile(file.path) || (file.bytes || 0) < 50 * 1024 * 1024) continue;

            const filename = file.path.split('/').pop();
            let parsed = packFilesHandler.parseSeasonEpisode(filename);
            const folderSeason = parseSeasonFromPath(file.path);

            if (folderSeason) {
                parsed = packFilesHandler.parseSeasonEpisode(filename, folderSeason);
            }

            let season = null;
            let episode = null;

            if (parsed) {
                season = parsed.season;
                episode = parsed.episode;
            } else {
                const simpleEpMatch = filename.match(/(?:\s-\s|Ep[\s.]*|E)(\d{1,3})(?![0-9])/i);
                if (simpleEpMatch && folderSeason) {
                    season = folderSeason;
                    episode = parseInt(simpleEpMatch[1], 10);
                }
            }

            if (!season || !episode) {
                unmatchedFiles.push({
                    id: file.id,
                    path: file.path,
                    bytes: file.bytes || 0,
                    filename
                });
                continue;
            }

            filesToInsert.push({
                info_hash: infoHash.toLowerCase(),
                file_index: file.id,
                title: filename,
                size: file.bytes || 0,
                imdb_id: imdbId,
                imdb_season: season,
                imdb_episode: episode
            });

            processed.push(filename);
        }

        if (filesToInsert.length > 0) {
            await dbHelper.insertEpisodeFiles(filesToInsert);
        }

        if (String(manualMapping).toLowerCase() === 'true') {
            await dbHelper.updateTorrentProvider(infoHash, 'Custom Manual');
        }

        return res.json({
            status: 'ok',
            matched: filesToInsert.length,
            unmatched: unmatchedFiles.length,
            unmatchedFiles,
            processed
        });
    } catch (err) {
        console.error('❌ [MANUAL] AutoMatch error:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// POST /scrape/preview-files - Fetch file list WITHOUT importing to DB
// Used by "Inizia Collegamento Puntate" to show files before actual import
router.post('/preview-files', upload.any(), async (req, res) => {
    console.log("📥 [MANUAL] POST /preview-files called");
    try {
        let {
            magnetLink,
            torrentFileBase64,
            rdKey: bodyRdKey,
            tbKey: bodyTbKey,
            method
        } = req.body;

        const userRdKey = bodyRdKey || DEFAULT_RD_KEY;
        const userTbKey = bodyTbKey || DEFAULT_TB_KEY;

        if (!magnetLink && !torrentFileBase64) {
            return res.status(400).json({ error: "Inserisci un Magnet Link o carica un file .torrent" });
        }

        let infoHash = null;
        let localFiles = null;
        let torrentName = null;

        // 1. Extract InfoHash
        if (torrentFileBase64) {
            try {
                const parsed = parseTorrentFile(torrentFileBase64);
                infoHash = parsed.infoHash.toLowerCase();
                localFiles = parsed.files;
                torrentName = parsed.filename;
            } catch (parseErr) {
                return res.status(400).json({ error: "File torrent corrotto: " + parseErr.message });
            }
        } else {
            infoHash = normalizeInfoHash(magnetLink);
            torrentName = extractDnFromMagnet(magnetLink);
        }

        if (!infoHash) {
            return res.status(400).json({ error: "Hash non valido" });
        }

        // 2. Check if already in DB
        const existingTorrent = await dbHelper.getTorrent(infoHash);
        if (existingTorrent) {
            const isCustom = existingTorrent.provider === 'Custom' || existingTorrent.provider === 'Custom Manual';
            if (!isCustom) {
                return res.status(409).json({
                    error: 'Torrent già presente nel database!',
                    detail: `Questo torrent (${infoHash}) è già stato importato.`
                });
            }
            // Custom/Custom Manual: allow preview for re-mapping
            console.log(`🔄 [MANUAL] Torrent ${infoHash.substring(0, 8)} exists as ${existingTorrent.provider}, allowing preview for re-mapping`);
        }

        // 3. Fetch files (NO DB save)
        let data = null;
        let providerUsed = "";

        if (localFiles && localFiles.length > 0) {
            data = { files: localFiles, filename: torrentName };
            providerUsed = "Local .torrent";
        } else {
            // 1. Try public cache first (itorrents, bitsearch, etc.)
            const cachedTorrent = await fetchTorrentFromCaches(infoHash);
            if (cachedTorrent) {
                data = { files: cachedTorrent.files, filename: cachedTorrent.filename };
                providerUsed = "Torrent Cache";
            }
            // 2. Try TB cache (fast, checkcached only)
            if (!data && userTbKey) {
                data = await fetchFilesFromTorboxCache(infoHash, userTbKey);
                if (data) providerUsed = "Torbox Cache";
            }
            // 3. Try RD
            if (!data && userRdKey) {
                try {
                    data = await fetchFilesFromRealDebrid(infoHash, userRdKey);
                    if (data) providerUsed = "Real-Debrid";
                } catch (e) { console.warn("RD preview failed:", e.message); }
            }
            // 4. Try TB create (fallback)
            if (!data && userTbKey) {
                try {
                    data = await fetchFilesFromTorboxCreate(infoHash, userTbKey);
                    if (data) providerUsed = "Torbox";
                } catch (e) { console.warn("TB preview failed:", e.message); }
            }
            // 5. Try DHT / WebTorrent fallback
            if (!data) {
                try {
                    data = await fetchTorrentFromDHT(infoHash, magnetLink);
                    if (data) providerUsed = "DHT";
                } catch (e) { console.warn("DHT preview failed:", e.message); }
            }
        }

        if (!data || !data.files || data.files.length === 0) {
            return res.status(400).json({ error: "Impossibile recuperare la lista file. Verifica il magnet/torrent e le chiavi API." });
        }

        // 4. Filter video files (same logic as /add)
        const videoFiles = [];
        for (const file of data.files) {
            if (!packFilesHandler.isVideoFile(file.path) || file.bytes < 50 * 1024 * 1024) continue;
            const filename = file.path.split('/').pop();
            let parsed = packFilesHandler.parseSeasonEpisode(filename);
            const folderSeason = parseSeasonFromPath(file.path);
            if (folderSeason) {
                parsed = packFilesHandler.parseSeasonEpisode(filename, folderSeason);
            }
            videoFiles.push({
                id: file.id,
                path: file.path,
                bytes: file.bytes || 0,
                filename,
                parsedSeason: parsed?.season || null,
                parsedEpisode: parsed?.episode || null
            });
        }

        if (videoFiles.length === 0) {
            return res.status(400).json({ error: "Nessun file video trovato nel torrent. Non è possibile procedere con il collegamento puntate." });
        }

        console.log(`✅ [MANUAL] Preview: ${videoFiles.length} video files found via ${providerUsed}`);

        const detectedSpecs = detectTorrentSpecs(data.filename || torrentName || (videoFiles[0] ? videoFiles[0].filename : ''));

        return res.json({
            status: 'preview',
            infoHash,
            torrentName: data.filename || torrentName || `Torrent-${infoHash.substr(0, 8)}`,
            videoFiles,
            totalSize: data.files.reduce((acc, f) => acc + (f.bytes || 0), 0),
            provider: providerUsed,
            detectedSpecs
        });

    } catch (err) {
        console.error("❌ [MANUAL] Preview error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// POST /scrape/map - Save manual episode mapping
router.post('/map', async (req, res) => {
    try {
        const { infoHash, imdbId, mappings, contributor } = req.body || {};
        if (!infoHash || !imdbId || !Array.isArray(mappings)) {
            return res.status(400).json({ error: 'Missing infoHash, imdbId, or mappings' });
        }

        let updated = 0;
        let failed = 0;

        for (const mapping of mappings) {
            const season = parseInt(mapping.season, 10);
            const episode = parseInt(mapping.episode, 10);
            const fileIndex = parseInt(mapping.file_index, 10);
            const filePath = mapping.file_path || '';
            const fileSize = mapping.file_size || null;

            if (!season || !episode || isNaN(fileIndex) || fileIndex < 0 || !filePath) {
                failed++;
                continue;
            }

            const ok = await dbHelper.updateTorrentFileInfo(
                infoHash,
                fileIndex,
                filePath,
                fileSize,
                { imdbId, season, episode },
                true // allowOverride: manual mapping can reassign files between episodes
            );

            if (ok) updated++;
            else failed++;
        }

        if (updated > 0) {
            await dbHelper.updateTorrentProvider(infoHash, 'Custom Manual');
            // 💜 Save contributor name
            if (contributor !== undefined) {
                await dbHelper.updateTorrentContributor(infoHash, (typeof contributor === 'string' ? contributor.trim() : '') || '');
            }
        }

        return res.json({ status: 'ok', updated, failed });
    } catch (err) {
        console.error('❌ [MANUAL] Mapping error:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// POST /scrape/add
router.post('/add', upload.any(), async (req, res) => {
    console.log("📥 [MANUAL] POST /add called");
    try {
        let { // ✅ Using let for modification
            method, // 'debrid' or 'nodebrid'
            magnetLink,
            torrentFileBase64,
            imdbId,
            tmdbId, // ✅ Capture TMDB ID
            type,
            rdKey: bodyRdKey,
            tbKey: bodyTbKey,
            seeders: bodySeeders,
            forcePackMode,
            manualMapping,
            contributor, // 💜 Contributor name
            audioLanguages,
            subLanguages,
            resolution,
            quality,
            codec,
            visualTags,
            audioTags,
            packMappings // 📦 Movie pack file mappings
        } = req.body;

        let parsedPackMappings = null;
        if (packMappings) {
            try {
                parsedPackMappings = typeof packMappings === 'string' ? JSON.parse(packMappings) : packMappings;
            } catch (_) {}
        }

        // ✅ HANDLE PACK MODE:
        // If type is 'pack', we treat it as 'movie' but enforce Force Pack Mode and allow NULL ID.
        if (type === 'pack') {
            console.log("📦 [MANUAL] Pack Mode selected. Forcing 'movie' type + forcePackMode=true");
            type = 'movie';
            forcePackMode = true;
            if (!imdbId) imdbId = null; // Normalize empty to null
        }

        // Ensure TMDB ID for catalog mapping when possible
        if (!tmdbId && imdbId && idConverter && typeof idConverter.imdbToTmdb === 'function') {
            try {
                const resolved = await idConverter.imdbToTmdb(imdbId);
                if (resolved && resolved.tmdbId) {
                    tmdbId = resolved.tmdbId;
                }
            } catch (e) {
                console.warn('⚠️ [MANUAL] TMDB resolve failed:', e.message);
            }
        }

        const userRdKey = bodyRdKey || DEFAULT_RD_KEY;
        const userTbKey = bodyTbKey || DEFAULT_TB_KEY;

        if ((!imdbId && !forcePackMode) || !type) {
            return res.status(400).json({ error: "Missing required fields: imdbId, type" });
        }

        if (!magnetLink && !torrentFileBase64) {
            return res.status(400).json({ error: "Either magnetLink or torrentFileBase64 is required" });
        }

        let infoHash = null;
        let localFiles = null; // Files parsed directly from .torrent file
        let torrentName = null;

        // 1. Extract InfoHash (from magnet OR from torrent file)
        if (torrentFileBase64) {
            console.log("📁 [MANUAL] Parsing uploaded .torrent file...");
            try {
                const parsed = parseTorrentFile(torrentFileBase64);
                infoHash = parsed.infoHash.toLowerCase();
                localFiles = parsed.files;
                torrentName = parsed.filename;
                console.log(`✅[MANUAL] Parsed torrent: ${torrentName}, hash: ${infoHash}, files: ${localFiles.length} `);
            } catch (parseErr) {
                return res.status(400).json({ error: "Failed to parse torrent file: " + parseErr.message });
            }
        } else {
            infoHash = normalizeInfoHash(magnetLink);
            torrentName = extractDnFromMagnet(magnetLink);
            if (torrentName) console.log(`🏷️ [MANUAL] Extracted name from magnet dn=: ${torrentName}`);
        }

        if (!infoHash) {
            return res.status(400).json({ error: "Invalid magnet/hash or corrupt torrent file" });
        }

        console.log(`🛠️ [MANUAL] Step 1: Checking DB for hash ${infoHash}...`);

        // ✅ DUPLICATE CHECK: moved here to cover ALL methods (cache, debrid, local)
        const existingTorrent = await dbHelper.getTorrent(infoHash);
        if (existingTorrent) {
            const isCustom = existingTorrent.provider === 'Custom' || existingTorrent.provider === 'Custom Manual';
            if (!isCustom) {
                console.warn(`⚠️ [MANUAL] Torrent ${infoHash} already exists in DB (${existingTorrent.provider}). Skipping.`);
                return res.status(409).json({
                    error: 'Torrent già presente nel database!',
                    detail: `Questo torrent (${infoHash}) è già stato importato.`
                });
            }
            // Custom/Custom Manual: allow re-import — clean old files first
            console.log(`🔄 [MANUAL] Torrent ${infoHash.substring(0, 8)} exists as ${existingTorrent.provider}, cleaning old files for re-import...`);
            await dbHelper.deleteFileInfo(infoHash);
        }

        console.log(`🛠️ [MANUAL] Step 2: Fetching files (Local → TB cache → RD → P2P cache → DHT → TB create)...`);

        // 2. Get Files — ordered from cheapest/least invasive to most invasive
        let data = null;
        let providerUsed = "";

        // (a) Local .torrent file — instant, no API calls
        if (localFiles && localFiles.length > 0) {
            data = { files: localFiles, filename: torrentName };
            providerUsed = "Local .torrent";
            console.log(`📁 [MANUAL] Using ${localFiles.length} files from uploaded torrent.`);
        }

        // (b) Torbox cache — 1 API call, read-only, no slot occupied
        if (!data && userTbKey) {
            console.log(`🛠️ [MANUAL] Trying Torbox cache (checkcached)...`);
            const tbCached = await fetchFilesFromTorboxCache(infoHash, userTbKey);
            if (tbCached && tbCached.files.length > 0) {
                data = tbCached;
                providerUsed = "Torbox (cache)";
                console.log(`✅ [MANUAL] TB cache hit.`);
            } else {
                console.log(`⚠️ [MANUAL] TB cache miss.`);
            }
        }

        // (c) Real-Debrid — addMagnet+info+delete (3 API calls, briefly occupies slot)
        if (!data && userRdKey) {
            try {
                console.log(`🛠️ [MANUAL] Trying Real-Debrid fetch...`);
                data = await fetchFilesFromRealDebrid(infoHash, userRdKey);
                providerUsed = "Real-Debrid";
                console.log(`✅ [MANUAL] RD success.`);
            } catch (e) { console.warn("RD Fetch failed:", e.message); }
        }

        // (d) P2P caches — public .torrent mirrors, no account needed
        if (!data) {
            console.log(`🌐 [MANUAL] Trying P2P torrent caches for ${infoHash}...`);
            const cachedTorrent = await fetchTorrentFromCaches(infoHash);
            if (cachedTorrent) {
                data = { files: cachedTorrent.files, filename: cachedTorrent.filename };
                providerUsed = "Torrent Cache (P2P)";
                console.log(`✅ [MANUAL] P2P cache hit.`);
            } else {
                console.log(`⚠️ [MANUAL] P2P cache miss.`);
            }
        }

        // (e) DHT / BitTorrent peers — talks directly to swarm via webtorrent
        if (!data) {
            console.log(`🛰️ [MANUAL] Trying DHT/peers fallback...`);
            const dhtResult = await fetchTorrentFromDHT(infoHash, magnetLink || null, 20000);
            if (dhtResult && dhtResult.files.length > 0) {
                data = { files: dhtResult.files, filename: dhtResult.filename };
                providerUsed = "DHT/Peers";
                console.log(`✅ [MANUAL] DHT hit.`);
            } else {
                console.log(`⚠️ [MANUAL] DHT miss/disabled.`);
            }
        }

        // (f) Torbox createtorrent — last resort, adds magnet to TB account
        if (!data && userTbKey) {
            try {
                console.log(`🛠️ [MANUAL] Last resort: Torbox createtorrent...`);
                data = await fetchFilesFromTorboxCreate(infoHash, userTbKey);
                providerUsed = "Torbox (createtorrent)";
                console.log(`✅ [MANUAL] TB createtorrent success.`);
            } catch (e) { console.warn("TB createtorrent failed:", e.message); }
        }

        console.log(`🛠️ [MANUAL] Step 3: Checking data result...`);

        if (!data || !data.files || data.files.length === 0) {
            if (torrentFileBase64) {
                return res.status(500).json({ error: "Torrent file empty or invalid." });
            } else {
                return res.status(400).json({ error: "Could not get file list. If you don't have RD/Torbox, please upload a .torrent file or ensure the magnet is in public caches." });
            }
        }

        console.log(`✅[MANUAL] Files from ${providerUsed}. Found ${data.files.length} files.`);

        // 3. Prepare Torrent Entry
        const totalSize = data.files.reduce((acc, f) => acc + (f.bytes || 0), 0);
        let preferredName = torrentName || data.filename;
        if (preferredName && /^[a-fA-F0-9]{32,40}/.test(preferredName)) {
            const alternative = (preferredName === torrentName) ? data.filename : torrentName;
            if (alternative && !(/^[a-fA-F0-9]{32,40}/.test(alternative))) {
                preferredName = alternative;
            }
        }
        let torrentTitle = preferredName || `Imported - ${infoHash.substr(0, 8)} `;

        // ✅ ENRICH CUSTOM TORRENT TITLE WITH USER-SELECTED MEDIA SPECS
        torrentTitle = enrichCustomTorrentTitle(torrentTitle, {
            audioLanguages,
            subLanguages,
            resolution,
            quality,
            codec,
            visualTags,
            audioTags
        });

        let finalSeeders = 100;
        if (bodySeeders !== undefined && bodySeeders !== '') {
            finalSeeders = parseInt(bodySeeders);
        } else {
            // ✅ AUTO-SEEDER CHECK: If no manual seeders provided, try to scrape DHT
            // This happens automatically on backend now
            try {
                console.log(`🔍[MANUAL] Auto - scraping seeders for ${infoHash}...`);
                const scrapedSeeders = await getSeedersFromDHT(infoHash, 3000); // 3s timeout for auto check
                console.log(`✅[MANUAL] Auto - scrape result: ${scrapedSeeders} seeders`);
                // If DHT returns 0, we fallback to 10? Or keep 0? User can override if they want.
                // Let's use scrape result if > 0, otherwise default to 10 to avoid "dead" look
                finalSeeders = scrapedSeeders > 0 ? scrapedSeeders : 10;
            } catch (e) {
                console.warn(`⚠️[MANUAL] Auto - scrape failed: ${e.message}, defaulting to 10`);
                finalSeeders = 10;
            }
        }

        const isManualMapping = String(manualMapping).toLowerCase() === 'true';
        const providerLabel = isManualMapping ? 'Custom Manual' : 'Custom';

        const torrentEntry = {
            info_hash: infoHash,  // snake_case required for batchInsertTorrents
            provider: providerLabel,
            title: torrentTitle,
            size: totalSize,
            type: type,
            seeders: finalSeeders,
            imdb_id: imdbId,
            tmdb_id: tmdbId || null, // ✅ Save to DB
            upload_date: new Date(),
            cached_rd: !!userRdKey,
            cached_tb: !!userTbKey,
            last_cached_check: new Date()
        };

        // 4. Insert Main Torrent
        await dbHelper.batchInsertTorrents([torrentEntry]);

        // 💜 Save contributor name if provided
        if (contributor !== undefined) {
            await dbHelper.updateTorrentContributor(infoHash, contributor.trim() || '');
        }

        // 5. Process Files & Episodes
        let processedFiles = [];
        let filesToInsert = [];
        let unmatchedFiles = [];
        let videoFiles = [];

        for (const file of data.files) {
            if (!packFilesHandler.isVideoFile(file.path) || file.bytes < 50 * 1024 * 1024) continue;

            const filename = file.path.split('/').pop();
            const videoMeta = {
                id: file.id,
                path: file.path,
                bytes: file.bytes || 0,
                filename,
                parsedSeason: null,
                parsedEpisode: null
            };
            videoFiles.push(videoMeta);

            // Try to parse S/E from FILENAME first
            let parsed = packFilesHandler.parseSeasonEpisode(filename);

            // If parsed season is missing or default (1), try to find real season in FOLDER path
            const folderSeason = parseSeasonFromPath(file.path);
            if (folderSeason) {
                // Rerun parse with confirmed folder season as default
                // or if raw parse failed, use folder season
                parsed = packFilesHandler.parseSeasonEpisode(filename, folderSeason);
            }

            // If series, require parsing. If movie, take valid video files.
            let season = null;
            let episode = null;

            if (type === 'series') {
                if (parsed) {
                    season = parsed.season;
                    episode = parsed.episode;
                } else {
                    // 🚀 EXTRA PARSE: Try matching " - 01" directly if season is known from folder
                    const simpleEpMatch = filename.match(/(?:\s-\s|Ep[\s.]*|E)(\d{1,3})(?![0-9])/i);
                    if (simpleEpMatch && folderSeason) {
                        season = folderSeason;
                        episode = parseInt(simpleEpMatch[1]);
                        console.log(`✅[MANUAL] Recovered S${season}E${episode} from folder ${folderSeason} + filename ${filename}`);
                    } else {
                        // Skip unparsable files for series
                        console.log(`⚠️[MANUAL] Skipping series file (no S/E found): ${file.path}`);
                        unmatchedFiles.push(videoMeta);
                        continue;
                    }
                }
            }

            videoMeta.parsedSeason = season;
            videoMeta.parsedEpisode = episode;

            // 📦 For movie packs: imdb_id will be null, matching happens later
            // For series: imdbId is the series ID, applied to all episodes
            const fileImdbId = (type === 'movie' && (data.files.length > 1 || forcePackMode === 'true')) ? null : imdbId;

            filesToInsert.push({
                info_hash: infoHash,
                file_index: file.id,
                title: filename,
                size: file.bytes,
                imdb_id: fileImdbId,
                imdb_season: season,
                imdb_episode: episode
            });

            processedFiles.push(filename);
        }

        // 6. Insert Files
        // ✅ ALIGNED WITH NORMAL FLOW:
        // - Series/pack serie → files table (insertEpisodeFiles)
        // - Pack film (multi-movie) → pack_files table (insertPackFiles)
        const isMultiMoviePack = (type === 'movie' && (data.files.length > 1 || forcePackMode === 'true'));

        if (filesToInsert.length > 0) {
            if (isManualMapping) {
                // 🗂️ MANUAL MAPPING: Skip auto-parsed file insertion — /scrape/map will handle it
                console.log(`🗂️ [MANUAL] ManualMapping=true → skipping insertEpisodeFiles (${filesToInsert.length} files). User mappings via /scrape/map.`);
            } else if (isMultiMoviePack) {
                // 📦 PACK FILM: Use pack_files table (with explicit user mappings if provided)
                let packFilesData;
                if (Array.isArray(parsedPackMappings) && parsedPackMappings.length > 0) {
                    packFilesData = parsedPackMappings.map(m => ({
                        pack_hash: infoHash.toLowerCase(),
                        imdb_id: (m.imdb_id && typeof m.imdb_id === 'string' && m.imdb_id.trim()) ? m.imdb_id.trim() : null,
                        file_index: parseInt(m.file_index, 10),
                        file_path: m.file_path,
                        file_size: m.file_size || 0
                    }));
                } else {
                    packFilesData = filesToInsert.map(f => ({
                        pack_hash: infoHash.toLowerCase(),
                        imdb_id: null, // Will be matched later when user searches specific movie
                        file_index: f.file_index,
                        file_path: f.title,
                        file_size: f.size || 0
                    }));
                }
                await dbHelper.insertPackFiles(packFilesData);
                console.log(`📦 [MANUAL] Saved ${packFilesData.length} files to pack_files table (${packFilesData.filter(p => p.imdb_id).length} with explicit IMDb IDs)`);
            } else {
                // 📺 SERIES or SINGLE MOVIE: Use files table
                await dbHelper.insertEpisodeFiles(filesToInsert);
                console.log(`📺 [MANUAL] Saved ${filesToInsert.length} files to files table`);
            }
        }

        return res.json({
            status: "success",
            message: `Imported ${filesToInsert.length} files for ${imdbId || 'pack'}`,
            torrent: torrentEntry,
            files: processedFiles,
            infoHash: infoHash,
            videoFiles,
            unmatchedFiles
        });

    } catch (err) {
        console.error("❌ Manual Import Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// DHT Scraper Helper
async function getSeedersFromDHT(infoHash, timeoutMs = 5000) {
    // Dynamic import for ESM module support in CJS
    const { default: DHT } = await import('bittorrent-dht');

    return new Promise((resolve) => {
        let dht;
        try {
            dht = new DHT();
        } catch (e) {
            console.warn(`⚠️ [DHT] Failed to create DHT instance: ${e.message}`);
            return resolve(0);
        }

        const peers = new Set();
        let resolved = false;

        // ✅ MEMORY FIX: Centralized cleanup to guarantee dht.destroy() is always called
        const cleanup = () => {
            if (!resolved) {
                resolved = true;
                try { dht.destroy(); } catch (_) {}
            }
        };

        // ✅ MEMORY FIX: Handle DHT errors (previously missing → leaked DHT instance on error)
        dht.on('error', (err) => {
            console.warn(`⚠️ [DHT] Error: ${err.message}`);
            cleanup();
            resolve(0);
        });

        dht.on('peer', (peer, hash) => {
            peers.add(`${peer.host}:${peer.port} `);
        });

        dht.listen(() => {
            const hashBuffer = Buffer.from(infoHash, 'hex');
            dht.lookup(hashBuffer);
        });

        setTimeout(() => {
            const count = peers.size;
            cleanup();
            resolve(count);
        }, timeoutMs);
    });
}

// POST /manual/scrape - Get seeders
router.post('/scrape', async (req, res) => {
    const { magnetLink, torrentFileBase64 } = req.body;
    let infoHash = null;

    try {
        if (torrentFileBase64) {
            const parsed = parseTorrentFile(torrentFileBase64);
            infoHash = parsed.infoHash;
        } else if (magnetLink) {
            infoHash = normalizeInfoHash(magnetLink);
        }

        if (!infoHash) return res.status(400).json({ error: "Invalid magnet or torrent file" });

        const seeders = await getSeedersFromDHT(infoHash);
        res.json({ seeders });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// GET /scrape/health-check — pinga TUTTI i provider scraping + addon esterni
// in parallelo e ritorna { results: [{ name, url, ok, status, ms, note }] }.
// Usato dalla UI (template.html → bottone "Esegui Test") per diagnosi rapida.
// Niente segreti nei URL: i base64 di Torrentio/Comet/Meteor sono pubblici
// (sono URL di configurazione, non auth token).
// ============================================================================
router.get('/health-check', async (req, res) => {
    // Lista provider: nome leggibile + URL da pingare + (opzionale) "ok if status in"
    // I JSON endpoint usano un titolo notorio (GoT S01E01) per validare la response.
    const TORRENTIO_PROXY_PATH = '/oResults=false/aHR0cHM6Ly90b3JyZW50aW8uc3RyZW0uZnVuL3Byb3ZpZGVycz15dHMsZXp0dixyYXJiZywxMzM3eCx0aGVwaXJhdGViYXksa2lja2Fzc3RvcnJlbnRzLHRvcnJlbnRnYWxheHksbWFnbmV0ZGwsaG9ycmlibGVzdWJzLG55YWFzaSx0b2t5b3Rvc2hvLGFuaWRleCxydXRvcixydXRyYWNrZXIsY29tYW5kbyxibHVkdix0b3JyZW50OSxpbGNvcnNhcm9uZXJvLG1lam9ydG9ycmVudCx3b2xmbWF4NGssY2luZWNhbGlkYWQsYmVzdHRvcnJlbnRzfGxhbmd1YWdlPWl0YWxpYW58cXVhbGl0eWZpbHRlcj1zY3IsY2Ft';
    const COMET_B64 = 'eyJtYXhSZXN1bHRzUGVyUmVzb2x1dGlvbiI6MCwibWF4U2l6ZSI6MCwiY2FjaGVkT25seSI6ZmFsc2UsInNvcnRDYWNoZWRVbmNhY2hlZFRvZ2V0aGVyIjpmYWxzZSwicmVtb3ZlVHJhc2giOnRydWUsInJlc3VsdEZvcm1hdCI6WyJhbGwiXSwiZGVicmlkU2VydmljZXMiOltdLCJlbmFibGVUb3JyZW50Ijp0cnVlLCJkZWR1cGxpY2F0ZVN0cmVhbXMiOmZhbHNlLCJzY3JhcGVEZWJyaWRBY2NvdW50VG9ycmVudHMiOmZhbHNlLCJkZWJyaWRTdHJlYW1Qcm94eVBhc3N3b3JkIjoiIiwibGFuZ3VhZ2VzIjp7InJlcXVpcmVkIjpbIml0Il0sImFsbG93ZWQiOlsibXVsdGkiLCJpdCJdLCJleGNsdWRlIjpbImVuIiwiamEiLCJ6aCIsInJ1IiwiYXIiLCJwdCIsImVzIiwiZnIiLCJkZSIsImtvIiwiaGkiLCJibiIsInBhIiwibXIiLCJndSIsInRhIiwidGUiLCJrbiIsIm1sIiwidGgiLCJ2aSIsImlkIiwidHIiLCJoZSIsImZhIiwidWsiLCJlbCIsImx0IiwibHYiLCJldCIsInBsIiwiY3MiLCJzayIsImh1Iiwicm8iLCJiZyIsInNyIiwiaHIiLCJzbCIsIm5sIiwiZGEiLCJmaSIsInN2Iiwibm8iLCJtcyIsImxhIl0sInByZWZlcnJlZCI6WyJpdCJdfSwicmVzb2x1dGlvbnMiOnsicjI0MHAiOmZhbHNlfSwib3B0aW9ucyI6eyJyZW1vdmVfcmFua3NfdW5kZXIiOi0xMDAwMDAwMDAwMCwiYWxsb3dfZW5nbGlzaF9pbl9sYW5ndWFnZXMiOmZhbHNlLCJyZW1vdmVfdW5rbm93bl9sYW5ndWFnZXMiOmZhbHNlfX0=';
    const MEDIAFUSION_B64 = 'D--MuTCQ99t0sh23nd3nx2xZCCqMkr4MPwy5I9suo3Ej2tUYTqimnxZBJ34hbNRwoL5AIvPt4N8KPnl50LWHT5YLDcrwnX_dhOq3vHO0aCNKBlnXeki7olZAUDoHepPCTDFLFtZVcZcohYRa83aT2Vbig3W5Qz3qErPqw2Zdb676ioZa452Mb35T0IX-ftQcNF0oGJerUTZhfvv9w4wrEIiW8wx0jdSxAfcrnM6yKFEcYMP-3dRWYAL2wy13Gcvwr2j4ax2z6TQ35xlcW9WWsKjA';
    const STREMTHRU_B64 = 'eyJpbmRleGVycyI6bnVsbCwic3RvcmVzIjpbeyJjIjoicDJwIiwidCI6IiJ9XSwiZmlsdGVyIjoiXCJpdFwiIGluIExhbmd1YWdlcyBcdTAwMjZcdTAwMjYgUXVhbGl0eSAhPSBcIkNBTVwiIn0=';
    const METEOR_B64 = 'eyJkZWJyaWRTZXJ2aWNlIjoidG9ycmVudCIsImRlYnJpZEFwaUtleSI6IiIsImNhY2hlZE9ubHkiOnRydWUsImVuYWJsZVlvdXJNZWRpYSI6ZmFsc2UsInlvdXJNZWRpYUxlZ2FjeU1vZGUiOmZhbHNlLCJzaG93WW91ck1lZGlhU3RyZWFtcyI6ZmFsc2UsInlvdXJNZWRpYVNvdXJjZXMiOlsidG9ycmVudCJdLCJyZW1vdmVUcmFzaCI6ZmFsc2UsInJlbW92ZVNhbXBsZXMiOmZhbHNlLCJyZW1vdmVBZHVsdCI6ZmFsc2UsImV4Y2x1ZGUzRCI6ZmFsc2UsImVuYWJsZVNlYURleCI6ZmFsc2UsImVuYWJsZVVzZW5ldCI6ZmFsc2UsInVzZW5ldEN1c3RvbUVuZ2luZXMiOmZhbHNlLCJtaW5TZWVkZXJzIjowLCJtYXhSZXN1bHRzIjowLCJtYXhSZXN1bHRzUGVyUmVzIjowLCJtYXhTaXplIjowLCJyZXNvbHV0aW9ucyI6W10sImxhbmd1YWdlcyI6eyJwcmVmZXJyZWQiOlsibXVsdGkiLCJpdCJdLCJyZXF1aXJlZCI6WyJpdCIsIm11bHRpIl0sImV4Y2x1ZGUiOltdfSwicmVzdWx0Rm9ybWF0IjpbInRpdGxlIiwicXVhbGl0eSIsInNpemUiLCJhdWRpbyJdLCJzb3J0T3JkZXIiOlsicGFjayIsImNhY2hlZCIsInlvdXJtZWRpYSIsInNlYWRleCIsInJlc29sdXRpb24iLCJzaXplIiwicXVhbGl0eSIsInNlZWRlcnMiLCJsYW5ndWFnZSIsInR5cGUiXX0';

    const trio = (host) => `https://${host}.stremio-italia.eu${TORRENTIO_PROXY_PATH}/stream/series/tt0944947:1:1.json`;

    const providers = [
        // === Scrapers HTML/API pubblici ===
        { name: '🏴‍☠️ apibay (TPB)',     url: 'https://apibay.org/q.php?q=test',                                      validate: (b) => Array.isArray(JSON.parse(b)) },
        { name: '🎬 YTS (yts.am)',        url: 'https://yts.am/api/v2/list_movies.json?query_term=test&limit=1',       validate: (b) => JSON.parse(b)?.status === 'ok' },
        { name: '📺 EZTV',                url: 'https://eztvx.to/api/get-torrents?imdb_id=tt0944947&limit=1',          validate: (b) => 'torrents_count' in JSON.parse(b) },
        { name: '🟢 SolidTorrents',       url: 'https://solidtorrents.to/api/v1/search?q=test&limit=1',                expectStatus: [200, 301] },
        { name: '🔎 Bitsearch (.eu)',     url: 'https://bitsearch.eu/search?q=test' },
        { name: '🛰️ DHTIndex',            url: 'https://dhtindex.org/search?q=test',                                   validate: (b) => /\/torrent\/[a-f0-9]{40}/.test(b) },
        { name: '🦉 Knaben',              url: 'https://knaben.org' },
        { name: '🌌 TorrentGalaxy (.one)', url: 'https://torrentgalaxy.one/get-posts/keywords:test:format:json',        validate: (b) => { const j = JSON.parse(b); return Array.isArray(j) || Array.isArray(j.posts) || Array.isArray(j.results); } },
        // === Cache .torrent file (per recupero file list) ===
        { name: '📦 itorrents.net',        url: 'https://itorrents.net' },
        // === Addon Stremio esterni (URL completi con config base64) ===
        { name: '🅣 Torrentio mirror 1',  url: trio('torrentioita'),  validate: (b) => 'streams' in JSON.parse(b) },
        { name: '🅣 Torrentio mirror 2',  url: trio('torrentioita2'), validate: (b) => 'streams' in JSON.parse(b) },
        { name: '🅣 Torrentio mirror 3',  url: trio('torrentioita3'), validate: (b) => 'streams' in JSON.parse(b) },
        { name: '🅜 MediaFusion',         url: `https://mediafusionfortheweebs.midnightignite.me/${MEDIAFUSION_B64}/stream/series/tt0944947:1:1.json`, validate: (b) => 'streams' in JSON.parse(b) },
        { name: '🅒 Comet',               url: `https://comet.feels.legal/${COMET_B64}/stream/series/tt0944947:1:1.json`, validate: (b) => 'streams' in JSON.parse(b) },
        { name: '🆂 StremThru Torz',       url: `https://stremthru.13377001.xyz/stremio/torz/${STREMTHRU_B64}/stream/series/tt0944947:1:1.json`, validate: (b) => 'streams' in JSON.parse(b) },
        { name: '☄️ Meteor',              url: `https://meteorfortheweebs.midnightignite.me/${METEOR_B64}/stream/series/tt0944947:1:1.json`, validate: (b) => 'streams' in JSON.parse(b) },
        // === Debrid API ===
        { name: '👑 Real-Debrid API',     url: 'https://api.real-debrid.com/rest/1.0/time' },
        { name: '📦 TorBox API',          url: 'https://api.torbox.app/v1/api/torrents/createtorrent', expectStatus: [200, 401, 403, 405] },
    ];

    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    async function checkOne(p) {
        const t0 = Date.now();
        try {
            const resp = await axios.get(p.url, {
                timeout: 10000,
                headers: { 'User-Agent': ua, 'Accept': '*/*' },
                validateStatus: () => true,            // non lanciare su 4xx/5xx, ci pensiamo noi
                maxRedirects: 3,
                responseType: 'text',                  // ci basta il body come stringa
                transformResponse: [(d) => d]          // disabilita parsing automatico axios
            });
            const ms = Date.now() - t0;
            const status = resp.status;
            let ok = false;
            let note = '';

            // expectStatus override (es. TorBox 405 al GET = endpoint vivo)
            if (Array.isArray(p.expectStatus)) {
                ok = p.expectStatus.includes(status);
                if (!ok) note = `status non in [${p.expectStatus.join(',')}]`;
            } else if (typeof p.validate === 'function') {
                if (status >= 200 && status < 400) {
                    try {
                        ok = !!p.validate(typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data));
                        if (!ok) note = 'response body inattesa';
                    } catch (e) {
                        ok = false;
                        note = 'parse fail: ' + e.message.substring(0, 60);
                    }
                } else {
                    note = 'HTTP error';
                }
            } else {
                ok = status >= 200 && status < 400;
                if (!ok) note = 'HTTP error';
            }
            return { name: p.name, url: p.url.split('?')[0], ok, status, ms, note };
        } catch (e) {
            const ms = Date.now() - t0;
            const msg = e.code === 'ENOTFOUND' ? 'DNS non risolve' :
                        e.code === 'ECONNREFUSED' ? 'connessione rifiutata' :
                        (e.code === 'ECONNABORTED' || /timeout/i.test(e.message || '')) ? 'timeout' :
                        (e.message || 'errore').substring(0, 80);
            return { name: p.name, url: p.url.split('?')[0], ok: false, status: 0, ms, note: msg };
        }
    }

    try {
        // Tutto in parallelo — ognuno ha timeout interno 10s
        const results = await Promise.all(providers.map(checkOne));
        // Tronca URL lunghi nella response (per leggibilità nella tabella)
        for (const r of results) {
            if (r.url.length > 80) r.url = r.url.substring(0, 60) + '...' + r.url.substring(r.url.length - 17);
        }
        res.json({ results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// JSON error handler so multer/body-parser failures don't leak HTML to fetch callers
router.use((err, req, res, next) => {
    if (!err) return next();
    const isMulter = err && (err.name === 'MulterError' || typeof err.code === 'string' && err.code.startsWith('LIMIT_'));
    const status = isMulter ? 413 : 500;
    console.error(`❌ [MANUAL] Route error (${err.code || err.name || 'Error'}):`, err.message);
    if (res.headersSent) return next(err);
    res.status(status).json({ error: err.message || 'Errore interno', code: err.code || null });
});

module.exports = router;
