// =============================================================================
// 🌐 PUBLIC TRACKERS — Provider torrent pubblici (FASE 1 del refactor scraper)
// =============================================================================
//
// Provider inclusi (5):
//   - apibay     (The Pirate Bay JSON)     — catch-all, no rate-limit serio
//   - YTS        (yts.mx JSON)             — solo film, single call
//   - EZTV       (eztvx.to JSON)           — solo serie, lookup per imdbId
//   - Solid      (solidtorrents.to JSON)   — rate-limit aggressivo (60s su 429)
//   - Bitsearch  (bitsearch.to HTML)       — regex scrape, 120s su 429
//
// Tutti normalizzano l'output al formato che `api/index.js` consuma per il
// merger (`allRawResults.push(...)` style, vedi fetchKnabenData per riferimento).
//
// Pattern condivisi:
//   - LRU cache 30min, max 1000 entry, no-cache su risultati vuoti
//   - Cooldown per-provider su 429/timeout
//   - Min-interval rate-limiter per Solid/Bitsearch (max 1 req / 2s)
//   - Query builder unificato `buildPublicTrackerQueries(metadata, parsedId, type)`
//     che riproduce il pattern doppio "base + base ita" che usiamo già per Knaben
//
// FASE 2 (futuro): migrare Corsaro/Knaben/TorrentGalaxy/UIndex/Jackett qui
// stesso, in moduli per-provider con helper condivisi in scraper-utils.js
// =============================================================================

const fetch = require('node-fetch');

// -----------------------------------------------------------------------------
// Util di base (duplicate-on-purpose: il modulo deve restare self-contained
// per evitare cicli di import con index.js)
// -----------------------------------------------------------------------------

const DEBUG_MODE = process.env.DEBUG_MODE === 'true' || process.env.NODE_ENV === 'development';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Tracker pubblici per ricostruire magnet "trackerless" — stessa lista usata
// dal path DB rehydrate in index.js (DB_TRACKERS) per coerenza.
const PUBLIC_TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.tiny-vps.com:6969/announce',
    'udp://open.demonii.com:1337/announce',
];

function magnetFromHash(hash, name) {
    const trackers = PUBLIC_TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
    const dn = name ? `&dn=${encodeURIComponent(name)}` : '';
    return `magnet:?xt=urn:btih:${hash}${dn}${trackers}`;
}

// Parsing dimensione "1.5 GB" → bytes. Idempotente con il parseSize di index.js.
function parseSizeToBytes(sizeStr) {
    if (!sizeStr || typeof sizeStr !== 'string') return 0;
    const match = sizeStr.match(/([\d.,]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)/i);
    if (!match) return 0;
    const value = parseFloat(match[1].replace(',', '.'));
    const unit = match[2].toUpperCase();
    const mult = { B: 1, KB: 1024, KIB: 1024, MB: 1024 ** 2, MIB: 1024 ** 2, GB: 1024 ** 3, GIB: 1024 ** 3, TB: 1024 ** 4, TIB: 1024 ** 4 };
    return Math.round(value * (mult[unit] || 1));
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Rilevazione lingua semplice — index.js ha una versione più ricca
// (`getLanguageInfo`), ma per popolare i metadata di base ci basta questo.
// Il merger in index.js poi rifà comunque il check completo.
function isItalianTitle(title) {
    if (!title) return false;
    return /\b(ita|italian|sub[.\s]?ita|nuita|multi)\b/i.test(title);
}

// Estrazione qualità basica (1080p, 720p, 2160p, ecc.)
function extractQualityBasic(title) {
    if (!title) return '';
    const m = title.match(/\b(2160p|4k|1080p|720p|480p|360p|cam|ts|hdrip|bdrip|webrip|web-dl|bluray|dvdrip)\b/i);
    return m ? m[1].toLowerCase() : '';
}

// Pulizia query: NFD per togliere accenti, normalizza spazi/punti
function cleanQuery(s) {
    if (!s) return '';
    return s
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')   // strip combining marks
        .replace(/[.…]+/g, ' ')
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// -----------------------------------------------------------------------------
// LRU cache condivisa (30 min, 1000 entry max)
// Non cachiamo risultati vuoti (probabili 429/timeout transienti).
// -----------------------------------------------------------------------------

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 1000;
const queryCache = new Map();

function cacheGet(key) {
    const e = queryCache.get(key);
    if (!e) return null;
    if (Date.now() - e.t > CACHE_TTL_MS) {
        queryCache.delete(key);
        return null;
    }
    queryCache.delete(key);
    queryCache.set(key, e); // refresh LRU position
    return e.v;
}

function cacheSet(key, value) {
    if (queryCache.size >= CACHE_MAX) {
        const firstKey = queryCache.keys().next().value;
        queryCache.delete(firstKey);
    }
    queryCache.set(key, { v: value, t: Date.now() });
}

async function cached(key, fn) {
    const hit = cacheGet(key);
    if (hit !== null) return hit;
    const v = await fn();
    if (Array.isArray(v) && v.length > 0) cacheSet(key, v);
    return v;
}

// -----------------------------------------------------------------------------
// Cooldown per-provider (su 429 / errori ripetuti)
// -----------------------------------------------------------------------------

const cooldowns = new Map();

function isOnCooldown(provider) {
    const until = cooldowns.get(provider);
    return until && Date.now() < until;
}

function setCooldown(provider, seconds) {
    cooldowns.set(provider, Date.now() + seconds * 1000);
    if (DEBUG_MODE) console.log(`⏸️  [${provider}] cooldown for ${seconds}s`);
}

// -----------------------------------------------------------------------------
// Rate-limiter min-interval per-provider (es. Solid/Bitsearch: max 1 req/2s)
// Implementato come coda seriale per provider — se due richieste partono insieme,
// la seconda aspetta che sia trascorso l'intervallo minimo dall'inizio della prima.
// -----------------------------------------------------------------------------

const lastCallAt = new Map();      // provider → timestamp ultima chiamata avviata
const callQueues = new Map();      // provider → Promise chain (mutex seriale)

function rateLimited(provider, minIntervalMs, fn) {
    const prev = callQueues.get(provider) || Promise.resolve();
    const next = prev.then(async () => {
        const last = lastCallAt.get(provider) || 0;
        const waitMs = minIntervalMs - (Date.now() - last);
        if (waitMs > 0) {
            await new Promise(res => setTimeout(res, waitMs));
        }
        lastCallAt.set(provider, Date.now());
        return fn();
    }).catch(err => {
        // Non propaghiamo l'errore alla chain (altrimenti rompe le richieste future)
        if (DEBUG_MODE) console.warn(`[${provider}] rate-limited call failed:`, err.message);
        return [];
    });
    callQueues.set(provider, next.then(() => {}, () => {}));
    return next;
}

// -----------------------------------------------------------------------------
// Fetch helper con timeout (AbortController)
// -----------------------------------------------------------------------------

async function fetchWithTimeout(url, opts = {}, timeoutMs = 6000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            ...opts,
            headers: { 'User-Agent': UA, ...(opts.headers || {}) },
            signal: controller.signal,
        });
        return res;
    } finally {
        clearTimeout(timeoutId);
    }
}

// -----------------------------------------------------------------------------
// Query builder unificato
//
// Input:
//   metadata = { title, primaryTitle?, italianTitle?, year?, ... }
//   parsedId = { season?, episode? } | null
//   type     = 'movie' | 'series' | 'anime'
//
// Output: array di stringhe query, già "pulite" (NFD, no accenti).
// Pattern: per ogni titolo significativo, doppia query base + "ita".
// -----------------------------------------------------------------------------

function buildPublicTrackerQueries(metadata, parsedId, type) {
    const titles = new Set();
    if (metadata?.primaryTitle) titles.add(metadata.primaryTitle);
    if (metadata?.title) titles.add(metadata.title);
    if (metadata?.italianTitle) titles.add(metadata.italianTitle);
    if (metadata?.titles && Array.isArray(metadata.titles)) {
        for (const t of metadata.titles) if (t) titles.add(t);
    }
    if (titles.size === 0 && metadata?.searchQuery) titles.add(metadata.searchQuery);

    const queries = new Set();

    const season = parsedId?.season || metadata?.season;
    const episode = parsedId?.episode || metadata?.episode;
    const year = metadata?.year;

    for (const rawTitle of titles) {
        const t = cleanQuery(rawTitle);
        if (!t) continue;

        if (type === 'series' || type === 'anime') {
            if (season && episode) {
                const s = String(season).padStart(2, '0');
                const e = String(episode).padStart(2, '0');
                queries.add(`${t} S${s}E${e}`);
                queries.add(`${t} S${s}E${e} ita`);
            } else if (season) {
                const s = String(season).padStart(2, '0');
                queries.add(`${t} S${s}`);
                queries.add(`${t} S${s} ita`);
            } else {
                queries.add(t);
                queries.add(`${t} ita`);
            }
        } else {
            // movie
            if (year) {
                queries.add(`${t} ${year}`);
                queries.add(`${t} ${year} ita`);
            } else {
                queries.add(t);
                queries.add(`${t} ita`);
            }
        }
    }

    return [...queries];
}

// -----------------------------------------------------------------------------
// Output normalizer — formato compatibile con `allRawResults.push(...)`
// di index.js (vedi fetchKnabenData per riferimento esatto).
// -----------------------------------------------------------------------------

function normalizeResult({ title, infoHash, sizeBytes, seeders, leechers, source, magnetLink }) {
    if (!infoHash || infoHash.length < 32) return null;
    const hashLower = infoHash.toLowerCase();
    const cleanTitle = (title || '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
    return {
        magnetLink: magnetLink || magnetFromHash(hashLower, cleanTitle),
        downloadUrl: null,
        websiteTitle: cleanTitle,
        title: cleanTitle,
        filename: cleanTitle,
        quality: extractQualityBasic(cleanTitle),
        size: sizeBytes ? formatBytes(sizeBytes) : 'Unknown',
        source,
        seeders: Number(seeders) || 0,
        leechers: Number(leechers) || 0,
        infoHash: hashLower.toUpperCase(),       // match formato Knaben (uppercase)
        mainFileSize: Number(sizeBytes) || 0,    // ✅ campo letto da index.js per DB save
        sizeInBytes: Number(sizeBytes) || 0,     // alias di compatibilità
        pubDate: new Date().toISOString(),
        // marker provider per dedup/filtri downstream
        italian: isItalianTitle(cleanTitle),
    };
}

// =============================================================================
// PROVIDER 1: apibay (The Pirate Bay JSON) — catch-all, no rate limit serio
// =============================================================================

const APIBAY_TIMEOUT_MS = 6000;

async function searchApibaySingle(query) {
    if (isOnCooldown('apibay')) return [];
    return cached(`apibay:${query}`, async () => {
        try {
            const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`;
            const res = await fetchWithTimeout(url, {}, APIBAY_TIMEOUT_MS);
            if (res.status === 429) { setCooldown('apibay', 60); return []; }
            if (!res.ok) return [];
            const data = await res.json();
            if (!Array.isArray(data) || data[0]?.name === 'No results returned') return [];
            const out = [];
            for (const r of data) {
                if (!r.info_hash || r.info_hash === '0000000000000000000000000000000000000000') continue;
                const item = normalizeResult({
                    title: r.name,
                    infoHash: r.info_hash,
                    sizeBytes: Number(r.size) || 0,
                    seeders: r.seeders,
                    leechers: r.leechers,
                    source: 'apibay (TPB)',
                });
                if (item) out.push(item);
            }
            return out;
        } catch (e) {
            if (DEBUG_MODE) console.warn(`[apibay] ${e.message}`);
            return [];
        }
    });
}

/**
 * Cerca su apibay con pattern doppio (base + "ita") già incorporato nel
 * query builder. `queries` può essere passato direttamente, oppure
 * costruito da metadata/parsedId/type.
 */
async function searchApibay({ queries, metadata, parsedId, type }) {
    const qs = queries || buildPublicTrackerQueries(metadata, parsedId, type);
    if (!qs.length) return [];
    const buckets = await Promise.all(qs.map(q => searchApibaySingle(q)));
    return dedupeByHash(buckets.flat());
}

// =============================================================================
// PROVIDER 2: YTS (JSON) — solo FILM
// Host con fallback: yts.am (mirror ufficiale attivo) → yts.mx (DNS-fail su molti server) → yts.lu (301 verso homepage, API non disponibile)
// Override via env YTS_HOST.
// =============================================================================

const YTS_TIMEOUT_MS = 6000;
const YTS_HOSTS = process.env.YTS_HOST
    ? [process.env.YTS_HOST]
    : ['yts.am', 'yts.mx'];

async function fetchYTSMovies(query) {
    let lastErr = null;
    for (const host of YTS_HOSTS) {
        try {
            const url = `https://${host}/api/v2/list_movies.json?query_term=${query}&limit=20`;
            const res = await fetchWithTimeout(url, { redirect: 'follow' }, YTS_TIMEOUT_MS);
            if (res.status === 429) { setCooldown('yts', 60); return { movies: [] }; }
            if (res.status === 403) {
                if (DEBUG_MODE) console.warn(`[YTS] 403 da ${host}, fallback...`);
                continue;
            }
            if (!res.ok) { lastErr = `${host}: status ${res.status}`; continue; }
            const data = await res.json();
            return { movies: data?.data?.movies || [] };
        } catch (e) {
            lastErr = `${host}: ${e.message}`;
            if (DEBUG_MODE) console.warn(`[YTS] ${lastErr}, fallback...`);
        }
    }
    if (DEBUG_MODE && lastErr) console.warn(`[YTS] tutti gli host falliti — ultimo: ${lastErr}`);
    return { movies: [] };
}

async function searchYTS({ metadata }) {
    if (isOnCooldown('yts')) return [];
    if (!metadata?.title) return [];
    const key = `yts:${metadata.title}:${metadata.year || ''}`;
    return cached(key, async () => {
        try {
            const q = encodeURIComponent(metadata.title);
            const { movies } = await fetchYTSMovies(q);
            const target = (metadata.title || '').toLowerCase().split(' ')[0];
            const out = [];
            for (const m of movies) {
                if (metadata.year && m.year && String(m.year) !== String(metadata.year)) continue;
                if (target && !(m.title_long || '').toLowerCase().includes(target)) continue;
                for (const t of (m.torrents || [])) {
                    if (!t.hash) continue;
                    const title = `${m.title_long} ${t.quality || ''} ${t.type || ''}`.trim();
                    const sizeBytes = t.size_bytes || parseSizeToBytes(t.size || '');
                    const item = normalizeResult({
                        title,
                        infoHash: t.hash,
                        sizeBytes,
                        seeders: t.seeds,
                        leechers: t.peers,
                        source: 'YTS',
                    });
                    if (item) out.push(item);
                }
            }
            return out;
        } catch (e) {
            if (DEBUG_MODE) console.warn(`[YTS] ${e.message}`);
            return [];
        }
    });
}

// =============================================================================
// PROVIDER 3: EZTV (JSON) — solo SERIE TV, lookup per imdbId
// Host con fallback: eztv.tf (preferito, meno blocchi CF) → eztvx.to (originale)
// Override completo via env EZTV_HOST (singolo host, salta fallback).
// =============================================================================

const EZTV_TIMEOUT_MS = 7000;
const EZTV_HOSTS = process.env.EZTV_HOST
    ? [process.env.EZTV_HOST]
    : ['eztv.tf', 'eztvx.to'];

async function fetchEZTVTorrents(id) {
    let lastErr = null;
    for (const host of EZTV_HOSTS) {
        try {
            const url = `https://${host}/api/get-torrents?imdb_id=${id}&limit=100`;
            const res = await fetchWithTimeout(url, {}, EZTV_TIMEOUT_MS);
            if (res.status === 429) {
                setCooldown('eztv', 60);
                return { torrents: [], hardFail: true };
            }
            if (res.status === 403) {
                // IP cloud bloccato su questo host → prova il prossimo
                if (DEBUG_MODE) console.warn(`[EZTV] 403 da ${host}, fallback...`);
                continue;
            }
            if (!res.ok) {
                lastErr = `status ${res.status} da ${host}`;
                continue;
            }
            const data = await res.json();
            return { torrents: data?.torrents || [], hardFail: false };
        } catch (e) {
            lastErr = `${host}: ${e.message}`;
            if (DEBUG_MODE) console.warn(`[EZTV] ${lastErr}, fallback...`);
        }
    }
    if (DEBUG_MODE && lastErr) console.warn(`[EZTV] tutti gli host falliti — ultimo: ${lastErr}`);
    return { torrents: [], hardFail: false };
}

async function searchEZTV({ metadata, parsedId }) {
    if (isOnCooldown('eztv')) return [];
    const imdbId = metadata?.imdbId;
    if (!imdbId) return [];
    const season = parsedId?.season || metadata?.season;
    const episode = parsedId?.episode || metadata?.episode;
    const key = `eztv:${imdbId}:${season || ''}:${episode || ''}`;
    return cached(key, async () => {
        try {
            const id = String(imdbId).replace(/^tt/, '');
            const { torrents } = await fetchEZTVTorrents(id);
            const out = [];
            for (const t of torrents) {
                const hash = (t.hash || '').toLowerCase();
                if (!hash) continue;
                // Filtro server-side per episodio se specificato
                if (season && episode) {
                    const tSeason = Number(t.season);
                    const tEpisode = Number(t.episode);
                    if (tSeason && tEpisode && (tSeason !== Number(season) || tEpisode !== Number(episode))) {
                        continue;
                    }
                }
                const item = normalizeResult({
                    title: t.title,
                    infoHash: hash,
                    sizeBytes: Number(t.size_bytes) || 0,
                    seeders: t.seeds,
                    leechers: t.peers,
                    source: 'EZTV',
                    magnetLink: t.magnet_url || null,
                });
                if (item) out.push(item);
            }
            return out;
        } catch (e) {
            if (DEBUG_MODE) console.warn(`[EZTV] ${e.message}`);
            return [];
        }
    });
}

// =============================================================================
// PROVIDER 4: SolidTorrents (JSON) — RATE-LIMITED (min 2s tra le query)
// Host con fallback: solidtorrents.eu (più stabile, no CF) → solidtorrents.to (originale)
// Override via env SOLID_HOST.
// =============================================================================

const SOLID_TIMEOUT_MS = 6000;
const SOLID_MIN_INTERVAL_MS = 2000;   // max 1 chiamata ogni 2s
const SOLID_MAX_QUERIES_PER_CALL = 2; // taglio prudente per non saturare
const SOLID_HOSTS = process.env.SOLID_HOST
    ? [process.env.SOLID_HOST]
    : ['solidtorrents.eu', 'solidtorrents.to'];

async function fetchSolidResults(query) {
    let lastErr = null;
    for (const host of SOLID_HOSTS) {
        try {
            const url = `https://${host}/api/v1/search?q=${encodeURIComponent(query)}&sort=seeders`;
            const res = await fetchWithTimeout(url, { redirect: 'follow' }, SOLID_TIMEOUT_MS);
            if (res.status === 429) { setCooldown('solid', 300); return { results: [] }; }
            if (res.status === 403) {
                if (DEBUG_MODE) console.warn(`[Solid] 403 da ${host}, fallback...`);
                continue;
            }
            if (!res.ok) { lastErr = `${host}: status ${res.status}`; continue; }
            const data = await res.json();
            return { results: data?.results || [] };
        } catch (e) {
            lastErr = `${host}: ${e.message}`;
            if (DEBUG_MODE) console.warn(`[Solid] ${lastErr}, fallback...`);
        }
    }
    if (DEBUG_MODE && lastErr) console.warn(`[Solid] tutti gli host falliti — ultimo: ${lastErr}`);
    return { results: [] };
}

async function searchSolidSingle(query) {
    if (isOnCooldown('solid')) return [];
    return cached(`solid:${query}`, () => rateLimited('solid', SOLID_MIN_INTERVAL_MS, async () => {
        try {
            const { results } = await fetchSolidResults(query);
            const out = [];
            for (const r of results) {
                if (!r.infohash) continue;
                const item = normalizeResult({
                    title: r.title,
                    infoHash: r.infohash,
                    sizeBytes: Number(r.size) || 0,
                    seeders: r.swarm?.seeders,
                    leechers: r.swarm?.leechers,
                    source: 'SolidTorrents',
                });
                if (item) out.push(item);
            }
            return out;
        } catch (e) {
            if (DEBUG_MODE) console.warn(`[Solid] ${e.message}`);
            return [];
        }
    }));
}

async function searchSolid({ queries, metadata, parsedId, type }) {
    let qs = queries || buildPublicTrackerQueries(metadata, parsedId, type);
    if (!qs.length) return [];
    // Rate-limit prudente: limitiamo a N query per richiesta
    qs = qs.slice(0, SOLID_MAX_QUERIES_PER_CALL);
    const buckets = [];
    for (const q of qs) {                  // SERIALE (il rateLimited gestisce l'attesa)
        buckets.push(await searchSolidSingle(q));
    }
    return dedupeByHash(buckets.flat());
}

// =============================================================================
// PROVIDER 5: Bitsearch (HTML scrape) — RATE-LIMITED (min 2s tra le query)
// =============================================================================
//
// ⚠️ Bitsearch non espone JSON né API pubblica → unica via è HTML scrape.
// Regex usa il pattern `btih:HASH&amp;dn=NAME` presente nei link magnet.
// Fragile per design — quando cambiano template HTML va aggiornata la regex.
// Pensato per girare in "hybrid mode" / background dove la fragilità è ok.

const BITSEARCH_TIMEOUT_MS = 6000;
const BITSEARCH_MIN_INTERVAL_MS = 2000;
const BITSEARCH_MAX_QUERIES_PER_CALL = 2;
const BITSEARCH_HOSTS = process.env.BITSEARCH_HOST
    ? [process.env.BITSEARCH_HOST]
    : ['bitsearch.eu', 'bitsearch.to'];

async function fetchBitsearchHTML(query) {
    let lastErr = null;
    for (const host of BITSEARCH_HOSTS) {
        try {
            const url = `https://${host}/search?q=${encodeURIComponent(query)}`;
            const res = await fetchWithTimeout(url, { redirect: 'follow' }, BITSEARCH_TIMEOUT_MS);
            if (res.status === 429) { setCooldown('bitsearch', 120); return { html: '' }; }
            if (res.status === 403) {
                if (DEBUG_MODE) console.warn(`[Bitsearch] 403 da ${host}, fallback...`);
                continue;
            }
            if (!res.ok) { lastErr = `${host}: status ${res.status}`; continue; }
            return { html: await res.text() };
        } catch (e) {
            lastErr = `${host}: ${e.message}`;
            if (DEBUG_MODE) console.warn(`[Bitsearch] ${lastErr}, fallback...`);
        }
    }
    if (DEBUG_MODE && lastErr) console.warn(`[Bitsearch] tutti gli host falliti — ultimo: ${lastErr}`);
    return { html: '' };
}

async function searchBitsearchSingle(query) {
    if (isOnCooldown('bitsearch')) return [];
    return cached(`bs:${query}`, () => rateLimited('bitsearch', BITSEARCH_MIN_INTERVAL_MS, async () => {
        try {
            const { html } = await fetchBitsearchHTML(query);
            if (!html) return [];
            // Pattern: ogni risultato ha un <a href="magnet:?xt=urn:btih:HASH&amp;dn=NAME&amp;..."
            const matches = [...html.matchAll(/btih:([a-fA-F0-9]{40})&amp;dn(?:&#x3[Dd];|=)?([^"&]+)/gi)];
            const seenLocal = new Set();
            const out = [];
            for (const m of matches) {
                const hash = m[1].toLowerCase();
                if (seenLocal.has(hash)) continue;
                seenLocal.add(hash);
                let name = '';
                try {
                    name = decodeURIComponent((m[2] || '').replace(/\+/g, ' '));
                } catch { name = m[2] || ''; }
                name = name.replace(/^\[Bitsearch\.to\]\s*/i, '').trim();
                if (!name || name.length < 4) continue;
                const item = normalizeResult({
                    title: name,
                    infoHash: hash,
                    sizeBytes: 0,    // Bitsearch non espone size/seeders affidabili da HTML
                    seeders: 0,
                    leechers: 0,
                    source: 'Bitsearch',
                });
                if (item) out.push(item);
            }
            return out;
        } catch (e) {
            if (DEBUG_MODE) console.warn(`[Bitsearch] ${e.message}`);
            return [];
        }
    }));
}

async function searchBitsearch({ queries, metadata, parsedId, type }) {
    let qs = queries || buildPublicTrackerQueries(metadata, parsedId, type);
    if (!qs.length) return [];
    qs = qs.slice(0, BITSEARCH_MAX_QUERIES_PER_CALL);
    const buckets = [];
    for (const q of qs) {
        buckets.push(await searchBitsearchSingle(q));
    }
    return dedupeByHash(buckets.flat());
}

// =============================================================================
// PROVIDER 6: DHTIndex (dhtindex.org HTML) — crawler DHT pubblico, no API
//
// Pattern HTML stabile:
//   <a class="text-base..." href="/torrent/<40-hex-hash>">TITLE</a>
//   ...meta (size, date, files, S:<seeds>, L:<leech>)...
//   <a href="magnet:?xt=urn:btih:<HASH>&dn=...&tr=...">Magnet Link</a>
//
// Rate limit non documentato → cap conservativo: 1.5s tra chiamate, max 2 query
// per richiesta, cooldown 120s su 429 / 600s su 403 (CF block).
// =============================================================================

const DHTINDEX_TIMEOUT_MS = 8000;
const DHTINDEX_MIN_INTERVAL_MS = 1500;
const DHTINDEX_MAX_QUERIES_PER_CALL = 2;
const DHTINDEX_HOST = process.env.DHTINDEX_HOST || 'dhtindex.org';

async function searchDhtIndexSingle(query) {
    if (isOnCooldown('dhtindex')) return [];
    return cached(`dhtindex:${query}`, () => rateLimited('dhtindex', DHTINDEX_MIN_INTERVAL_MS, async () => {
        try {
            const url = `https://${DHTINDEX_HOST}/search?q=${encodeURIComponent(query)}`;
            const res = await fetchWithTimeout(url, {
                headers: { 'Accept': 'text/html,application/xhtml+xml' },
            }, DHTINDEX_TIMEOUT_MS);
            if (res.status === 429) { setCooldown('dhtindex', 120); return []; }
            if (res.status === 403) { setCooldown('dhtindex', 600); return []; }
            if (!res.ok) return [];
            const html = await res.text();
            if (!html || html.length < 200) return [];

            // Estrazione titolo + hash dal link "/torrent/<hash>"
            // Pattern: <a ... href="/torrent/<40hex>" ...>TITLE</a>
            const titleMap = new Map(); // hash -> title
            const titleRe = /<a[^>]+href="\/torrent\/([a-f0-9]{40})"[^>]*>([^<]{4,})<\/a>/gi;
            let m;
            while ((m = titleRe.exec(html)) !== null) {
                const hash = m[1].toLowerCase();
                const title = m[2].replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
                if (title && !titleMap.has(hash)) titleMap.set(hash, title);
            }
            if (titleMap.size === 0) return [];

            // Estrazione magnet con sizes/seeders dal blocco circostante.
            // I magnet hanno il formato magnet:?xt=urn:btih:<HASH>&dn=...
            const magnetRe = /magnet:\?xt=urn:btih:([a-f0-9]{40})[^"'\s]*/gi;
            const out = [];
            const seen = new Set();
            while ((m = magnetRe.exec(html)) !== null) {
                const hash = m[1].toLowerCase();
                if (seen.has(hash)) continue;
                seen.add(hash);
                const title = titleMap.get(hash);
                if (!title) continue;

                // Cerca dati meta nelle ~800 char attorno al primo match del titolo.
                // dhtindex mostra: "5.5 GB2026-05-2810 Files S: 30 L: 24"
                let sizeBytes = 0, seeders = 0, leechers = 0;
                const titlePos = html.indexOf(`/torrent/${hash}"`);
                if (titlePos > 0) {
                    const block = html.substring(titlePos, titlePos + 1200);
                    // Size: "5.5 GB" / "841.86 MB" — primo numero+unit dopo il titolo
                    const sizeM = block.match(/>\s*([\d.,]+\s*(?:B|KB|MB|GB|TB))\b/i);
                    if (sizeM) sizeBytes = parseSizeToBytes(sizeM[1]);
                    // Seeds/Leeches: "S: 30" "L: 24"
                    const sM = block.match(/\bS:\s*(\d+)/i);
                    const lM = block.match(/\bL:\s*(\d+)/i);
                    if (sM) seeders = parseInt(sM[1], 10) || 0;
                    if (lM) leechers = parseInt(lM[1], 10) || 0;
                }

                const item = normalizeResult({
                    title,
                    infoHash: hash,
                    sizeBytes,
                    seeders,
                    leechers,
                    source: 'DHTIndex',
                });
                if (item) out.push(item);
            }
            return out;
        } catch (e) {
            if (DEBUG_MODE) console.warn(`[dhtindex] ${e.message}`);
            return [];
        }
    }));
}

async function searchDhtIndex({ queries, metadata, parsedId, type }) {
    let qs = queries || buildPublicTrackerQueries(metadata, parsedId, type);
    if (!qs.length) return [];
    qs = qs.slice(0, DHTINDEX_MAX_QUERIES_PER_CALL);
    const buckets = [];
    for (const q of qs) {
        buckets.push(await searchDhtIndexSingle(q));
    }
    return dedupeByHash(buckets.flat());
}

// -----------------------------------------------------------------------------
// Dedup helper (per-call)
// -----------------------------------------------------------------------------

function dedupeByHash(items) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
        const k = (it.infoHash || '').toLowerCase();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(it);
    }
    return out;
}

// =============================================================================
// ORCHESTRATORE — entrypoint per index.js
//
// Esegue TUTTI i provider abilitati in parallelo (i rate-limited si auto-serializzano
// internamente), restituisce array unificato pronto per il merger di index.js.
//
// Esempio chiamata da handleStream():
//   const publicResults = await searchAllPublicTrackers({
//     metadata: { title, primaryTitle, italianTitle, year, imdbId },
//     parsedId: { season, episode },
//     type: 'movie' | 'series' | 'anime',
//     enabled: { apibay: true, yts: true, eztv: true, solid: true, bitsearch: true }
//   });
// =============================================================================

const DEFAULT_ENABLED = {
    apibay: true,
    yts: true,
    eztv: true,
    solid: true,
    bitsearch: true,
    dhtindex: true,
};

async function searchAllPublicTrackers({ metadata, parsedId, type, enabled }) {
    const en = { ...DEFAULT_ENABLED, ...(enabled || {}) };
    const ctx = { metadata, parsedId, type };
    const tasks = [];

    if (en.apibay) tasks.push(searchApibay(ctx));
    if (en.yts && type === 'movie') tasks.push(searchYTS(ctx));
    if (en.eztv && type === 'series' && metadata?.imdbId) tasks.push(searchEZTV(ctx));
    if (en.solid) tasks.push(searchSolid(ctx));
    if (en.bitsearch) tasks.push(searchBitsearch(ctx));
    if (en.dhtindex) tasks.push(searchDhtIndex(ctx));

    const buckets = await Promise.all(tasks.map(p => p.catch(err => {
        if (DEBUG_MODE) console.warn('[public-trackers] provider error:', err.message);
        return [];
    })));

    const merged = dedupeByHash(buckets.flat());
    if (DEBUG_MODE) {
        console.log(`🌐 [public-trackers] ${merged.length} unique results from ${tasks.length} provider(s)`);
    }
    return merged;
}

// =============================================================================
module.exports = {
    // Orchestratore (consigliato)
    searchAllPublicTrackers,

    // Provider singoli (se index.js vuole chiamarli mirati)
    searchApibay,
    searchYTS,
    searchEZTV,
    searchSolid,
    searchBitsearch,
    searchDhtIndex,

    // Builder query unificato (riusabile anche per gli scraper esistenti)
    buildPublicTrackerQueries,

    // Util (esportate per testing)
    cleanQuery,
    parseSizeToBytes,
    formatBytes,
};
