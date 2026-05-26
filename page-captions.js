(function () {
  const REQUEST_EVENT = 'yt-va-request-captions';
  const RESPONSE_EVENT = 'yt-va-response-captions';
  const MAX_TEXT_CHARS = 5_000_000;
  const REQUEST_TIMEOUT_MS = 12_000;
  const VIDEO_ID_PATTERN = /^[\w-]{6,20}$/;
  const capturedTimedTextResponses = [];
  const capturedTranscriptResponses = [];
  let lastVideoId = '';

  function clearCapturedResponsesForNavigation() {
    const videoId = getVideoId();
    if (videoId === lastVideoId) return;
    lastVideoId = videoId;
    capturedTimedTextResponses.length = 0;
    capturedTranscriptResponses.length = 0;
  }

  function videoIdFromUrl(urlText) {
    try {
      const url = new URL(urlText, location.origin);
      const videoId = url.searchParams.get('v') || '';
      return VIDEO_ID_PATTERN.test(videoId) ? videoId : '';
    } catch (_error) {
      return '';
    }
  }

  function rememberResponse(list, url, text, videoIdAtRequest = '') {
    if (!text || text.length > MAX_TEXT_CHARS) return;
    const videoId = videoIdFromUrl(url) || videoIdAtRequest || getVideoId();
    if (!videoId) return;
    list.push({ url: String(url), text, time: Date.now(), videoId });
    if (list.length > 30) list.shift();
  }

  function captureYouTubeTextResponse(url, text, videoIdAtRequest = '') {
    const urlText = String(url || '');
    if (urlText.includes('/api/timedtext')) {
      rememberResponse(capturedTimedTextResponses, urlText, text, videoIdAtRequest);
    } else if (urlText.includes('/youtubei/v1/get_transcript')) {
      rememberResponse(capturedTranscriptResponses, urlText, text, videoIdAtRequest);
    }
  }

  function installTimedTextCapture() {
    if (window.__ytVaTimedTextCaptureInstalled) return;
    window.__ytVaTimedTextCaptureInstalled = true;

    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = async function captureFetch(input, init) {
        const videoIdAtRequest = getVideoId();
        const response = await originalFetch.apply(this, arguments);
        const url = typeof input === 'string' ? input : input?.url || '';
        if (url.includes('/api/timedtext') || url.includes('/youtubei/v1/get_transcript')) {
          response.clone().text().then((text) => {
            captureYouTubeTextResponse(url, text, videoIdAtRequest);
          }).catch(() => {});
        }
        return response;
      };
    }

    const OriginalXhr = window.XMLHttpRequest;
    if (typeof OriginalXhr === 'function') {
      window.XMLHttpRequest = function CapturingXMLHttpRequest() {
        const xhr = new OriginalXhr();
        let requestUrl = '';
        let videoIdAtRequest = '';
        const originalOpen = xhr.open;
        xhr.open = function open(method, url) {
          requestUrl = String(url || '');
          videoIdAtRequest = getVideoId();
          return originalOpen.apply(xhr, arguments);
        };
        xhr.addEventListener('load', () => {
          if (!requestUrl.includes('/api/timedtext') && !requestUrl.includes('/youtubei/v1/get_transcript')) return;
          try {
            let text = '';
            if (typeof xhr.responseText === 'string' && xhr.responseText) {
              text = xhr.responseText;
            } else if (typeof xhr.response === 'string') {
              text = xhr.response;
            } else if (xhr.response instanceof ArrayBuffer) {
              text = new TextDecoder().decode(xhr.response);
            }
            captureYouTubeTextResponse(requestUrl, text, videoIdAtRequest);
          } catch (_error) {}
        });
        return xhr;
      };
      window.XMLHttpRequest.prototype = OriginalXhr.prototype;
      for (const key of ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE']) {
        window.XMLHttpRequest[key] = OriginalXhr[key];
      }
    }
  }

  installTimedTextCapture();

  function isAllowedPage() {
    return (
      (location.origin === 'https://www.youtube.com' || location.origin === 'https://m.youtube.com')
      && location.pathname === '/watch'
    );
  }

  function getVideoId() {
    const videoId = new URLSearchParams(location.search).get('v') || '';
    return VIDEO_ID_PATTERN.test(videoId) ? videoId : '';
  }

  function getYtcfg(key) {
    try {
      return window.ytcfg?.get?.(key);
    } catch (_error) {
      return undefined;
    }
  }

  function extractJsonObject(text, marker) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex === -1) return null;
    const start = text.indexOf('{', markerIndex + marker.length);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, index + 1));
          } catch (_error) {
            return null;
          }
        }
      }
    }

    return null;
  }

  function getScriptJson(marker) {
    for (const script of Array.from(document.scripts)) {
      const parsed = extractJsonObject(script.textContent || '', marker);
      if (parsed) return parsed;
    }
    return null;
  }

  function decodeEntities(text) {
    return String(text || '')
      .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }

  function normalizeText(text) {
    return decodeEntities(text)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\[[^\]]{1,40}\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseJson3(data) {
    const chunks = [];
    for (const event of data?.events || []) {
      if (!Array.isArray(event.segs)) continue;
      const line = event.segs.map((segment) => segment.utf8 || '').join('');
      const normalized = normalizeText(line);
      if (normalized) chunks.push(normalized);
    }
    return chunks.join(' ');
  }

  function parseVttOrSrt(text) {
    return normalizeText(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => (
          line
          && line !== 'WEBVTT'
          && !line.startsWith('NOTE')
          && !line.startsWith('STYLE')
          && !/^\d+$/.test(line)
          && !/^\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3}\s+-->\s+/.test(line)
          && !/^align:|^position:|^line:/i.test(line)
        ))
        .join(' ')
    );
  }

  function parseXmlText(text) {
    const chunks = [];
    const trimmed = text.trim();
    if (!/^(?:<\?xml[^>]*>\s*)?<transcript[\s>]/i.test(trimmed)) {
      return '';
    }
    const transcriptMatch = trimmed.match(/^(?:<\?xml[^>]*>\s*)?<transcript\b[^>]*>([\s\S]*?)<\/transcript>\s*$/i);
    if (!transcriptMatch) return '';
    const matches = transcriptMatch[1].matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g);
    for (const match of matches) {
      const normalized = normalizeText(match[1] || '');
      if (normalized) chunks.push(normalized);
    }
    return chunks.join(' ');
  }

  function parseCaptionText(rawText) {
    const trimmed = String(rawText || '').trim();
    if (!trimmed) return '';

    if (trimmed.startsWith('{')) {
      try {
        return normalizeText(parseJson3(JSON.parse(trimmed)));
      } catch (_error) {
        return '';
      }
    }

    if (trimmed.startsWith('WEBVTT') || /-->\s*\d{1,2}:\d{2}/.test(trimmed)) {
      return parseVttOrSrt(trimmed);
    }

    if (/^(?:<\?xml[^>]*>\s*)?<transcript[\s>]/i.test(trimmed)) {
      return normalizeText(parseXmlText(trimmed));
    }

    return '';
  }

  function textFromRuns(runs) {
    if (!Array.isArray(runs)) return '';
    return normalizeText(runs.map((run) => run.text || '').join(''));
  }

  function getInnertubeConfig() {
    const context = getYtcfg('INNERTUBE_CONTEXT') || getScriptJson('"INNERTUBE_CONTEXT"');
    const apiKey = getYtcfg('INNERTUBE_API_KEY') || Array.from(document.scripts)
      .map((script) => (script.textContent || '').match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1])
      .find(Boolean) || '';
    const clientName = String(
      getYtcfg('INNERTUBE_CONTEXT_CLIENT_NAME')
      || context?.client?.clientName
      || ''
    );
    const clientVersion = String(
      getYtcfg('INNERTUBE_CLIENT_VERSION')
      || context?.client?.clientVersion
      || ''
    );
    const visitorData = String(getYtcfg('VISITOR_DATA') || context?.client?.visitorData || '');

    return { apiKey, context, clientName, clientVersion, visitorData };
  }

  function innertubeHeaders(config) {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (config.clientName) headers['x-youtube-client-name'] = config.clientName;
    if (config.clientVersion) headers['x-youtube-client-version'] = config.clientVersion;
    if (config.visitorData) headers['x-goog-visitor-id'] = config.visitorData;
    return headers;
  }

  async function fetchTextLimited(url, options = {}) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        credentials: 'same-origin',
        ...options,
        signal: controller.signal,
      });
      if (!response.ok) return '';

      const text = await response.text();
      if (text.length > MAX_TEXT_CHARS) return '';
      return text;
    } catch (_error) {
      return '';
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function fetchJsonLimited(url, payload, config) {
    const text = await fetchTextLimited(url, {
      method: 'POST',
      headers: innertubeHeaders(config),
      body: JSON.stringify(payload),
    });
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_error) {
      return null;
    }
  }

  function playerResponseCandidates() {
    const player = document.querySelector('#movie_player');
    return [
      player?.getPlayerResponse?.(),
      window.ytInitialPlayerResponse,
      getScriptJson('ytInitialPlayerResponse'),
    ].filter(Boolean);
  }

  function trackName(track) {
    if (!track) return '';
    if (typeof track.name === 'string') return track.name;
    if (track.name?.simpleText) return track.name.simpleText;
    if (Array.isArray(track.name?.runs)) return track.name.runs.map((run) => run.text || '').join('');
    if (typeof track.displayName === 'string') return track.displayName;
    return '';
  }

  function normalizeTrack(track, selected = false) {
    const baseUrl = track?.baseUrl || track?.url || '';
    if (!baseUrl) return null;
    return {
      baseUrl,
      languageCode: track.languageCode || track.lang || '',
      kind: track.kind || '',
      name: trackName(track),
      vssId: track.vssId || '',
      rawName: track.name || null,
      selected: Boolean(selected || track.isSelected || track.vssId === track.trackName),
    };
  }

  function currentCaptionTrack() {
    const player = document.querySelector('#movie_player');
    return player?.getOption?.('captions', 'track') || null;
  }

  function tracksFromPage() {
    const selected = currentCaptionTrack();
    const selectedLang = selected?.languageCode || selected?.lang || '';
    const selectedName = trackName(selected);
    const tracks = [];

    for (const playerResponse of playerResponseCandidates()) {
      const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      for (const track of captionTracks) {
        const normalized = normalizeTrack(
          track,
          selectedLang && track.languageCode === selectedLang && (!selectedName || trackName(track) === selectedName)
        );
        if (normalized) tracks.push(normalized);
      }
    }

    const player = document.querySelector('#movie_player');
    const trackList = player?.getOption?.('captions', 'tracklist') || [];
    for (const track of trackList) {
      const normalized = normalizeTrack(
        track,
        selectedLang && (track.languageCode === selectedLang || track.lang === selectedLang)
      );
      if (normalized) tracks.push(normalized);
    }

    return orderTracks(tracks);
  }

  async function tracksFromTimedTextList() {
    const videoId = getVideoId();
    if (!videoId) return [];
    const xmlText = await fetchTextLimited(`/api/timedtext?type=list&v=${encodeURIComponent(videoId)}`);
    if (!xmlText) return [];

    const tracks = [];
    for (const match of xmlText.matchAll(/<track\b([^>]*)\/?>/g)) {
      const attrs = match[1] || '';
      const getAttr = (name) => decodeEntities(attrs.match(new RegExp(`${name}="([^"]*)"`, 'i'))?.[1] || '');
      const lang = getAttr('lang_code');
      if (!lang) continue;
      const kind = getAttr('kind');
      const name = getAttr('name');
      const url = new URL('/api/timedtext', location.origin);
      url.searchParams.set('v', videoId);
      url.searchParams.set('lang', lang);
      if (kind) url.searchParams.set('kind', kind);
      if (name) url.searchParams.set('name', name);
      tracks.push({ baseUrl: url.toString(), languageCode: lang, kind, name, selected: false });
    }
    return orderTracks(tracks);
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function observedTimedTextUrls(track) {
    const videoId = getVideoId();
    if (!videoId) return [];
    const language = (track.languageCode || '').toLowerCase();
    return performance.getEntriesByType('resource')
      .map((entry) => entry.name || '')
      .filter((name) => name.includes('/api/timedtext'))
      .map((name) => {
        try {
          return new URL(name);
        } catch (_error) {
          return null;
        }
      })
      .filter((url) => (
        url
        && url.searchParams.get('v') === videoId
        && url.searchParams.has('pot')
        && (!language || (url.searchParams.get('lang') || '').toLowerCase() === language)
      ))
      .reverse()
      .filter((url, index, urls) => urls.findIndex((item) => item.toString() === url.toString()) === index);
  }

  function capturedTextsForTrack(track) {
    const language = (track.languageCode || '').toLowerCase();
    return capturedTimedTextResponses
      .filter((item) => {
        try {
          const url = new URL(item.url, location.origin);
          return (
            item.videoId === getVideoId()
            &&
            url.searchParams.get('v') === getVideoId()
            && (!language || (url.searchParams.get('lang') || '').toLowerCase() === language)
          );
        } catch (_error) {
          return false;
        }
      })
      .sort((a, b) => b.time - a.time)
      .map((item) => item.text);
  }

  function applyObservedSubtitleParams(url, track) {
    const observed = observedTimedTextUrls(track)[0];
    if (!observed) return;
    for (const key of [
      'pot',
      'potc',
      'xorb',
      'xobt',
      'xovt',
      'cbr',
      'cbrver',
      'c',
      'cver',
      'cplayer',
      'cos',
      'cosver',
      'cplatform',
    ]) {
      const value = observed.searchParams.get(key);
      if (value && !url.searchParams.has(key)) url.searchParams.set(key, value);
    }
  }

  async function primeCaptionTrack(track) {
    const player = document.querySelector('#movie_player');
    if (!player || !track?.languageCode) return [];

    try {
      player.loadModule?.('captions');
      player.setOption?.('captions', 'track', {
        languageCode: track.languageCode,
        vssId: track.vssId || `.${track.languageCode}`,
        kind: track.kind || '',
        name: track.rawName || track.name,
        is_servable: true,
      });
      player.setOption?.('captions', 'reload', true);
      await sleep(2500);
    } catch (_error) {}

    return capturedTextsForTrack(track);
  }

  function captionUrls(track, includeObservedParams = true) {
    const urls = [];
    for (const observed of observedTimedTextUrls(track)) {
      urls.push(observed);
    }
    try {
      urls.push(new URL(track.baseUrl));
      for (const format of ['json3', 'vtt', 'srv3', 'srt']) {
        const url = new URL(track.baseUrl);
        if (!url.searchParams.has('fmt')) url.searchParams.set('fmt', format);
        else if (url.searchParams.get('fmt') !== format) continue;
        if (format === 'json3') {
          url.searchParams.set('xorb', '2');
          url.searchParams.set('xobt', '3');
          url.searchParams.set('xovt', '3');
          url.searchParams.set('c', 'WEB');
          url.searchParams.set('cver', getYtcfg('INNERTUBE_CLIENT_VERSION') || '2.20260521.00.00');
          url.searchParams.set('cplayer', 'UNIPLAYER');
          url.searchParams.set('cplatform', 'DESKTOP');
        }
        if (includeObservedParams) applyObservedSubtitleParams(url, track);
        urls.push(url);
      }
    } catch (_error) {}

    return urls.filter((url, index, list) => (
      list.findIndex((item) => item.toString() === url.toString()) === index
    ));
  }

  function orderTracks(tracks) {
    const pageLanguage = (document.documentElement.lang || navigator.language || '').toLowerCase().slice(0, 2);
    const unique = tracks.filter((track, index, list) => (
      track.baseUrl && list.findIndex((item) => item.baseUrl === track.baseUrl) === index
    ));
    const score = (track) => {
      const language = (track.languageCode || '').toLowerCase();
      const manual = track.kind !== 'asr' ? 1 : 0;
      if (track.selected) return 0;
      if (language.startsWith('en') && manual) return 1;
      if (language.startsWith('en')) return 2;
      if (pageLanguage && language.startsWith(pageLanguage) && manual) return 3;
      if (pageLanguage && language.startsWith(pageLanguage)) return 4;
      if (manual) return 5;
      return 6;
    };
    return unique.sort((a, b) => score(a) - score(b));
  }

  async function fetchTranscriptFromTracks(tracks) {
    for (const track of tracks.slice(0, 4)) {
      for (const text of capturedTextsForTrack(track)) {
        const transcript = parseCaptionText(text);
        if (transcript) return transcript;
      }

      for (const url of captionUrls(track, true)) {
        const transcript = parseCaptionText(await fetchTextLimited(url.toString()));
        if (transcript) return transcript;
      }

      const capturedTexts = await primeCaptionTrack(track);
      for (const text of capturedTexts) {
        const transcript = parseCaptionText(text);
        if (transcript) return transcript;
      }

      for (const url of captionUrls(track, true)) {
        const transcript = parseCaptionText(await fetchTextLimited(url.toString()));
        if (transcript) return transcript;
      }
    }
    return '';
  }

  function findTranscriptEndpoints(node, found = [], withinTranscript = false) {
    if (!node || typeof node !== 'object') return found;
    const isTranscriptShape = withinTranscript
      || Boolean(
        node.getTranscriptEndpoint
        || node.transcriptEndpoint
        || node.transcriptRenderer
        || node.transcriptSegmentRenderer
        || node.transcriptSearchPanelRenderer
        || node.engagementPanelSectionListRenderer?.targetId === 'engagement-panel-searchable-transcript'
      );
    if (node.getTranscriptEndpoint?.params) {
      found.push({ params: node.getTranscriptEndpoint.params });
    }
    if (node.transcriptEndpoint?.params) {
      found.push({ params: node.transcriptEndpoint.params });
    }
    if (node.commandMetadata?.webCommandMetadata?.apiUrl?.includes('/get_transcript') && node.params) {
      found.push({ params: node.params });
    }
    if (isTranscriptShape && node.continuationCommand?.token) {
      found.push({ continuation: node.continuationCommand.token });
    }
    for (const value of Object.values(node)) {
      findTranscriptEndpoints(value, found, isTranscriptShape);
    }
    return found;
  }

  function parseTranscriptRenderer(node, rows = [], continuations = []) {
    if (!node || typeof node !== 'object') return { rows, continuations };

    const segment = node.transcriptSegmentRenderer || node.transcriptSearchBoxRenderer;
    const text = textFromRuns(segment?.snippet?.runs || segment?.title?.runs || segment?.body?.runs);
    if (text) rows.push(text);

    if (node.continuationCommand?.token) {
      continuations.push(node.continuationCommand.token);
    }

    for (const value of Object.values(node)) {
      parseTranscriptRenderer(value, rows, continuations);
    }

    return { rows, continuations };
  }

  function dedupeLines(lines) {
    const seen = new Set();
    const result = [];
    for (const line of lines.map(normalizeText).filter(Boolean)) {
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(line);
    }
    return result;
  }

  async function fetchTranscriptEndpoint(endpoint, config) {
    const payload = endpoint.params
      ? { context: config.context, params: endpoint.params }
      : { context: config.context, continuation: endpoint.continuation };
    const data = await fetchJsonLimited(
      `/youtubei/v1/get_transcript?key=${encodeURIComponent(config.apiKey)}`,
      payload,
      config
    );
    if (!data) return { transcript: '', continuations: [] };

    const parsed = parseTranscriptRenderer(data);
    return {
      transcript: dedupeLines(parsed.rows).join(' '),
      continuations: [...new Set(parsed.continuations)],
    };
  }

  async function fetchTranscriptFromInnertube() {
    const videoId = getVideoId();
    const config = getInnertubeConfig();
    if (!videoId || !config.apiKey || !config.context) return '';

    const candidates = [
      window.ytInitialData,
      getScriptJson('ytInitialData'),
      await fetchJsonLimited(
        `/youtubei/v1/next?key=${encodeURIComponent(config.apiKey)}`,
        { context: config.context, videoId },
        config
      ),
    ].filter(Boolean);

    const endpoints = [];
    for (const candidate of candidates) {
      endpoints.push(...findTranscriptEndpoints(candidate));
    }

    const seen = new Set();
    const queue = endpoints.filter((endpoint) => {
      const key = endpoint.params || endpoint.continuation;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const chunks = [];
    while (queue.length) {
      const endpoint = queue.shift();
      const result = await fetchTranscriptEndpoint(endpoint, config);
      if (result.transcript) chunks.push(result.transcript);
      for (const continuation of result.continuations) {
        if (!continuation || seen.has(continuation)) continue;
        seen.add(continuation);
        queue.push({ continuation });
      }
    }

    return dedupeLines(chunks.join(' ').split(/(?<=[.!?])\s+/)).join(' ');
  }

  function transcriptFromCapturedInnertube() {
    const rows = [];
    const recentResponses = capturedTranscriptResponses
      .filter((item) => item.videoId === getVideoId() && Date.now() - item.time < 120_000)
      .sort((a, b) => b.time - a.time);

    for (const item of recentResponses) {
      try {
        const data = JSON.parse(item.text);
        rows.push(...parseTranscriptRenderer(data).rows);
      } catch (_error) {}
    }

    return dedupeLines(rows).join(' ');
  }

  async function loadTranscript() {
    if (!isAllowedPage()) return '';
    clearCapturedResponsesForNavigation();

    let transcript = transcriptFromCapturedInnertube();
    if (transcript) return transcript;

    const pageTracks = tracksFromPage();
    transcript = await fetchTranscriptFromTracks(pageTracks);
    if (transcript) return transcript;

    transcript = await fetchTranscriptFromInnertube();
    if (transcript) return transcript;

    transcript = transcriptFromCapturedInnertube();
    if (transcript) return transcript;

    const listTracks = await tracksFromTimedTextList();
    transcript = await fetchTranscriptFromTracks(listTracks);
    if (transcript) return transcript;

    return '';
  }

  window.addEventListener(REQUEST_EVENT, async (event) => {
    const { requestId, nonce, videoId, debug } = event.detail || {};
    if (!isAllowedPage()) return;
    if (!requestId || !nonce || videoId !== getVideoId()) return;

    try {
      const requestVideoId = videoId;
      const transcript = await loadTranscript();
      if (requestVideoId !== getVideoId()) return;
      window.dispatchEvent(new CustomEvent(RESPONSE_EVENT, {
        detail: {
          requestId,
          nonce,
          videoId: requestVideoId,
          ok: Boolean(transcript),
          transcript,
          debug: debug ? {
            capturedCount: capturedTimedTextResponses.length,
            capturedLengths: capturedTimedTextResponses.map((item) => item.text.length).slice(-8),
            capturedTranscriptCount: capturedTranscriptResponses.length,
            capturedTranscriptLengths: capturedTranscriptResponses.map((item) => item.text.length).slice(-8),
          } : undefined,
        },
      }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent(RESPONSE_EVENT, {
        detail: {
          requestId,
          nonce,
          ok: false,
          error: error.message || 'Caption extraction failed.',
        },
      }));
    }
  });

  window.addEventListener('yt-navigate-start', clearCapturedResponsesForNavigation);
  window.addEventListener('yt-navigate-finish', clearCapturedResponsesForNavigation);

  if (window.__YT_VA_TEST_HOOKS__ === true) {
    window.__ytVaPageCaptionsTest = { parseCaptionText };
  }
})();
