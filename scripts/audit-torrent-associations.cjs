#!/usr/bin/env node
'use strict';

const path = require('node:path');
require('dotenv').config({
  path: [path.resolve(process.cwd(), '.env.audit'), path.resolve(process.cwd(), '.env')],
  quiet: true
});
const { Pool } = require('pg');
const {
  classifyTorrentAssociation,
  getDisqualifyingContentReason
} = require('../lib/torrent-association-validator.cjs');

function usage(exitCode = 0) {
  console.log(`Usage:
  node scripts/audit-torrent-associations.cjs --imdb tt33764258
  node scripts/audit-torrent-associations.cjs --tmdb 1368337
  node scripts/audit-torrent-associations.cjs --all [--limit 100] [--batch-size 10] [--concurrency 4]

Options:
  --apply        Detach high-confidence invalid rows from the requested IDs.
  --yes          Required together with --apply.
  --json         Print machine-readable JSON.
  --no-progress  Do not print record progress to stderr.
  --type TYPE    movie or series (normally detected from Stremio metadata).
  --limit N      Maximum IDs to inspect in --all mode.
  --batch-size N IDs loaded and audited at a time in --all mode (default: 10).
  --concurrency N  Metadata requests in flight in --all mode (default: 4).

Database environment:
  Put the values in .env.audit in the project root, or export them in the shell.
  DATABASE_URL, or DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD

Metadata:
  IMDb IDs use Stremio Cinemeta. TMDB_KEY or TMDB_API_KEY adds localized and
  original titles and is required only when a TMDB ID cannot be mapped via DB.`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {
    apply: false,
    yes: false,
    json: false,
    progress: true,
    concurrency: 4,
    batchSize: 10,
    limit: null,
    type: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage(0);
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-progress') options.progress = false;
    else if (arg === '--all') options.all = true;
    else if (arg === '--imdb') options.imdbId = argv[++i];
    else if (arg === '--tmdb') options.tmdbId = Number(argv[++i]);
    else if (arg === '--type') options.type = argv[++i];
    else if (arg === '--limit') options.limit = Number(argv[++i]);
    else if (arg === '--batch-size') options.batchSize = Number(argv[++i]);
    else if (arg === '--concurrency') options.concurrency = Number(argv[++i]);
    else throw new Error(`Unknown option: ${arg}`);
  }

  const selectors = [options.all, options.imdbId, Number.isInteger(options.tmdbId)].filter(Boolean).length;
  if (selectors !== 1) throw new Error('Choose exactly one of --imdb, --tmdb, or --all.');
  if (options.imdbId && !/^tt\d{7,9}$/i.test(options.imdbId)) throw new Error('Invalid IMDb ID.');
  if (options.imdbId) options.imdbId = options.imdbId.toLowerCase();
  if (Number.isInteger(options.tmdbId) && options.tmdbId <= 0) throw new Error('Invalid TMDB ID.');
  if (options.type && !['movie', 'series'].includes(options.type)) throw new Error('--type must be movie or series.');
  if (options.apply && !options.yes) throw new Error('--apply requires --yes.');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 12) throw new Error('--concurrency must be between 1 and 12.');
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 250) throw new Error('--batch-size must be between 1 and 250.');
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit < 1)) throw new Error('--limit must be a positive integer.');
  return options;
}

class ProgressTracker {
  constructor(enabled, prefix = 'Audit') {
    this.enabled = enabled;
    this.prefix = prefix;
    this.total = 0;
    this.checked = 0;
    this.lastPercent = -1;
    this.lastLineLength = 0;
  }

  addTotal(records) {
    this.total += records;
  }

  advance(label) {
    this.checked += 1;
    this.render(label);
  }

  render(label, force = false) {
    if (!this.enabled || this.total === 0) return;
    const percent = Math.min(100, Math.floor((this.checked / this.total) * 100));
    const previousPercent = this.lastPercent;
    if (!force && percent === previousPercent) return;
    this.lastPercent = percent;
    const line = `${this.prefix}: ${percent.toString().padStart(3)}% (${this.checked}/${this.total})${label ? ` - ${label}` : ''}`;
    if (process.stderr.isTTY) {
      const padded = line.padEnd(this.lastLineLength, ' ');
      process.stderr.write(`\r${padded}`);
      this.lastLineLength = line.length;
    } else if (force || percent === 100 || percent === 0 || previousPercent < 0 || percent % 5 === 0) {
      process.stderr.write(`${line}\n`);
    }
  }

  finish() {
    if (!this.enabled) return;
    if (this.total === 0) {
      process.stderr.write(`${this.prefix}: 100% (0/0) - no records to check\n`);
      return;
    }
    this.checked = this.total;
    this.render('complete', true);
    if (process.stderr.isTTY) process.stderr.write('\n');
  }
}

function databaseConfig(readOnly) {
  if (!process.env.DATABASE_URL) {
    const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
    const missing = required.filter(name => !process.env[name]);
    if (missing.length > 0) {
      throw new Error(
        `Missing database configuration: ${missing.join(', ')}. ` +
        'Copy .env.audit.example to .env.audit and fill in the values.'
      );
    }
  }

  const base = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD
      };
  return {
    ...base,
    connectionTimeoutMillis: 8000,
    options: `-c statement_timeout=30000${readOnly ? ' -c default_transaction_read_only=on' : ''}`
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).hostname}`);
  return response.json();
}

async function fetchCinemeta(imdbId, preferredType = null) {
  const types = preferredType ? [preferredType] : ['movie', 'series'];
  for (const type of types) {
    try {
      const data = await fetchJson(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
      if (data?.meta?.name) {
        return {
          imdbId,
          tmdbId: Number(data.meta.moviedb_id) || null,
          name: data.meta.name,
          year: Number(String(data.meta.year || data.meta.releaseInfo || '').match(/\d{4}/)?.[0]) || null,
          type: data.meta.type === 'series' ? 'series' : type,
          aliases: []
        };
      }
    } catch (error) {
      if (preferredType) throw error;
    }
  }
  throw new Error(`Stremio Cinemeta has no metadata for ${imdbId}`);
}

async function addTmdbTitles(metadata) {
  const key = process.env.TMDB_KEY || process.env.TMDB_API_KEY;
  if (!key || !metadata.tmdbId) return metadata;
  try {
    const mediaType = metadata.type === 'series' ? 'tv' : 'movie';
    const params = `api_key=${encodeURIComponent(key)}&append_to_response=translations`;
    const data = await fetchJson(`https://api.themoviedb.org/3/${mediaType}/${metadata.tmdbId}?${params}`);
    const aliases = new Set(metadata.aliases || []);
    [data.title, data.name, data.original_title, data.original_name].filter(Boolean).forEach(value => aliases.add(value));
    for (const translation of data.translations?.translations || []) {
      if (['it', 'en'].includes(translation.iso_639_1)) {
        const title = translation.data?.title || translation.data?.name;
        if (title) aliases.add(title);
      }
    }
    return { ...metadata, originalTitle: data.original_title || data.original_name || null, aliases: [...aliases] };
  } catch (error) {
    console.error(`TMDB aliases unavailable for ${metadata.tmdbId}: ${error.message}`);
    return metadata;
  }
}

async function resolveImdbForTmdb(client, tmdbId) {
  const result = await client.query(
    `SELECT imdb_id, count(*)::int AS rows
       FROM torrents
      WHERE tmdb_id = $1 AND imdb_id IS NOT NULL
      GROUP BY imdb_id
      ORDER BY rows DESC`,
    [tmdbId]
  );
  if (result.rows.length === 1) return result.rows[0].imdb_id;
  if (result.rows.length > 1) throw new Error(`TMDB ${tmdbId} maps to multiple IMDb IDs in DB: ${result.rows.map(row => row.imdb_id).join(', ')}`);
  return null;
}

async function fetchTmdbOnly(tmdbId, preferredType) {
  const key = process.env.TMDB_KEY || process.env.TMDB_API_KEY;
  if (!key) throw new Error(`TMDB ${tmdbId} has no DB mapping; set TMDB_KEY or TMDB_API_KEY.`);
  const types = preferredType ? [preferredType] : ['movie', 'series'];
  for (const type of types) {
    try {
      const mediaType = type === 'series' ? 'tv' : 'movie';
      const data = await fetchJson(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${encodeURIComponent(key)}&append_to_response=external_ids,translations`);
      const imdbId = data.external_ids?.imdb_id || null;
      const metadata = {
        imdbId,
        tmdbId,
        name: data.title || data.name,
        originalTitle: data.original_title || data.original_name || null,
        year: Number(String(data.release_date || data.first_air_date || '').slice(0, 4)) || null,
        type,
        aliases: []
      };
      return addTmdbTitles(metadata);
    } catch (error) {
      if (preferredType) throw error;
    }
  }
  throw new Error(`TMDB has no movie or series metadata for ${tmdbId}`);
}

async function resolveMetadata(client, selector, preferredType = null) {
  if (selector.imdbId) return addTmdbTitles(await fetchCinemeta(selector.imdbId, preferredType));
  const imdbId = await resolveImdbForTmdb(client, selector.tmdbId);
  if (imdbId) return addTmdbTitles(await fetchCinemeta(imdbId, preferredType));
  return fetchTmdbOnly(selector.tmdbId, preferredType);
}

async function loadRows(client, metadata, selector) {
  const clauses = [];
  const params = [];
  if (selector.imdbId || metadata.imdbId) {
    params.push(selector.imdbId || metadata.imdbId);
    clauses.push(`imdb_id = $${params.length}`);
  }
  if (Number.isInteger(selector.tmdbId)) {
    params.push(selector.tmdbId);
    clauses.push(`tmdb_id = $${params.length}`);
  }
  const result = await client.query(
    `SELECT info_hash, provider, title, file_title, type, imdb_id, tmdb_id,
            seeders, size, is_torrent_pack
       FROM torrents
      WHERE ${clauses.join(' OR ')}
      ORDER BY provider, title`,
    params
  );
  return result.rows;
}

async function loadCacheEntries(client, metadata, selector) {
  const imdbId = selector.imdbId || metadata.imdbId || null;
  const tmdbId = Number.isInteger(selector.tmdbId) ? selector.tmdbId : metadata.tmdbId;
  const result = await client.query(
    `SELECT cache_key, created_at, filtered_results
       FROM torrent_search_cache
      WHERE ($1::text IS NOT NULL AND (imdb_id = $1 OR cache_key = 'torrent:movie:' || $1 OR cache_key LIKE 'torrent:series:' || $1 || ':%'))
         OR ($2::int IS NOT NULL AND (cache_key = 'torrent:movie:tmdb:' || $2 OR cache_key LIKE 'torrent:series:tmdb:' || $2 || ':%'))
      ORDER BY created_at DESC`,
    [imdbId, tmdbId]
  );

  return result.rows.flatMap(cacheRow => {
    const entries = Array.isArray(cacheRow.filtered_results) ? cacheRow.filtered_results : [];
    return entries.map(entry => {
      const row = {
        info_hash: String(entry.infoHash || entry.info_hash || '').toLowerCase(),
        provider: entry.source || entry.provider || entry.externalAddon || 'cache',
        title: entry.title || entry.websiteTitle || entry.filename || '',
        file_title: entry.file_title || entry.filename || null
      };
      return {
        ...row,
        cache_key: cacheRow.cache_key,
        cache_created_at: cacheRow.created_at
      };
    });
  });
}

async function loadChildRows(client, metadata) {
  if (!metadata.imdbId) return { table: null, rows: [] };

  if (metadata.type === 'series') {
    const result = await client.query(
      `SELECT f.id, f.info_hash, f.file_index, f.title, f.imdb_id,
              f.imdb_season, f.imdb_episode,
              t.title AS parent_title, t.type AS parent_type,
              t.imdb_id AS parent_imdb_id, t.is_torrent_pack
         FROM files f
         LEFT JOIN torrents t ON t.info_hash = f.info_hash
        WHERE f.imdb_id = $1
        ORDER BY f.info_hash, f.file_index`,
      [metadata.imdbId]
    );
    return { table: 'files', rows: result.rows };
  }

  const result = await client.query(
    `SELECT pf.id, pf.pack_hash, pf.file_index, pf.file_path, pf.file_size,
            pf.imdb_id, t.title AS parent_title, t.type AS parent_type,
            t.imdb_id AS parent_imdb_id, t.is_torrent_pack
       FROM pack_files pf
       LEFT JOIN torrents t ON t.info_hash = pf.pack_hash
      WHERE pf.imdb_id = $1
      ORDER BY pf.pack_hash, pf.file_index`,
    [metadata.imdbId]
  );
  return { table: 'pack_files', rows: result.rows };
}

function classifyChildAssociation(row, metadata, table) {
  const candidate = table === 'files'
    ? { title: row.parent_title || '', file_title: row.title || '' }
    : { title: row.parent_title || '', file_title: row.file_path || '' };
  const audit = classifyTorrentAssociation(candidate, metadata);

  // Episode filenames often contain only an episode title or air date. Those
  // are useful review signals, but not sufficient evidence to detach an IMDb.
  if (table === 'files' && audit.status === 'invalid' && !getDisqualifyingContentReason(candidate)) {
    return {
      status: 'review',
      reason: `episode child needs review: ${audit.reason}`,
      confidence: 'medium'
    };
  }
  return audit;
}

async function loadOne(client, selector, preferredType) {
  const metadata = await resolveMetadata(client, selector, preferredType);
  const rows = await loadRows(client, metadata, selector);
  const cacheEntries = await loadCacheEntries(client, metadata, selector);
  const childResult = await loadChildRows(client, metadata);
  return { selector, metadata, rows, cacheEntries, childResult };
}

function inspectLoaded(loaded, progress) {
  const { selector, metadata, rows, cacheEntries, childResult } = loaded;
  const id = metadata.imdbId || `tmdb:${metadata.tmdbId}`;
  const classified = rows.map(row => {
    const classifiedRow = { ...row, audit: classifyTorrentAssociation(row, metadata) };
    progress.advance(`${id} torrents`);
    return classifiedRow;
  });
  const classifiedCacheEntries = cacheEntries.map(row => {
    const classifiedRow = { ...row, audit: classifyTorrentAssociation(row, metadata) };
    progress.advance(`${id} cache`);
    return classifiedRow;
  });
  const childRows = childResult.rows.map(row => {
    const classifiedRow = {
      ...row,
      audit: classifyChildAssociation(row, metadata, childResult.table)
    };
    progress.advance(`${id} ${childResult.table}`);
    return classifiedRow;
  });

  const summary = { valid: 0, invalid: 0, review: 0 };
  classified.forEach(row => { summary[row.audit.status] += 1; });
  const cacheSummary = { valid: 0, invalid: 0, review: 0 };
  classifiedCacheEntries.forEach(row => { cacheSummary[row.audit.status] += 1; });
  const childSummary = { valid: 0, invalid: 0, review: 0 };
  childRows.forEach(row => { childSummary[row.audit.status] += 1; });
  return {
    selector,
    metadata,
    summary,
    cacheSummary,
    childTable: childResult.table,
    childSummary,
    rows: classified,
    cacheEntries: classifiedCacheEntries,
    childRows
  };
}

async function applyFixes(pool, reports) {
  let detached = 0;
  let detachedChildRows = 0;
  let invalidatedCaches = 0;
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    for (const report of reports) {
      for (const row of report.rows.filter(item => item.audit.status === 'invalid' && item.audit.confidence === 'high')) {
        const result = await client.query(
          `UPDATE torrents
              SET imdb_id = CASE WHEN imdb_id = $2 THEN NULL ELSE imdb_id END,
                  tmdb_id = CASE WHEN tmdb_id = $3 THEN NULL ELSE tmdb_id END
            WHERE info_hash = $1
              AND (imdb_id = $2 OR tmdb_id = $3)`,
          [row.info_hash, report.metadata.imdbId, report.metadata.tmdbId]
        );
        detached += result.rowCount;
      }

      for (const row of report.childRows.filter(item => item.audit.status === 'invalid' && item.audit.confidence === 'high')) {
        const table = report.childTable;
        if (!['files', 'pack_files'].includes(table) || !report.metadata.imdbId) continue;
        const result = await client.query(
          `UPDATE ${table}
              SET imdb_id = NULL
            WHERE id = $1
              AND imdb_id = $2`,
          [row.id, report.metadata.imdbId]
        );
        detachedChildRows += result.rowCount;
      }

      const imdbId = report.metadata.imdbId;
      const tmdbId = report.metadata.tmdbId;
      const cacheResult = await client.query(
        `DELETE FROM torrent_search_cache
          WHERE ($1::text IS NOT NULL AND (imdb_id = $1 OR cache_key = 'torrent:movie:' || $1 OR cache_key LIKE 'torrent:series:' || $1 || ':%'))
             OR ($2::int IS NOT NULL AND (cache_key = 'torrent:movie:tmdb:' || $2 OR cache_key LIKE 'torrent:series:tmdb:' || $2 || ':%'))`,
        [imdbId, tmdbId]
      );
      invalidatedCaches += cacheResult.rowCount;
    }
    await client.query('COMMIT');
    return { detached, detachedChildRows, invalidatedCaches };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function mapLimit(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      try { results[index] = await worker(items[index]); }
      catch (error) { results[index] = { selector: items[index], error: error.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function printReports(reports) {
  for (const report of reports) {
    if (report.error) {
      console.error(`ERROR ${JSON.stringify(report.selector)}: ${report.error}`);
      continue;
    }
    const id = report.metadata.imdbId || `tmdb:${report.metadata.tmdbId}`;
    console.log(`\n${id} — ${report.metadata.name} (${report.metadata.year || '?'}) [${report.metadata.type}]`);
    console.log(`table: valid=${report.summary.valid} invalid=${report.summary.invalid} review=${report.summary.review}`);
    for (const row of report.rows.filter(item => item.audit.status !== 'valid')) {
      console.log(`  ${row.audit.status.toUpperCase().padEnd(7)} ${row.info_hash} [${row.provider}] ${row.title}`);
      console.log(`          ${row.audit.reason}`);
    }
    console.log(`cache: valid=${report.cacheSummary.valid} invalid=${report.cacheSummary.invalid} review=${report.cacheSummary.review}`);
    for (const row of report.cacheEntries.filter(item => item.audit.status !== 'valid')) {
      console.log(`  ${row.audit.status.toUpperCase().padEnd(7)} ${row.info_hash || '-'.repeat(40)} [${row.provider}] ${row.title}`);
      console.log(`          ${row.audit.reason} (${row.cache_key})`);
    }
    console.log(`${report.childTable || 'children'}: valid=${report.childSummary.valid} invalid=${report.childSummary.invalid} review=${report.childSummary.review}`);
    for (const row of report.childRows.filter(item => item.audit.status !== 'valid')) {
      const hash = row.pack_hash || row.info_hash || '-'.repeat(40);
      const title = row.file_path || row.title || '';
      console.log(`  ${row.audit.status.toUpperCase().padEnd(7)} ${hash} [file ${row.file_index}] ${title}`);
      console.log(`          ${row.audit.reason}`);
    }
  }
}

function printSummary(applyResult) {
  if (applyResult) {
    console.log(
      `\nApplied: detached_torrents=${applyResult.detached}, ` +
      `detached_child_rows=${applyResult.detachedChildRows}, ` +
      `invalidated_cache_rows=${applyResult.invalidatedCaches}`
    );
  }
  else console.log('\nDry-run only: no database rows were changed.');
}

function emptyApplyResult() {
  return { detached: 0, detachedChildRows: 0, invalidatedCaches: 0 };
}

function addApplyResult(total, current) {
  if (!current) return total;
  total.detached += current.detached;
  total.detachedChildRows += current.detachedChildRows;
  total.invalidatedCaches += current.invalidatedCaches;
  return total;
}

async function auditLoadedBatch(pool, loadedReports, options, label = 'Audit') {
  const progress = new ProgressTracker(options.progress, label);
  for (const loaded of loadedReports) {
    if (!loaded.error) {
      progress.addTotal(loaded.rows.length + loaded.cacheEntries.length + loaded.childResult.rows.length);
    }
  }
  const reports = loadedReports.map(loaded => loaded.error ? loaded : inspectLoaded(loaded, progress));
  progress.finish();
  const successful = reports.filter(report => !report.error);
  const applyResult = options.apply ? await applyFixes(pool, successful) : null;
  return { reports, applyResult };
}

(async () => {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); usage(2); }

  let pool;
  try {
    pool = new Pool({ ...databaseConfig(!options.apply), max: options.concurrency });
    await pool.query('SELECT 1');
    if (options.all) {
      if (options.progress) process.stderr.write('Loading IMDb index from torrents...\n');
      const limitSql = options.limit ? ` LIMIT ${options.limit}` : '';
      const result = await pool.query(
        `SELECT imdb_id, count(*)::int AS rows
           FROM torrents
          WHERE imdb_id ~ '^tt[0-9]{7,9}$'
          GROUP BY imdb_id
          ORDER BY max(updated_at) DESC NULLS LAST${limitSql}`
      );
      const selectors = result.rows.map(row => ({ imdbId: row.imdb_id }));
      const totalBatches = Math.ceil(selectors.length / options.batchSize);
      const totalApplyResult = options.apply ? emptyApplyResult() : null;
      let hasErrors = false;
      let firstJsonReport = true;

      if (options.json) {
        process.stdout.write(`{"mode":${JSON.stringify(options.apply ? 'apply' : 'dry-run')},"reports":[`);
      }

      for (let offset = 0; offset < selectors.length; offset += options.batchSize) {
        const batch = selectors.slice(offset, offset + options.batchSize);
        const batchNumber = Math.floor(offset / options.batchSize) + 1;
        const end = offset + batch.length;
        if (options.progress) {
          process.stderr.write(
            `Loading batch ${batchNumber}/${totalBatches} (IDs ${offset + 1}-${end} of ${selectors.length})...\n`
          );
        }
        const loadedReports = await mapLimit(
          batch,
          options.concurrency,
          selector => loadOne(pool, selector, options.type)
        );
        const batchResult = await auditLoadedBatch(
          pool,
          loadedReports,
          options,
          `Batch ${batchNumber}/${totalBatches}`
        );
        addApplyResult(totalApplyResult, batchResult.applyResult);
        hasErrors ||= batchResult.reports.some(report => report.error);

        if (options.json) {
          for (const report of batchResult.reports) {
            if (!firstJsonReport) process.stdout.write(',');
            process.stdout.write(JSON.stringify(report));
            firstJsonReport = false;
          }
        } else {
          printReports(batchResult.reports);
        }

        if (options.progress) {
          const percent = selectors.length === 0 ? 100 : Math.floor((end / selectors.length) * 100);
          process.stderr.write(`IDs complete: ${percent}% (${end}/${selectors.length})\n`);
        }
      }

      if (options.json) {
        process.stdout.write(`],"applyResult":${JSON.stringify(totalApplyResult)}}\n`);
      } else {
        printSummary(totalApplyResult);
      }
      if (hasErrors) process.exitCode = 1;
    } else {
      const selectors = [{
        imdbId: options.imdbId,
        tmdbId: Number.isInteger(options.tmdbId) ? options.tmdbId : undefined
      }];
      const loadedReports = await mapLimit(
        selectors,
        options.concurrency,
        selector => loadOne(pool, selector, options.type)
      );
      const result = await auditLoadedBatch(pool, loadedReports, options);
      if (options.json) {
        console.log(JSON.stringify({
          mode: options.apply ? 'apply' : 'dry-run',
          reports: result.reports,
          applyResult: result.applyResult
        }, null, 2));
      } else {
        printReports(result.reports);
        printSummary(result.applyResult);
      }
      if (result.reports.some(report => report.error)) process.exitCode = 1;
    }
  } catch (error) {
    const details = [error.message, error.code, error.cause?.message]
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(' | ');
    console.error(`Audit failed: ${details || String(error)}`);
    process.exitCode = 2;
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
})();
