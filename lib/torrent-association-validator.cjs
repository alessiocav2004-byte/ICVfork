'use strict';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'at', 'da', 'de', 'del', 'della', 'delle', 'di', 'e', 'for',
  'gli', 'i', 'il', 'in', 'la', 'le', 'lo', 'of', 'on', 'or', 'the', 'to', 'un',
  'una'
]);

const RELEASE_WORDS = new Set([
  'aac', 'ac3', 'bdrip', 'bluray', 'cam', 'camrip', 'ddp', 'dts', 'dv', 'dvdrip',
  'eng', 'fullhd', 'h264', 'h265', 'hd', 'hdcam', 'hdr', 'hdtc', 'hevc', 'ita',
  'avi', 'm4v', 'mkv', 'mov', 'mp4', 'multi', 'multisub', 'remux', 'repack', 'sdr', 'sub', 'subbed',
  'telesync', 'ts', 'uhd', 'web', 'webdl', 'webrip', 'wmv', 'x264', 'x265'
]);

const NON_VIDEO_EXTENSIONS = /\.(?:exe|scr|bat|cmd|com|msi|apk|dmg|pkg|zip|rar|7z|epub|pdf|flac|mp3|wav)(?:\s|$)/i;
const NON_FEATURE_MARKERS = /(?:\bofficial\s+(?:teaser|trailer|featurette)\b|\bbehind\s+the\s+scenes\b|\bmaking\s+of\b|\bporn\s+parody\b|\bxxx\b.*\b(?:porn|parody)\b)/i;

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantWords(value) {
  return normalize(value)
    .split(' ')
    .filter(Boolean)
    .filter(word => word.length > 1)
    .filter(word => !STOP_WORDS.has(word));
}

function extractYears(value) {
  return [...String(value || '').matchAll(/\b((?:19|20)\d{2})\b/g)]
    .map(match => Number(match[1]));
}

function stripReleaseNoise(value) {
  const words = normalize(value).split(' ').filter(Boolean);
  const kept = [];

  for (const word of words) {
    if (/^(?:19|20)\d{2}$/.test(word)) continue;
    if (/^(?:480|576|720|1080|1440|2160|4320)p?$/.test(word)) continue;
    if (/^\d+(?:bit|ch)$/.test(word)) continue;
    if (RELEASE_WORDS.has(word)) continue;
    kept.push(word);
  }

  return kept.join(' ');
}

function hasAliasMatch(candidate, aliases) {
  const normalizedCandidate = ` ${normalize(candidate)} `;
  const parsedCandidate = ` ${stripReleaseNoise(candidate)} `;

  return aliases.some(alias => {
    const words = significantWords(alias);
    if (words.length === 0) return false;
    return words.every(word =>
      normalizedCandidate.includes(` ${word} `) || parsedCandidate.includes(` ${word} `)
    );
  });
}

function hasExactShortAlias(candidate, aliases) {
  const parsedCandidate = stripReleaseNoise(candidate);
  return aliases.some(alias => {
    const words = significantWords(alias);
    return words.length <= 2 && parsedCandidate === normalize(alias);
  });
}

function getDisqualifyingContentReason(row) {
  const candidate = [row?.title, row?.file_title, row?.filename]
    .filter(Boolean)
    .join(' | ');
  if (NON_VIDEO_EXTENSIONS.test(candidate)) return 'non-video or unsafe file extension';
  if (NON_FEATURE_MARKERS.test(candidate)) return 'trailer, making-of, or other non-feature content';
  return null;
}

function classifyTorrentAssociation(row, metadata) {
  const title = row?.title || '';
  const fileTitle = row?.file_title || '';
  const candidate = [title, fileTitle].filter(Boolean).join(' | ');
  const aliases = [...new Set([
    metadata?.name,
    metadata?.title,
    metadata?.originalTitle,
    ...(Array.isArray(metadata?.aliases) ? metadata.aliases : [])
  ].filter(Boolean))];
  const expectedYear = Number(metadata?.year) || null;
  const years = extractYears(candidate);
  const hasExpectedYear = expectedYear
    ? years.some(year => Math.abs(year - expectedYear) <= 1)
    : false;

  const disqualifyingReason = getDisqualifyingContentReason(row);
  if (disqualifyingReason) {
    return { status: 'invalid', reason: disqualifyingReason, confidence: 'high' };
  }

  if (expectedYear && years.length > 0 && !hasExpectedYear) {
    return {
      status: 'invalid',
      reason: `conflicting year (${[...new Set(years)].join(', ')}; expected ${expectedYear})`,
      confidence: 'high'
    };
  }

  if (!hasAliasMatch(candidate, aliases)) {
    return {
      status: 'review',
      reason: years.length > 0
        ? 'title does not match known aliases, but the year is not conflicting'
        : 'title mismatch without year evidence',
      confidence: 'medium'
    };
  }

  const shortestAliasLength = aliases.reduce((min, alias) => {
    const count = significantWords(alias).length;
    return count > 0 ? Math.min(min, count) : min;
  }, Infinity);

  if (shortestAliasLength <= 2 && years.length === 0 && !hasExactShortAlias(candidate, aliases)) {
    return {
      status: 'review',
      reason: 'ambiguous short title without year evidence',
      confidence: 'medium'
    };
  }

  return {
    status: 'valid',
    reason: hasExpectedYear ? 'title and year match' : 'title matches and no conflicting year is present',
    confidence: 'high'
  };
}

module.exports = {
  classifyTorrentAssociation,
  extractYears,
  getDisqualifyingContentReason,
  normalize,
  significantWords,
  stripReleaseNoise
};
