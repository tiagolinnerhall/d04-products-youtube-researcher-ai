(function () {
  const BUTTON_ID = 'yt-va-button';
  const PANEL_ID = 'yt-va-panel';
  const THUMB_BUTTON_CLASS = 'yt-va-thumb-button';
  const SEARCH_RESULT_LIMIT = 50;
  const SEARCH_CANDIDATE_LIMIT = 180;
  const PROJECT_URL = 'https://github.com/tiagolinnerhall/d04-products-youtube-researcher-ai';
  const FREE_TRIAL_ACTION_LIMIT = 5;
  const PRO_REFRESH_MS = 24 * 60 * 60 * 1000;
  const ARCHIVE_VERSION = 1;
  const ARCHIVE_PREFIX = 'ytVaArchive:';
  const RESEARCH_ARCHIVE_KEY = 'ytVaResearchArchive';
  const AUDIO_DB_NAME = 'yt-video-assistant-audio';
  const AUDIO_DB_VERSION = 1;

  let currentVideoId = '';
  let cachedTranscript = '';
  let cachedSummary = '';
  let latestReadableText = '';
  let latestFullText = '';
  let latestExtremeText = '';
  let selectedVideo = null;
  let activeRequestToken = 0;
  let currentAudioUrl = '';
  let bridgeNonce = '';
  let ignoreVisibleTranscriptUntilOpened = true;
  let audioDbPromise = null;
  let currentArchive = null;
  let archiveReturnFragment = null;
  let archiveReturnStatus = '';
  let lastFinderResults = [];
  let lastRenderedResults = [];
  let lastFinderMode = 'search';
  let proState = null;
  const transcriptCache = new Map();
  const SETTINGS_DEFAULTS = {
    chatApiUrl: 'https://api.deepseek.com/chat/completions',
    chatProvider: 'openai-compatible',
    chatModel: 'deepseek-chat',
    elevenLabsEnglishVoiceId: '21m00Tcm4TlvDq8ikWAM',
    elevenLabsPortugueseVoiceId: 'ErXwobaYiN019PkySvjV',
  };

  function getVideoId() {
    return new URLSearchParams(window.location.search).get('v') || '';
  }

  function getBridgeNonce() {
    if (bridgeNonce) return bridgeNonce;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bridgeNonce = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return bridgeNonce;
  }

  function getTitle() {
    return document.querySelector('h1 yt-formatted-string')?.textContent?.trim()
      || document.title.replace(' - YouTube', '').trim();
  }

  function videoUrl(videoId) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId || '')}`;
  }

  function getVideoIdFromUrl(urlText) {
    try {
      const url = new URL(urlText, location.origin);
      if (url.hostname.includes('youtu.be')) return url.pathname.split('/').filter(Boolean)[0] || '';
      if (url.pathname === '/watch') return url.searchParams.get('v') || '';
      if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || '';
    } catch (_error) {}
    return '';
  }

  function getCurrentPageVideo() {
    const videoId = getVideoId();
    if (!videoId) return null;
    return {
      videoId,
      title: getTitle(),
      url: videoUrl(videoId),
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      source: 'current',
    };
  }

  function normalizeVideoSelection(video) {
    const videoId = video?.videoId || getVideoIdFromUrl(video?.url || '');
    if (!videoId) return null;
    return {
      videoId,
      title: String(video?.title || 'Selected YouTube video').trim(),
      url: video?.url || videoUrl(videoId),
      thumbnail: video?.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      channel: video?.channel || '',
      views: video?.views || '',
      published: video?.published || '',
      source: video?.source || 'selected',
    };
  }

  function getActiveVideo() {
    return selectedVideo || getCurrentPageVideo();
  }

  function archiveKey(videoId = getVideoId()) {
    return `${ARCHIVE_PREFIX}${videoId}`;
  }

  function createArchive(videoId = getVideoId(), video = getActiveVideo()) {
    return {
      version: ARCHIVE_VERSION,
      videoId,
      title: video?.title || getTitle(),
      url: video?.url || location.href,
      updatedAt: Date.now(),
      entries: [],
    };
  }

  async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function openAudioDb() {
    if (audioDbPromise) return audioDbPromise;
    audioDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(AUDIO_DB_NAME, AUDIO_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Audio archive could not be opened.'));
    });
    return audioDbPromise;
  }

  async function audioDbPut(record) {
    const db = await openAudioDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('audio', 'readwrite');
      tx.objectStore('audio').put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Audio could not be saved.'));
    });
  }

  async function audioDbGet(id) {
    const db = await openAudioDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('audio', 'readonly');
      const request = tx.objectStore('audio').get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Audio could not be loaded.'));
    });
  }

  async function audioDbDeleteForVideo(videoId) {
    const db = await openAudioDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('audio', 'readwrite');
      const store = tx.objectStore('audio');
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (cursor.value?.videoId === videoId) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Audio could not be cleared.'));
    });
  }

  async function audioDbClearAll() {
    const db = await openAudioDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('audio', 'readwrite');
      tx.objectStore('audio').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Audio archive could not be cleared.'));
    });
  }

  async function loadArchive(videoId = getVideoId(), video = getActiveVideo()) {
    if (!videoId) return createArchive('', video);
    const stored = await chrome.storage.local.get(archiveKey(videoId));
    const archive = stored[archiveKey(videoId)];
    if (archive?.version === ARCHIVE_VERSION && archive.videoId === videoId && Array.isArray(archive.entries)) {
      currentArchive = archive;
      return archive;
    }
    currentArchive = createArchive(videoId, video);
    return currentArchive;
  }

  async function saveArchive(archive, video = getActiveVideo()) {
    if (!archive?.videoId) return;
    archive.updatedAt = Date.now();
    archive.title = video?.title || getTitle();
    archive.url = video?.url || location.href;
    currentArchive = archive;
    await chrome.storage.local.set({ [archiveKey(archive.videoId)]: archive });
  }

  async function getSettingsSnapshot() {
    const response = await chrome.runtime.sendMessage({ type: 'YT_VIDEO_ASSISTANT_GET_PUBLIC_SETTINGS' });
    return response?.settings || SETTINGS_DEFAULTS;
  }

  async function getInstallId() {
    const stored = await chrome.storage.local.get({ ytVaInstallId: '' });
    if (stored.ytVaInstallId) return stored.ytVaInstallId;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const installId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    await chrome.storage.local.set({ ytVaInstallId: installId });
    return installId;
  }

  async function loadProState() {
    if (proState) return proState;
    const stored = await chrome.storage.local.get({
      ytVaLicenseKey: '',
      ytVaLicenseStatus: '',
      ytVaLicenseEmail: '',
      ytVaLicenseTrialEndsAt: '',
      ytVaLicenseCurrentPeriodEnd: '',
      ytVaProValidatedAt: 0,
      ytVaFreeActionsUsed: 0,
    });
    proState = stored;
    return proState;
  }

  async function saveProState(patch) {
    proState = { ...(await loadProState()), ...patch };
    await chrome.storage.local.set(patch);
    return proState;
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !proState) return;
    const proKeys = [
      'ytVaLicenseKey',
      'ytVaLicenseStatus',
      'ytVaLicenseEmail',
      'ytVaLicenseTrialEndsAt',
      'ytVaLicenseCurrentPeriodEnd',
      'ytVaProValidatedAt',
      'ytVaFreeActionsUsed',
    ];
    const changed = Object.fromEntries(
      proKeys
        .filter((key) => Object.prototype.hasOwnProperty.call(changes, key))
        .map((key) => [key, changes[key].newValue])
    );
    if (Object.keys(changed).length) proState = { ...proState, ...changed };
  });

  function isFutureIsoDate(value) {
    const time = Date.parse(value || '');
    return Number.isFinite(time) && time > Date.now();
  }

  function isProActive(state) {
    const status = String(state?.ytVaLicenseStatus || '');
    if (!['trialing', 'active'].includes(status)) return false;
    if (state?.ytVaLicenseTrialEndsAt || state?.ytVaLicenseCurrentPeriodEnd) {
      return isFutureIsoDate(state.ytVaLicenseTrialEndsAt) || isFutureIsoDate(state.ytVaLicenseCurrentPeriodEnd);
    }
    return true;
  }

  async function validateProLicense(licenseKey = '') {
    const finalKey = String(licenseKey || (await loadProState()).ytVaLicenseKey || '').trim().toUpperCase();
    if (!finalKey) throw new Error('Paste a license key first.');
    const response = await chrome.runtime.sendMessage({
      type: 'YT_VIDEO_ASSISTANT_VALIDATE_LICENSE',
      licenseKey: finalKey,
      installId: await getInstallId(),
    });
    const data = response?.license || {};
    if (!response?.ok || !data.valid) throw new Error(response?.error || data.error || 'License is not active.');
    await saveProState({
      ytVaLicenseKey: finalKey,
      ytVaLicenseStatus: data.status || 'active',
      ytVaLicenseEmail: data.email || '',
      ytVaLicenseTrialEndsAt: data.trialEndsAt || '',
      ytVaLicenseCurrentPeriodEnd: data.currentPeriodEnd || '',
      ytVaProValidatedAt: Date.now(),
    });
    return data;
  }

  async function refreshProAccessIfNeeded(state) {
    if (!state?.ytVaLicenseKey) return state;
    const lastValidatedAt = Number(state.ytVaProValidatedAt || 0);
    if (isProActive(state) && Date.now() - lastValidatedAt < PRO_REFRESH_MS) return state;
    try {
      await validateProLicense(state.ytVaLicenseKey);
      return loadProState();
    } catch (_error) {
      return loadProState();
    }
  }

  async function requireProAccess() {
    return true;
  }

  async function archiveEntry(kind, title, text, question = '', video = getActiveVideo()) {
    const videoId = video?.videoId || getVideoId();
    const requestVideoId = getActiveVideo()?.videoId || getVideoId();
    const settings = await getSettingsSnapshot();
    const hash = await sha256([
      kind,
      title,
      text,
      question,
      settings.chatModel || '',
    ].join('\n'));
    if ((getActiveVideo()?.videoId || getVideoId()) !== requestVideoId) return null;
    const archive = await loadArchive(videoId, video);
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      kind,
      title,
      text,
      question,
      textHash: hash,
      createdAt: Date.now(),
      model: settings.chatModel || '',
      url: video?.url || location.href,
    };
    archive.entries.push(entry);
    await saveArchive(archive, video);
    return entry;
  }

  async function saveResearchArchive(record) {
    const stored = await chrome.storage.local.get({ [RESEARCH_ARCHIVE_KEY]: [] });
    const items = Array.isArray(stored[RESEARCH_ARCHIVE_KEY]) ? stored[RESEARCH_ARCHIVE_KEY] : [];
    items.unshift(record);
    await chrome.storage.local.set({ [RESEARCH_ARCHIVE_KEY]: items.slice(0, 100) });
  }

  async function loadResearchArchive() {
    const stored = await chrome.storage.local.get({ [RESEARCH_ARCHIVE_KEY]: [] });
    return Array.isArray(stored[RESEARCH_ARCHIVE_KEY]) ? stored[RESEARCH_ARCHIVE_KEY] : [];
  }

  function buildPrompt(payload) {
    const context = [
      `Title: ${payload.title || 'Unknown YouTube video'}`,
      `URL: ${payload.url || location.href}`,
      '',
      'Transcript:',
      payload.transcript,
    ].join('\n');

    if (payload.mode === 'extreme') {
      return [
        'Create an extreme summary of this YouTube video from its transcript.',
        'Use this exact readable format:',
        '✦ Extreme Summary',
        '• 3 to 5 short bullets that together cover the whole video.',
        '• Each bullet must include major concepts, arguments, examples, names, places, and conclusions without becoming long.',
        '',
        '◈ What Matters Most',
        '• 1 to 3 short bullets with the strongest takeaways.',
        'Keep it compact, natural, and clear.',
        'Do not present speculative claims as facts; use phrases like "the speaker argues" or "the video claims."',
        'Target length: 140 to 220 words total.',
        '',
        context,
      ].join('\n');
    }

    if (payload.mode === 'question') {
      return [
        'Answer the user question using only the YouTube transcript below.',
        'Format the answer for a small browser panel.',
        'Use short sections and icon bullets.',
        'Use this exact format:',
        '',
        '✦ Direct Answer',
        '• 2 to 5 concise bullets answering the question.',
        '',
        '◆ Details From The Video',
        '• Only include details that support the answer.',
        '',
        'If the transcript does not contain the answer, say that clearly.',
        '',
        context,
        '',
        `Question: ${payload.question}`,
      ].join('\n');
    }

    if (payload.mode === 'research-brief') {
      return [
        'Build a premium YouTube research brief from these candidate videos and transcript excerpts.',
        'Use only the supplied material. If evidence is weak, say so.',
        'Format exactly like this with concise bullets:',
        '',
        '✦ Best Video',
        '• Pick the strongest video and explain why.',
        '',
        '◆ Consensus Across Sources',
        '• Common advice or claims repeated across videos.',
        '',
        '◈ Contradictions',
        '• Conflicting claims, weak evidence, or disagreements.',
        '',
        '✧ Practical Action Plan',
        '• Clear steps the viewer should take.',
        '',
        '◆ Red Flags',
        '• Clickbait, unsupported claims, or suspicious advice.',
        '',
        '◈ Videos Reviewed',
        '• List each reviewed video with a short note.',
        '',
        context,
      ].join('\n');
    }

    return [
      'Summarize this YouTube video from its transcript.',
      'Write in clean, natural, simple language.',
      'This appears inside a browser extension panel, so keep it compact and easy to scan.',
      'Do not create long paragraphs.',
      'Do not omit important ideas from the video.',
      'Do not repeat the same fact in multiple sections unless it is essential.',
      'If the video makes speculative or controversial claims, phrase them as "the video argues," "the speaker suggests," or "the claim is" instead of presenting them as proven facts.',
      'Do not turn a video title into a stronger claim than the transcript supports. For example, say "human civilization" or "human origins story" unless the transcript clearly says biological human life began there.',
      'For disputed discoveries or evidence, do not write "discovered" or "proved" as fact. Write "reported," "claimed," "described," or "presented as evidence."',
      'Use this exact format:',
      '',
      '✦ Summary',
      '• 3 short bullets explaining the main message.',
      '',
      '◆ Main Points',
      '• 4 to 6 short bullets with the important claims, arguments, or steps.',
      '• Start each Main Points bullet with "The video says," "The speaker argues," "The speaker claims," or "The video presents."',
      '',
      '◈ Details to Remember',
      '• 3 to 5 short bullets with specific names, places, numbers, examples, or evidence mentioned. Avoid repeating Main Points.',
      '',
      '✧ Follow-Up Questions',
      '• 2 to 3 short useful questions the viewer could ask next.',
      '',
      context,
    ].join('\n');
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
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
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

  function findPlayerResponse() {
    const scripts = Array.from(document.scripts);
    for (const script of scripts) {
      const text = script.textContent || '';
      const parsed = extractJsonObject(text, 'ytInitialPlayerResponse');
      if (parsed) return parsed;
    }

    return null;
  }

  function getCaptionTracks(playerResponse) {
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) return [];

    const preferred = [
      ...tracks.filter((track) => track.languageCode?.startsWith('en') && track.kind === 'asr'),
      ...tracks.filter((track) => track.languageCode?.startsWith('en') && track.kind !== 'asr'),
      ...tracks.filter((track) => track.kind === 'asr'),
      ...tracks.filter((track) => track.kind !== 'asr'),
    ];

    return preferred.filter((track, index, list) => (
      track.baseUrl && list.findIndex((item) => item.baseUrl === track.baseUrl) === index
    ));
  }

  function getTracksFromYouTubePlayer(videoId = getVideoId()) {
    const player = document.querySelector('#movie_player');
    const trackList = player?.getOption?.('captions', 'tracklist') || [];
    return trackList
      .map((track) => {
        if (track.baseUrl || track.url) {
          return {
            baseUrl: track.baseUrl || track.url,
            languageCode: track.languageCode || track.lang || '',
            kind: track.kind || '',
          };
        }

        const url = new URL('/api/timedtext', location.origin);
        url.searchParams.set('v', videoId);
        if (track.languageCode || track.lang) url.searchParams.set('lang', track.languageCode || track.lang);
        if (track.kind) url.searchParams.set('kind', track.kind);
        if (track.name) url.searchParams.set('name', track.name);
        url.searchParams.set('fmt', 'json3');
        return {
          baseUrl: url.toString(),
          languageCode: track.languageCode || track.lang || '',
          kind: track.kind || '',
        };
      })
      .filter((track) => track.languageCode);
  }

  function decodeEntities(text) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = text;
    return textarea.value;
  }

  function parseCaptionText(rawText) {
    const trimmed = String(rawText || '').trim();
    if (!trimmed) return '';

    if (trimmed.startsWith('WEBVTT')) {
      return decodeEntities(
        trimmed
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => (
            line
            && line !== 'WEBVTT'
            && !line.startsWith('NOTE')
            && !/^\d+$/.test(line)
            && !/^\d{1,2}:\d{2}:\d{2}\.\d{3}\s+-->/.test(line)
          ))
          .join(' ')
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      );
    }

    if (trimmed.startsWith('{')) {
      let data;
      try {
        data = JSON.parse(trimmed);
      } catch (_error) {
        return '';
      }
      const chunks = [];
      for (const event of data.events || []) {
        for (const segment of event.segs || []) {
          if (segment.utf8) chunks.push(segment.utf8.replace(/\s+/g, ' ').trim());
        }
      }
      return decodeEntities(chunks.join(' ').replace(/\s+/g, ' ').trim());
    }

    if (/^<\?xml/i.test(trimmed) || /^<transcript[\s>]/i.test(trimmed)) {
    const xml = new DOMParser().parseFromString(trimmed, 'text/xml');
    const textNodes = Array.from(xml.querySelectorAll('transcript > text'));
      return decodeEntities(
        textNodes
          .map((node) => node.textContent || '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
      );
    }

    return '';
  }

  function loadTranscriptFromPageBridge(timeoutMs = 26000) {
    return new Promise((resolve) => {
      const requestId = `yt-va-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const nonce = getBridgeNonce();
      const videoId = getVideoId();
      const timeout = window.setTimeout(() => {
        window.removeEventListener('yt-va-response-captions', onResponse);
        resolve('');
      }, timeoutMs);

      function onResponse(event) {
        if (event.detail?.requestId !== requestId) return;
        if (event.detail?.nonce !== nonce) return;
        if (event.detail?.videoId !== videoId || getVideoId() !== videoId) return;
        window.clearTimeout(timeout);
        window.removeEventListener('yt-va-response-captions', onResponse);
        resolve(event.detail?.transcript || '');
      }

      window.addEventListener('yt-va-response-captions', onResponse);
      window.dispatchEvent(new CustomEvent('yt-va-request-captions', {
        detail: { requestId, nonce, videoId },
      }));
    });
  }

  async function loadTranscript() {
    if (cachedTranscript && currentVideoId === getVideoId()) return cachedTranscript;

    let transcript = await loadTranscriptFromPageBridge();
    if (transcript) {
      currentVideoId = getVideoId();
      cachedTranscript = transcript;
      return transcript;
    }

    transcript = await loadTranscriptFromVisiblePanel();
    if (transcript) {
      currentVideoId = getVideoId();
      cachedTranscript = transcript;
      return transcript;
    }

    transcript = await loadTranscriptFromPageBridge(6000);
    if (transcript) {
      currentVideoId = getVideoId();
      cachedTranscript = transcript;
      return transcript;
    }

    const playerResponse = findPlayerResponse();
    let tracks = getCaptionTracks(playerResponse);
    if (!tracks.length) {
      const freshPlayerResponse = await loadPlayerResponseFromInnertube();
      tracks = getCaptionTracks(freshPlayerResponse);
    }
    if (!tracks.length) {
      tracks = getTracksFromYouTubePlayer();
    }
    if (!tracks.length) {
      tracks = await getTimedTextTracks();
    }
    if (!tracks.length) {
      const panelTranscript = await loadTranscriptFromVisiblePanel();
      if (panelTranscript) {
        currentVideoId = getVideoId();
        cachedTranscript = panelTranscript;
        return panelTranscript;
      }
      throw new Error('This video does not expose captions that the extension can read.');
    }

    transcript = '';
    for (const track of tracks) {
      for (const format of ['json3', 'srv3', 'vtt', '']) {
        const captionUrl = new URL(track.baseUrl);
        if (format) {
          captionUrl.searchParams.set('fmt', format);
        } else {
          captionUrl.searchParams.delete('fmt');
        }
        const response = await fetch(captionUrl.toString());
        if (response.ok) {
          transcript = parseCaptionText(await response.text());
        }
        if (transcript) break;
      }

      if (transcript) break;
    }

    if (!transcript) {
      transcript = await loadTranscriptFromYouTubePanel();
    }

    if (!transcript) {
      transcript = await loadTranscriptFromVisiblePanel();
    }

    if (!transcript) throw new Error('No captions/transcript were found for this video.');

    currentVideoId = getVideoId();
    cachedTranscript = transcript;
    if (currentVideoId) transcriptCache.set(currentVideoId, transcript);
    return transcript;
  }

  async function transcriptFromTracks(tracks) {
    let transcript = '';
    for (const track of tracks) {
      for (const format of ['json3', 'srv3', 'vtt', '']) {
        const captionUrl = new URL(track.baseUrl);
        if (format) {
          captionUrl.searchParams.set('fmt', format);
        } else {
          captionUrl.searchParams.delete('fmt');
        }
        const response = await fetch(captionUrl.toString(), { credentials: 'include' });
        if (response.ok) {
          transcript = parseCaptionText(await response.text());
        }
        if (transcript) break;
      }

      if (transcript) break;
    }
    return transcript;
  }

  async function loadTranscriptByVideoId(videoId) {
    if (!videoId) throw new Error('Select a YouTube video first.');
    if (transcriptCache.has(videoId)) return transcriptCache.get(videoId);
    if (videoId === getVideoId()) return loadTranscript();

    let pageInitialData = null;
    let pageInnertubeConfig = getInnertubeConfig();
    let tracks = await getTimedTextTracks(videoId);
    let transcript = tracks.length ? await transcriptFromTracks(tracks) : '';
    if (!transcript) {
      const response = await fetch(`/watch?v=${encodeURIComponent(videoId)}&hl=en`, { credentials: 'include' });
      if (response.ok) {
        const html = await response.text();
        const playerResponse = extractJsonObject(html, 'ytInitialPlayerResponse');
        pageInitialData = extractJsonObject(html, 'ytInitialData');
        const fetchedConfig = getInnertubeConfigFromText(html);
        if (fetchedConfig.apiKey && fetchedConfig.context) pageInnertubeConfig = fetchedConfig;
        tracks = getCaptionTracks(playerResponse);
        transcript = tracks.length ? await transcriptFromTracks(tracks) : '';
      }
    }

    if (!transcript) {
      const freshPlayerResponse = await loadPlayerResponseFromInnertube(videoId, pageInnertubeConfig);
      tracks = getCaptionTracks(freshPlayerResponse);
      transcript = tracks.length ? await transcriptFromTracks(tracks) : '';
    }

    if (!transcript) {
      transcript = await loadTranscriptFromInnertubeForVideo(videoId, pageInitialData, pageInnertubeConfig);
    }

    if (!transcript) {
      transcript = await loadTranscriptFromTemporaryTab(videoId);
    }

    if (!transcript) {
      throw new Error('This video did not expose a readable transcript from the card. The extension tried direct captions and a temporary watch tab. If YouTube still blocks it, use a video with captions or open the video and try again.');
    }

    transcriptCache.set(videoId, transcript);
    return transcript;
  }

  async function loadTranscriptEvidenceByVideoId(videoId, maxRows = 5) {
    if (!videoId) return [];
    const tracks = await getTimedTextTracks(videoId).catch(() => []);
    for (const track of tracks) {
      try {
        const response = await fetch(track.baseUrl, { credentials: 'include' });
        if (!response.ok) continue;
        const data = await response.json();
        const rows = (Array.isArray(data.events) ? data.events : []).map((event) => {
          const text = (event.segs || []).map((seg) => seg.utf8 || '').join('').replace(/\s+/g, ' ').trim();
          if (!text) return null;
          return {
            seconds: Math.max(0, Math.floor((event.tStartMs || 0) / 1000)),
            text,
          };
        }).filter(Boolean);
        if (rows.length) return rows.slice(0, maxRows);
      } catch (_error) {}
    }
    return [];
  }

  async function loadTranscriptFromTemporaryTab(videoId) {
    setStatus('Summarizing, please wait...');
    const response = await Promise.race([
      chrome.runtime.sendMessage({
        type: 'YT_VIDEO_ASSISTANT_EXTRACT_TRANSCRIPT_IN_TEMP_TAB',
        videoId,
      }).catch((error) => ({ ok: false, error: error?.message || 'Background transcript extraction failed.' })),
      sleep(65000).then(() => ({ ok: false, error: 'Background transcript extraction timed out.' })),
    ]);
    return response?.ok ? String(response.transcript || '') : '';
  }

  async function loadActiveTranscript() {
    const video = getActiveVideo();
    if (!video?.videoId) throw new Error('Select a YouTube video first.');
    return loadTranscriptByVideoId(video.videoId);
  }

  async function loadPlayerResponseFromInnertube(videoId = getVideoId(), config = getInnertubeConfig()) {
    if (!videoId || !config.apiKey || !config.context) return null;
    return postInnertube('/youtubei/v1/player', {
      context: config.context,
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }, config);
  }

  function getXmlAttribute(node, name) {
    return node.getAttribute(name) || '';
  }

  async function getTimedTextTracks(videoId = getVideoId()) {
    if (!videoId) return [];

    const response = await fetch(`/api/timedtext?type=list&v=${encodeURIComponent(videoId)}`);
    if (!response.ok) return [];

    const xml = new DOMParser().parseFromString(await response.text(), 'text/xml');
    const tracks = Array.from(xml.querySelectorAll('track')).map((track) => {
      const lang = getXmlAttribute(track, 'lang_code');
      const kind = getXmlAttribute(track, 'kind');
      const url = new URL('/api/timedtext', location.origin);
      url.searchParams.set('v', videoId);
      url.searchParams.set('lang', lang);
      url.searchParams.set('fmt', 'json3');
      if (kind) url.searchParams.set('kind', kind);

      return {
        baseUrl: url.toString(),
        languageCode: lang,
        kind,
      };
    });

    return [
      ...tracks.filter((track) => track.languageCode?.startsWith('en') && track.kind === 'asr'),
      ...tracks.filter((track) => track.languageCode?.startsWith('en') && track.kind !== 'asr'),
      ...tracks.filter((track) => track.kind === 'asr'),
      ...tracks.filter((track) => track.kind !== 'asr'),
    ];
  }

  function findTranscriptParams(node) {
    if (!node || typeof node !== 'object') return '';
    if (typeof node.params === 'string' && /Cg|CA/.test(node.params)) return node.params;

    for (const value of Object.values(node)) {
      const found = findTranscriptParams(value);
      if (found) return found;
    }

    return '';
  }

  function getYouTubeInitialData() {
    const scripts = Array.from(document.scripts);
    for (const script of scripts) {
      const text = script.textContent || '';
      const parsed = extractJsonObject(text, 'ytInitialData');
      if (parsed) return parsed;
    }

    return null;
  }

  function getInnertubeConfigFromText(text) {
      const apiKey = text.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
      const context = extractJsonObject(text, '"INNERTUBE_CONTEXT"');
      if (apiKey && context) {
        return { apiKey, context };
      }
    return { apiKey: '', context: null };
  }

  function getInnertubeConfig() {
    const scripts = Array.from(document.scripts);
    for (const script of scripts) {
      const config = getInnertubeConfigFromText(script.textContent || '');
      if (config.apiKey && config.context) return config;
    }

    return { apiKey: '', context: null };
  }

  function parseTranscriptRenderer(node, rows = []) {
    if (!node || typeof node !== 'object') return rows;

    const cue = node.transcriptSegmentRenderer;
    if (cue?.snippet?.runs) {
      const text = cue.snippet.runs.map((run) => run.text || '').join('').trim();
      if (text) rows.push(text);
    }

    for (const value of Object.values(node)) {
      parseTranscriptRenderer(value, rows);
    }

    return rows;
  }

  function findTranscriptEndpoints(node, endpoints = []) {
    if (!node || typeof node !== 'object') return endpoints;

    if (typeof node.params === 'string' && /Cg|CA/.test(node.params)) {
      endpoints.push({ params: node.params });
    }
    if (node.getTranscriptEndpoint?.params) {
      endpoints.push({ params: node.getTranscriptEndpoint.params });
    }
    if (node.continuationCommand?.token) {
      endpoints.push({ continuation: node.continuationCommand.token });
    }

    for (const value of Object.values(node)) {
      findTranscriptEndpoints(value, endpoints);
    }

    return endpoints;
  }

  function parseTranscriptRendererWithContinuations(node, rows = [], continuations = []) {
    if (!node || typeof node !== 'object') return { rows, continuations };

    const cue = node.transcriptSegmentRenderer;
    if (cue?.snippet?.runs) {
      const text = cue.snippet.runs.map((run) => run.text || '').join('').replace(/\s+/g, ' ').trim();
      if (text) rows.push(text);
    }
    if (node.continuationCommand?.token) {
      continuations.push(node.continuationCommand.token);
    }

    for (const value of Object.values(node)) {
      parseTranscriptRendererWithContinuations(value, rows, continuations);
    }

    return { rows, continuations };
  }

  function dedupeLines(lines) {
    const seen = new Set();
    const result = [];
    for (const line of lines.map((item) => String(item || '').replace(/\s+/g, ' ').trim()).filter(Boolean)) {
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(line);
    }
    return result;
  }

  async function postInnertube(path, body, config = getInnertubeConfig()) {
    if (!config.apiKey || !config.context) return null;
    const response = await fetch(`${path}?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  }

  async function fetchTranscriptEndpoint(endpoint, config) {
    const payload = endpoint.params
      ? { context: config.context, params: endpoint.params }
      : { context: config.context, continuation: endpoint.continuation };
    const data = await postInnertube('/youtubei/v1/get_transcript', payload, config);
    if (!data) return { transcript: '', continuations: [] };
    const parsed = parseTranscriptRendererWithContinuations(data);
    return {
      transcript: dedupeLines(parsed.rows).join(' '),
      continuations: [...new Set(parsed.continuations)],
    };
  }

  async function loadTranscriptFromInnertubeForVideo(videoId, pageInitialData = null, config = getInnertubeConfig()) {
    if (!videoId || !config.apiKey || !config.context) return '';

    const nextData = await postInnertube('/youtubei/v1/next', {
      context: config.context,
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }, config);

    const endpoints = [
      ...findTranscriptEndpoints(pageInitialData),
      ...findTranscriptEndpoints(nextData),
    ];
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

  async function loadTranscriptFromYouTubePanel() {
    const initialData = getYouTubeInitialData();
    const params = findTranscriptParams(initialData);
    const { apiKey, context } = getInnertubeConfig();

    if (!params || !apiKey || !context) return '';

    const response = await fetch(`/youtubei/v1/get_transcript?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, params }),
    });

    if (!response.ok) return '';

    const data = await response.json().catch(() => null);
    const rows = parseTranscriptRenderer(data);
    return decodeEntities(rows.join(' ').replace(/\s+/g, ' ').trim());
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getVisibleText(element) {
    return (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function transcriptRowsFromDom() {
    return Array.from(document.querySelectorAll(
      'ytd-transcript-segment-renderer, ytd-transcript-segment-list-renderer ytd-transcript-segment-renderer'
    ))
      .map(getVisibleText)
      .filter(Boolean);
  }

  function transcriptSignature(rows) {
    return rows.join('\n').slice(0, 5000);
  }

  function isVisibleElement(element) {
    const rect = element?.getBoundingClientRect?.();
    const style = element ? getComputedStyle(element) : null;
    return Boolean(
      rect
      && rect.width > 0
      && rect.height > 0
      && style?.display !== 'none'
      && style?.visibility !== 'hidden'
    );
  }

  async function clickYouTubeControl(matcher) {
    const controls = Array.from(document.querySelectorAll(
      'button, yt-button-shape button, tp-yt-paper-button, ytd-button-renderer button, '
      + 'ytd-video-description-transcript-section-renderer button, #description button'
    ));
    const matches = controls.filter((control) => matcher(`${getVisibleText(control)} ${control.getAttribute('aria-label') || ''}`));
    const control = matches.find(isVisibleElement) || matches[0];
    if (!control) return false;
    control.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    await sleep(200);
    control.click();
    return true;
  }

  async function loadTranscriptFromVisiblePanel() {
    const beforeSignature = transcriptSignature(transcriptRowsFromDom());

    const inlineMoreButton = document.querySelector('#description-inline-expander tp-yt-paper-button#expand')
      || document.querySelector('tp-yt-paper-button#expand');
    if (inlineMoreButton) {
      inlineMoreButton.scrollIntoView?.({ block: 'center', inline: 'nearest' });
      inlineMoreButton.click();
    } else {
      await clickYouTubeControl((label) => /more|show more|\.\.\.more|mais|mostrar mais/i.test(label));
    }
    await sleep(1200);

    await clickYouTubeControl((label) => /transcript|show transcript|transcrição|mostrar transcrição|transcricao|mostrar transcricao/i.test(label));
    let rows = [];
    for (let attempt = 0; attempt < 18; attempt += 1) {
      await sleep(500);
      rows = transcriptRowsFromDom();
      if (rows.length && transcriptSignature(rows) !== beforeSignature) break;
    }

    if (rows.length && transcriptSignature(rows) !== beforeSignature) {
      ignoreVisibleTranscriptUntilOpened = false;
      return rows.join(' ').replace(/\s+/g, ' ').trim();
    }

    return '';
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement('aside');
    panel.id = PANEL_ID;

    const header = document.createElement('div');
    header.className = 'yt-va-header';
    const title = document.createElement('strong');
    title.textContent = 'YouTube Researcher AI';
    const headerActions = document.createElement('div');
    headerActions.className = 'yt-va-header-actions';
    const settingsButton = document.createElement('button');
    settingsButton.type = 'button';
    settingsButton.className = 'yt-va-settings-button';
    settingsButton.setAttribute('aria-label', 'Settings');
    settingsButton.textContent = '⚙';
    const archiveButton = document.createElement('button');
    archiveButton.type = 'button';
    archiveButton.className = 'yt-va-archive-button';
    archiveButton.setAttribute('aria-label', 'History');
    archiveButton.textContent = 'History';
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'yt-va-clear-button';
    clearButton.setAttribute('aria-label', 'Clear panel');
    clearButton.textContent = 'Clear panel';
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'yt-va-close';
    closeButton.setAttribute('aria-label', 'Hide panel');
    closeButton.textContent = 'Hide';
    headerActions.append(archiveButton, clearButton, settingsButton, closeButton);
    header.append(title, headerActions);

    const status = document.createElement('div');
    status.className = 'yt-va-status';
    status.textContent = 'Ready.';

    const output = document.createElement('div');
    output.className = 'yt-va-output';
    const selected = document.createElement('section');
    selected.className = 'yt-va-selected';
    selected.innerHTML = [
      '<div class="yt-va-selected-empty">Select a YouTube video, then choose Full or Extreme.</div>',
    ].join('');
    const finder = document.createElement('section');
    finder.className = 'yt-va-finder';
    const finderHeader = document.createElement('div');
    finderHeader.className = 'yt-va-finder-header';
    const finderTitle = document.createElement('strong');
    finderTitle.textContent = 'Find and research videos';
    const finderToggle = document.createElement('button');
    finderToggle.id = 'yt-va-results-toggle';
    finderToggle.type = 'button';
    finderToggle.textContent = '▲';
    finderToggle.setAttribute('aria-label', 'Collapse results');
    finderHeader.append(finderTitle, finderToggle);
    const finderRow = document.createElement('div');
    finderRow.className = 'yt-va-finder-row';
    const finderInput = document.createElement('input');
    finderInput.id = 'yt-va-search-input';
    finderInput.type = 'search';
    finderInput.placeholder = 'How to lose belly fat';
    const finderButton = document.createElement('button');
    finderButton.id = 'yt-va-search-button';
    finderButton.type = 'button';
    finderButton.textContent = 'Find';
    const researchButton = document.createElement('button');
    researchButton.id = 'yt-va-research-button';
    researchButton.type = 'button';
    researchButton.textContent = 'Research';
    finderRow.append(finderInput, finderButton, researchButton);
    const filterRow = document.createElement('div');
    filterRow.className = 'yt-va-filter-row';
    const dateFilter = document.createElement('select');
    dateFilter.id = 'yt-va-date-filter';
    dateFilter.setAttribute('aria-label', 'Date filter');
    for (const option of [
      { value: 'any', label: 'Any date' },
      { value: 'today', label: 'Today' },
      { value: '3', label: '3 days' },
      { value: '7', label: '7 days' },
      { value: '15', label: '15 days' },
      { value: '30', label: '30 days' },
      { value: '50', label: '50 days' },
      { value: '80', label: '80 days' },
      { value: '100', label: '100 days' },
    ]) {
      const item = document.createElement('option');
      item.value = option.value;
      item.textContent = option.label;
      dateFilter.append(item);
    }
    const viewFilter = document.createElement('select');
    viewFilter.id = 'yt-va-view-filter';
    viewFilter.setAttribute('aria-label', 'View filter');
    for (const option of [
      { value: '0', label: 'Any views' },
      { value: '1000', label: '1K+ views' },
      { value: '10000', label: '10K+ views' },
      { value: '100000', label: '100K+ views' },
      { value: '1000000', label: '1M+ views' },
      { value: '10000000', label: '10M+ views' },
    ]) {
      const item = document.createElement('option');
      item.value = option.value;
      item.textContent = option.label;
      viewFilter.append(item);
    }
    const sortSelect = document.createElement('select');
    sortSelect.id = 'yt-va-sort-by';
    sortSelect.setAttribute('aria-label', 'Sort videos');
    for (const option of [
      { value: 'views', label: 'Sort: views' },
      { value: 'newest', label: 'Sort: newest' },
      { value: 'best', label: 'Sort: best' },
    ]) {
      const item = document.createElement('option');
      item.value = option.value;
      item.textContent = option.label;
      sortSelect.append(item);
    }
    filterRow.append(dateFilter, viewFilter, sortSelect);
    const batchRow = document.createElement('div');
    batchRow.className = 'yt-va-batch-row';
    const batchPreset = document.createElement('select');
    batchPreset.id = 'yt-va-batch-preset';
    batchPreset.setAttribute('aria-label', 'Videos to summarize');
    for (const option of [
      { value: 'top3', label: 'Top 3' },
      { value: 'top5', label: 'Top 5' },
      { value: 'top10', label: 'Top 10' },
      { value: 'checked', label: 'Checked' },
      { value: 'custom', label: 'Custom #s' },
    ]) {
      const item = document.createElement('option');
      item.value = option.value;
      item.textContent = option.label;
      batchPreset.append(item);
    }
    const batchInput = document.createElement('input');
    batchInput.id = 'yt-va-batch-input';
    batchInput.type = 'text';
    batchInput.placeholder = '1-5, 8';
    batchInput.setAttribute('aria-label', 'Video numbers to summarize');
    batchInput.hidden = true;
    const batchButton = document.createElement('button');
    batchButton.id = 'yt-va-batch-summary-button';
    batchButton.type = 'button';
    batchButton.textContent = 'Summarize selected';
    batchRow.append(batchPreset, batchInput, batchButton);
    const finderResults = document.createElement('div');
    finderResults.className = 'yt-va-search-results';
    finder.append(finderHeader, finderRow, filterRow, batchRow, finderResults);
    const settings = createSettingsView();

    const form = document.createElement('form');
    form.className = 'yt-va-form';
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Ask about this video...';
    textarea.rows = 3;
    const askButton = document.createElement('button');
    askButton.type = 'submit';
    askButton.textContent = 'Ask';
    const fullButton = document.createElement('button');
    fullButton.type = 'button';
    fullButton.className = 'yt-va-full';
    fullButton.textContent = 'Full';
    const readButton = document.createElement('button');
    readButton.type = 'button';
    readButton.className = 'yt-va-read';
    readButton.textContent = 'Read';
    const readTarget = document.createElement('select');
    readTarget.id = 'yt-va-read-target';
    for (const option of [
      { value: 'latest', label: 'Read latest' },
      { value: 'full', label: 'Read full' },
      { value: 'extreme', label: 'Read extreme' },
    ]) {
      const item = document.createElement('option');
      item.value = option.value;
      item.textContent = option.label;
      readTarget.append(item);
    }
    const extremeButton = document.createElement('button');
    extremeButton.type = 'button';
    extremeButton.className = 'yt-va-extreme';
    extremeButton.textContent = 'Extreme';
    const audio = document.createElement('audio');
    audio.className = 'yt-va-audio';
    audio.controls = true;
    form.append(textarea, fullButton, extremeButton, readTarget, readButton, askButton, audio);

    panel.append(header, status, selected, finder, output, settings, form);
    document.body.appendChild(panel);

    closeButton.addEventListener('click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      panel.classList.remove('is-open');
    });

    settingsButton.addEventListener('click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      showSettings(true);
    });
    archiveButton.addEventListener('click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      showArchive();
    });
    clearButton.addEventListener('click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      clearOutput();
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!isTrustedUserEvent(event)) return;
      const question = textarea.value.trim();
      if (!question) return;
      await askQuestion(question);
      textarea.value = '';
    });

    readButton.addEventListener('click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      readSelectedText();
    });
    fullButton.addEventListener('click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      summarizeVideo();
    });
    extremeButton.addEventListener('click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      extremeSummary();
    });
    finderButton.addEventListener('click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      searchVideos(finderInput.value.trim());
    });
    researchButton.addEventListener('click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      researchVideos(finderInput.value.trim());
    });
    batchPreset.addEventListener('change', (event) => {
      if (!isTrustedUserEvent(event)) return;
      batchInput.hidden = batchPreset.value !== 'custom';
    });
    batchButton.addEventListener('click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      summarizeNumberedVideosFromControls();
    });
    finderInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (!isTrustedUserEvent(event)) return;
      searchVideos(finderInput.value.trim());
    });
    finderToggle.addEventListener('click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      toggleResults();
    });
    for (const filter of [dateFilter, viewFilter, sortSelect]) {
      filter.addEventListener('change', (event) => {
        if (!isTrustedUserEvent(event)) return;
        applyFinderFilters();
      });
    }

    return panel;
  }

  function createSettingsInput(id, label, type = 'text') {
    const wrapper = document.createElement('label');
    wrapper.className = 'yt-va-settings-field';
    wrapper.textContent = label;
    const input = document.createElement('input');
    input.id = id;
    input.type = type;
    input.autocomplete = 'off';
    wrapper.append(input);
    return wrapper;
  }

  function createSettingsSelect(id, label, options) {
    const wrapper = document.createElement('label');
    wrapper.className = 'yt-va-settings-field';
    wrapper.textContent = label;
    const select = document.createElement('select');
    select.id = id;
    for (const option of options) {
      const item = document.createElement('option');
      item.value = option.value;
      item.textContent = option.label;
      select.append(item);
    }
    wrapper.append(select);
    return wrapper;
  }

  function createSettingsView() {
    const settings = document.createElement('div');
    settings.className = 'yt-va-settings';
    settings.hidden = true;

    const chatTitle = document.createElement('h3');
    chatTitle.textContent = 'Chat Model';
    const voiceTitle = document.createElement('h3');
    voiceTitle.textContent = 'Voice';
    const licenseTitle = document.createElement('h3');
    licenseTitle.textContent = 'Open Source';
    const licenseStatus = document.createElement('p');
    licenseStatus.id = 'yt-va-license-status';
    licenseStatus.className = 'yt-va-settings-note';
    licenseStatus.textContent = 'Free open-source edition.';
    const privacyNote = document.createElement('p');
    privacyNote.className = 'yt-va-settings-note';
    privacyNote.textContent = 'Chat sends transcript text and questions to your saved chat endpoint. Read sends generated text to ElevenLabs only when clicked. History is stored locally in this browser. API keys are stored only in extension Options.';
    const keyStatus = document.createElement('p');
    keyStatus.id = 'yt-va-key-status';
    keyStatus.className = 'yt-va-settings-note';
    keyStatus.textContent = 'Keys: checking...';
    const openKeySettings = document.createElement('button');
    openKeySettings.id = 'yt-va-open-key-settings';
    openKeySettings.className = 'yt-va-secondary-button';
    openKeySettings.type = 'button';
    openKeySettings.textContent = 'Open key settings';
    const buyPro = document.createElement('a');
    buyPro.className = 'yt-va-secondary-link';
    buyPro.href = 'https://github.com/tiagolinnerhall/d04-products-youtube-researcher-ai';
    buyPro.target = '_blank';
    buyPro.rel = 'noreferrer';
    buyPro.textContent = 'Project page';

    settings.append(
      chatTitle,
      privacyNote,
      keyStatus,
      openKeySettings,
      createSettingsSelect('yt-va-chat-provider', 'Provider', [
        { value: 'openai-compatible', label: 'OpenAI-compatible' },
        { value: 'anthropic', label: 'Anthropic Claude' },
      ]),
      createSettingsSelect('yt-va-chat-url', 'API endpoint', [
        { value: 'https://api.deepseek.com/chat/completions', label: 'DeepSeek API' },
        { value: 'https://api.openai.com/v1/chat/completions', label: 'OpenAI API' },
        { value: 'https://openrouter.ai/api/v1/chat/completions', label: 'OpenRouter API' },
        { value: 'https://api.x.ai/v1/chat/completions', label: 'xAI / Grok API' },
        { value: 'https://api.anthropic.com/v1/messages', label: 'Anthropic API' },
        { value: 'http://localhost:11434/v1/chat/completions', label: 'Ollama local' },
        { value: 'http://localhost:1234/v1/chat/completions', label: 'LM Studio local' },
        { value: 'custom', label: 'Custom endpoint' },
      ]),
      createSettingsInput('yt-va-chat-url-custom', 'Custom endpoint URL', 'url'),
      createSettingsSelect('yt-va-chat-model', 'Model', [
        { value: 'deepseek-chat', label: 'DeepSeek Chat' },
        { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
        { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
        { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
        { value: 'openrouter/auto', label: 'OpenRouter Auto' },
        { value: 'anthropic/claude-3.5-sonnet', label: 'Claude via OpenRouter' },
        { value: 'claude-3-5-haiku-latest', label: 'Claude Haiku direct' },
        { value: 'claude-sonnet-4-5', label: 'Claude Sonnet direct' },
        { value: 'grok-3-mini', label: 'Grok 3 Mini' },
        { value: 'llama3.1', label: 'Local Llama' },
        { value: 'qwen2.5', label: 'Local Qwen' },
        { value: 'custom', label: 'Custom model' },
      ]),
      createSettingsInput('yt-va-chat-model-custom', 'Custom model name'),
      voiceTitle,
      createSettingsSelect('yt-va-voice-en', 'English voice', [
        { value: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel - clear' },
        { value: 'pNInz6obpgDQGcFmaJgB', label: 'Adam - deep' },
        { value: 'ErXwobaYiN019PkySvjV', label: 'Antoni - warm' },
        { value: 'EXAVITQu4vr4xnSDxMaL', label: 'Bella - soft' },
        { value: 'custom', label: 'Custom' },
      ]),
      createSettingsInput('yt-va-voice-en-custom', 'Custom English voice ID'),
      createSettingsSelect('yt-va-voice-pt', 'Portuguese voice', [
        { value: 'ErXwobaYiN019PkySvjV', label: 'Antoni - PT/BR' },
        { value: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel - PT/BR' },
        { value: 'pNInz6obpgDQGcFmaJgB', label: 'Adam - PT/BR' },
        { value: 'EXAVITQu4vr4xnSDxMaL', label: 'Bella - PT/BR' },
        { value: 'custom', label: 'Custom' },
      ]),
      createSettingsInput('yt-va-voice-pt-custom', 'Custom Portuguese voice ID')
    );

    settings.append(
      licenseTitle,
      licenseStatus,
      createSettingsInput('yt-va-license-key', 'License key'),
      createSettingsInput('yt-va-restore-email', 'Restore purchase email', 'email'),
      buyPro
    );

    const actions = document.createElement('div');
    actions.className = 'yt-va-settings-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save';
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'Back';
    const validate = document.createElement('button');
    validate.type = 'button';
    validate.textContent = 'Validate License';
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.textContent = 'Restore';
    actions.append(save, validate, restore, back);
    settings.append(actions);

    save.addEventListener('click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      saveSettings();
    });
    back.addEventListener('click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      showSettings(false);
    });
    validate.addEventListener('click', async (event) => {
      if (!isTrustedUserEvent(event)) return;
      const key = ensurePanel().querySelector('#yt-va-license-key').value;
      try {
        setStatus('Validating license...');
        const data = await validateProLicense(key);
        ensurePanel().querySelector('#yt-va-license-status').textContent = `License: ${data.status || 'active'} (${data.email || 'validated user'})`;
        setStatus(`Access active: ${data.status}.`);
      } catch (error) {
        setStatus(error.message || 'License validation failed.');
      }
    });
    restore.addEventListener('click', async (event) => {
      if (!isTrustedUserEvent(event)) return;
      const email = ensurePanel().querySelector('#yt-va-restore-email').value;
      try {
        setStatus('Restoring Pro purchase...');
        const response = await chrome.runtime.sendMessage({
          type: 'YT_VIDEO_ASSISTANT_RESTORE_PURCHASE',
          email,
        });
        if (!response?.ok) throw new Error(response?.error || 'Purchase restore failed.');
        await saveProState({
          ytVaLicenseKey: response.license.licenseKey || '',
          ytVaLicenseStatus: response.license.status || 'active',
          ytVaLicenseEmail: response.license.email || email,
          ytVaLicenseTrialEndsAt: response.license.trialEndsAt || '',
          ytVaLicenseCurrentPeriodEnd: response.license.currentPeriodEnd || '',
          ytVaProValidatedAt: Date.now(),
          ytVaFreeActionsUsed: 0,
        });
        ensurePanel().querySelector('#yt-va-license-key').value = response.license.licenseKey || '';
        ensurePanel().querySelector('#yt-va-license-status').textContent = `License: ${response.license.status || 'active'} (${response.license.email || email})`;
        setStatus('Access restored in this browser.');
      } catch (error) {
        setStatus(error.message || 'Purchase restore failed.');
      }
    });
    openKeySettings.addEventListener('click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      chrome.runtime.sendMessage({ type: 'YT_VIDEO_ASSISTANT_OPEN_OPTIONS' });
    });

    return settings;
  }

  function setSelectOrCustom(select, input, value, fallback) {
    const finalValue = value || fallback;
    const option = Array.from(select.options).find((item) => item.value === finalValue);
    if (option) {
      select.value = finalValue;
      input.value = '';
    } else {
      select.value = 'custom';
      input.value = finalValue;
    }
  }

  function getSelectOrCustom(select, input, fallback) {
    return select.value === 'custom' ? (input.value.trim() || fallback) : select.value;
  }

  async function loadSettingsIntoPanel() {
    const response = await chrome.runtime.sendMessage({ type: 'YT_VIDEO_ASSISTANT_GET_PUBLIC_SETTINGS' });
    const stored = response?.settings || SETTINGS_DEFAULTS;
    const panel = ensurePanel();
    panel.querySelector('#yt-va-chat-provider').value = stored.chatProvider || SETTINGS_DEFAULTS.chatProvider;
    setSelectOrCustom(
      panel.querySelector('#yt-va-chat-url'),
      panel.querySelector('#yt-va-chat-url-custom'),
      stored.chatApiUrl,
      SETTINGS_DEFAULTS.chatApiUrl
    );
    panel.querySelector('#yt-va-key-status').textContent = [
      `Chat key: ${stored.hasChatApiKey ? 'saved' : 'missing'}`,
      `ElevenLabs key: ${stored.hasElevenLabsApiKey ? 'saved' : 'missing'}`,
    ].join(' | ');
    const licenseState = await loadProState();
    panel.querySelector('#yt-va-license-key').value = licenseState.ytVaLicenseKey || '';
    panel.querySelector('#yt-va-restore-email').value = licenseState.ytVaLicenseEmail || '';
    panel.querySelector('#yt-va-license-status').textContent = isProActive(licenseState)
      ? `License: ${licenseState.ytVaLicenseStatus} (${licenseState.ytVaLicenseEmail || 'validated user'})`
      : `License: not active. ${Math.max(0, FREE_TRIAL_ACTION_LIMIT - Number(licenseState.ytVaFreeActionsUsed || 0))} free AI actions left.`;
    setSelectOrCustom(
      panel.querySelector('#yt-va-chat-model'),
      panel.querySelector('#yt-va-chat-model-custom'),
      stored.chatModel,
      SETTINGS_DEFAULTS.chatModel
    );
    setSelectOrCustom(
      panel.querySelector('#yt-va-voice-en'),
      panel.querySelector('#yt-va-voice-en-custom'),
      stored.elevenLabsEnglishVoiceId,
      SETTINGS_DEFAULTS.elevenLabsEnglishVoiceId
    );
    setSelectOrCustom(
      panel.querySelector('#yt-va-voice-pt'),
      panel.querySelector('#yt-va-voice-pt-custom'),
      stored.elevenLabsPortugueseVoiceId,
      SETTINGS_DEFAULTS.elevenLabsPortugueseVoiceId
    );
  }

  async function saveSettings() {
    const panel = ensurePanel();
    const chatApiUrl = getSelectOrCustom(
      panel.querySelector('#yt-va-chat-url'),
      panel.querySelector('#yt-va-chat-url-custom'),
      SETTINGS_DEFAULTS.chatApiUrl
    );
    const response = await chrome.runtime.sendMessage({
      type: 'YT_VIDEO_ASSISTANT_SAVE_SETTINGS',
      settings: {
        chatApiUrl,
        chatProvider: panel.querySelector('#yt-va-chat-provider').value || SETTINGS_DEFAULTS.chatProvider,
        chatModel: getSelectOrCustom(
          panel.querySelector('#yt-va-chat-model'),
          panel.querySelector('#yt-va-chat-model-custom'),
          SETTINGS_DEFAULTS.chatModel
        ),
        elevenLabsEnglishVoiceId: getSelectOrCustom(
          panel.querySelector('#yt-va-voice-en'),
          panel.querySelector('#yt-va-voice-en-custom'),
          SETTINGS_DEFAULTS.elevenLabsEnglishVoiceId
        ),
        elevenLabsPortugueseVoiceId: getSelectOrCustom(
          panel.querySelector('#yt-va-voice-pt'),
          panel.querySelector('#yt-va-voice-pt-custom'),
          SETTINGS_DEFAULTS.elevenLabsPortugueseVoiceId
        ),
      },
    });
    const permission = response?.permission;
    setStatus(
      response?.ok && permission?.ok
        ? 'Settings saved. Keys stay in Options.'
        : (response?.error || permission?.error || 'Settings saved. API permission still needs approval.')
    );
    showSettings(false);
  }

  async function showSettings(show) {
    const panel = ensurePanel();
    if (show) await loadSettingsIntoPanel();
    panel.querySelector('.yt-va-settings').hidden = !show;
    panel.querySelector('.yt-va-output').hidden = show;
    panel.querySelector('.yt-va-selected').hidden = show;
    panel.querySelector('.yt-va-finder').hidden = show;
    panel.querySelector('.yt-va-form').hidden = show;
    panel.classList.add('is-open');
  }

  function renderSelectedVideo() {
    const panel = ensurePanel();
    const container = panel.querySelector('.yt-va-selected');
    const video = getActiveVideo();
    container.textContent = '';
    if (!video) {
      const empty = document.createElement('div');
      empty.className = 'yt-va-selected-empty';
      empty.textContent = 'Select a YouTube video, then choose Full or Extreme.';
      container.append(empty);
      return;
    }

    const img = document.createElement('img');
    img.src = video.thumbnail;
    img.alt = '';
    const meta = document.createElement('div');
    meta.className = 'yt-va-selected-meta';
    const label = document.createElement('span');
    label.className = 'yt-va-selected-label';
    label.textContent = video.videoId === getVideoId() ? 'Current video' : 'Selected video';
    const title = document.createElement('a');
    title.href = video.url;
    title.target = '_blank';
    title.rel = 'noreferrer';
    title.textContent = video.title || 'Selected YouTube video';
    const details = document.createElement('small');
    details.textContent = [video.channel, video.views].filter(Boolean).join(' • ');
    const actions = document.createElement('div');
    actions.className = 'yt-va-selected-actions';
    const open = document.createElement('a');
    open.href = video.url;
    open.target = '_blank';
    open.rel = 'noreferrer';
    open.textContent = 'Open video';
    actions.append(open);
    meta.append(label, title, details, actions);
    container.append(img, meta);
  }

  function selectVideo(video) {
    const normalized = normalizeVideoSelection(video);
    if (!normalized) {
      setStatus('Could not read the video link.');
      return null;
    }
    const previousVideoId = selectedVideo?.videoId || getVideoId();
    selectedVideo = normalized;
    if (normalized.videoId !== previousVideoId) {
      activeRequestToken += 1;
      cachedSummary = '';
      latestReadableText = '';
      latestFullText = '';
      latestExtremeText = '';
      const output = ensurePanel().querySelector('.yt-va-output');
      if (output) output.textContent = '';
      const audio = ensurePanel().querySelector('.yt-va-audio');
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.hidden = true;
      }
      if (currentAudioUrl) {
        URL.revokeObjectURL(currentAudioUrl);
        currentAudioUrl = '';
      }
    }
    renderSelectedVideo();
    showSettings(false);
    toggleResults(true);
    setStatus('Video selected. Choose Full or Extreme.');
    ensurePanel().classList.add('is-open');
    return normalized;
  }

  function setStatus(message) {
    const panel = ensurePanel();
    panel.classList.add('is-open');
    panel.querySelector('.yt-va-status').textContent = message;
  }

  function toggleResults(forceCollapsed = null) {
    const panel = ensurePanel();
    const results = panel.querySelector('.yt-va-search-results');
    const toggle = panel.querySelector('#yt-va-results-toggle');
    const shouldCollapse = forceCollapsed === null ? !results.classList.contains('is-collapsed') : forceCollapsed;
    results.classList.toggle('is-collapsed', shouldCollapse);
    const count = results.querySelectorAll('.yt-va-result').length;
    toggle.textContent = shouldCollapse ? `Show ${count || ''}`.trim() : 'Hide';
    toggle.setAttribute('aria-label', shouldCollapse ? 'Show results' : 'Collapse results');
  }

  function setBusy(isBusy) {
    const panel = ensurePanel();
    for (const button of panel.querySelectorAll('.yt-va-form button, .yt-va-finder button, .yt-va-search-results button, .yt-va-batch-row button')) {
      button.disabled = isBusy;
    }
    const floatingButton = document.getElementById(BUTTON_ID);
    if (floatingButton) floatingButton.disabled = isBusy;
  }

  function cleanOutputLine(line) {
    return line
      .replace(/^#{1,4}\s*/, '')
      .replace(/\*\*/g, '')
      .trim();
  }

  function isHeadingLine(line) {
    const cleaned = cleanOutputLine(line);
    return (
      /^[✦◆◈✧?]\s+/.test(cleaned)
      || /^(Summary|Main Points|Details to Remember|Follow-Up Questions|Direct Answer|Details From The Video|Extreme Summary)$/i.test(cleaned)
    );
  }

  function normalizeBulletLine(line) {
    return cleanOutputLine(line).replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '').trim();
  }

  function renderFormattedText(text) {
    const wrapper = document.createElement('div');
    wrapper.className = 'yt-va-rich-output';
    let list = null;

    const closeList = () => {
      list = null;
    };

    for (const rawLine of String(text || '').split(/\r?\n/)) {
      const line = cleanOutputLine(rawLine);
      if (!line) {
        closeList();
        continue;
      }

      if (isHeadingLine(line)) {
        closeList();
        const heading = document.createElement('h4');
        heading.textContent = /^[✦◆◈✧?]\s+/.test(line) ? line : `✦ ${line}`;
        wrapper.append(heading);
        continue;
      }

      if (/^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
        if (!list) {
          list = document.createElement('ul');
          wrapper.append(list);
        }
        const item = document.createElement('li');
        item.textContent = normalizeBulletLine(line);
        list.append(item);
        continue;
      }

      closeList();
      const paragraph = document.createElement('p');
      paragraph.textContent = line;
      wrapper.append(paragraph);
    }

    return wrapper;
  }

  function stripDuplicateOutputHeading(title, text) {
    const lines = String(text || '').split(/\r?\n/);
    const firstIndex = lines.findIndex((line) => cleanOutputLine(line));
    if (firstIndex < 0) return '';
    const normalizedTitle = cleanOutputLine(title).toLowerCase();
    const firstLine = cleanOutputLine(lines[firstIndex])
      .replace(/^[✦◆◈✧?]\s+/, '')
      .toLowerCase();
    if (firstLine === normalizedTitle) {
      lines.splice(firstIndex, 1);
      return lines.join('\n').replace(/^\s+/, '');
    }
    return text;
  }

  function appendOutput(title, text, options = {}) {
    const output = ensurePanel().querySelector('.yt-va-output');
    const displayText = stripDuplicateOutputHeading(title, text);
    const section = document.createElement('section');
    section.className = 'yt-va-section';
    const heading = document.createElement('h3');
    heading.textContent = title;
    const body = renderFormattedText(displayText);
    section.append(heading);
    if (options.exportable) section.append(renderExportActions(title, options.exportText || displayText));
    section.append(body);
    output.append(section);
    output.scrollTop = output.scrollHeight;
    latestReadableText = `${title}\n${displayText}`;
  }

  function clearOutput() {
    const panel = ensurePanel();
    activeRequestToken += 1;
    selectedVideo = null;
    cachedSummary = '';
    latestReadableText = '';
    latestFullText = '';
    latestExtremeText = '';
    lastFinderResults = [];
    lastRenderedResults = [];
    lastFinderMode = 'search';
    currentArchive = null;
    archiveReturnFragment = null;
    archiveReturnStatus = '';

    const clearPanelSurface = () => {
      const activePanel = ensurePanel();
      const output = activePanel.querySelector('.yt-va-output');
      if (output) output.textContent = '';
      const selected = activePanel.querySelector('.yt-va-selected');
      if (selected) {
        selected.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'yt-va-selected-empty';
        empty.textContent = 'Select a YouTube video, then choose Full or Extreme.';
        selected.append(empty);
      }
      const searchInput = activePanel.querySelector('#yt-va-search-input');
      if (searchInput) searchInput.value = '';
      const dateFilter = activePanel.querySelector('#yt-va-date-filter');
      if (dateFilter) dateFilter.value = 'any';
      const viewFilter = activePanel.querySelector('#yt-va-view-filter');
      if (viewFilter) viewFilter.value = '0';
      const sortFilter = activePanel.querySelector('#yt-va-sort-by');
      if (sortFilter) sortFilter.value = 'views';
      const results = activePanel.querySelector('.yt-va-search-results');
      if (results) {
        results.textContent = '';
        results.classList.remove('is-collapsed');
      }
      const toggle = activePanel.querySelector('#yt-va-results-toggle');
      if (toggle) {
        toggle.textContent = 'Hide';
        toggle.setAttribute('aria-label', 'Collapse results');
      }
      const textarea = activePanel.querySelector('.yt-va-form textarea');
      if (textarea) textarea.value = '';
      const batchInput = activePanel.querySelector('#yt-va-batch-input');
      if (batchInput) batchInput.value = '';
      const batchPreset = activePanel.querySelector('#yt-va-batch-preset');
      if (batchPreset) batchPreset.value = 'top3';
      for (const checkbox of activePanel.querySelectorAll('.yt-va-result-check')) {
        checkbox.checked = false;
      }
      const audio = activePanel.querySelector('.yt-va-audio');
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.hidden = true;
      }
    };

    clearPanelSurface();
    const output = panel.querySelector('.yt-va-output');
    if (output) output.textContent = '';
    const selected = panel.querySelector('.yt-va-selected');
    if (selected) {
      selected.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'yt-va-selected-empty';
      empty.textContent = 'Select a YouTube video, then choose Full or Extreme.';
      selected.append(empty);
    }
    const searchInput = panel.querySelector('#yt-va-search-input');
    if (searchInput) searchInput.value = '';
    const dateFilter = panel.querySelector('#yt-va-date-filter');
    if (dateFilter) dateFilter.value = 'any';
    const viewFilter = panel.querySelector('#yt-va-view-filter');
    if (viewFilter) viewFilter.value = '0';
    const sortSelect = panel.querySelector('#yt-va-sort-by');
    if (sortSelect) sortSelect.value = 'views';
    const results = panel.querySelector('.yt-va-search-results');
    if (results) {
      results.textContent = '';
      results.classList.remove('is-collapsed');
    }
    const toggle = panel.querySelector('#yt-va-results-toggle');
    if (toggle) {
      toggle.textContent = 'Hide';
      toggle.setAttribute('aria-label', 'Collapse results');
    }
    const textarea = panel.querySelector('.yt-va-form textarea');
    if (textarea) textarea.value = '';
    const batchInput = panel.querySelector('#yt-va-batch-input');
    if (batchInput) batchInput.value = '';
    const batchPreset = panel.querySelector('#yt-va-batch-preset');
    if (batchPreset) batchPreset.value = 'top3';
    const audio = panel.querySelector('.yt-va-audio');
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.hidden = true;
    }
    if (currentAudioUrl) {
      URL.revokeObjectURL(currentAudioUrl);
      currentAudioUrl = '';
    }
    setStatus('Cleared.');
    setTimeout(clearPanelSurface, 50);
    setTimeout(clearPanelSurface, 250);
  }

  function formatArchiveTime(timestamp) {
    try {
      return new Date(timestamp).toLocaleString();
    } catch (_error) {
      return '';
    }
  }

  async function copyTextToClipboard(text) {
    await navigator.clipboard.writeText(String(text || ''));
  }

  function downloadTextFile(filename, text) {
    const blob = new Blob([String(text || '')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function slugifyFilename(text) {
    return String(text || 'youtube-research')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'youtube-research';
  }

  function restoreBeforeHistory() {
    const panel = ensurePanel();
    const output = panel.querySelector('.yt-va-output');
    output.textContent = '';
    if (archiveReturnFragment?.childNodes?.length) {
      output.append(archiveReturnFragment);
      archiveReturnFragment = null;
      setStatus(archiveReturnStatus || 'Restored previous view.');
      archiveReturnStatus = '';
      return;
    }
    setStatus('Previous view restored.');
  }

  function renderExportActions(label, text) {
    const actions = document.createElement('div');
    actions.className = 'yt-va-export-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async (event) => {
      if (!isTrustedUserEvent(event)) return;
      await copyTextToClipboard(text);
      setStatus('Copied.');
    });
    const download = document.createElement('button');
    download.type = 'button';
    download.textContent = 'Download';
    download.addEventListener('click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      downloadTextFile(`${slugifyFilename(label)}.md`, text);
      setStatus('Downloaded markdown.');
    });
    actions.append(copy, download);
    return actions;
  }

  async function showArchive() {
    const video = getActiveVideo();
    const archive = video?.videoId ? await loadArchive(video.videoId, video) : createArchive('', video);
    const researchArchive = await loadResearchArchive();
    const output = ensurePanel().querySelector('.yt-va-output');
    if (!output.querySelector('.yt-va-archive-view')) {
      archiveReturnFragment = document.createDocumentFragment();
      while (output.firstChild) archiveReturnFragment.append(output.firstChild);
      archiveReturnStatus = ensurePanel().querySelector('.yt-va-status')?.textContent || '';
    }
    output.textContent = '';
    const section = document.createElement('section');
    section.className = 'yt-va-section yt-va-archive-view';
    const heading = document.createElement('h3');
    heading.textContent = 'History';
    section.append(heading);
    const backButton = document.createElement('button');
    backButton.type = 'button';
    backButton.className = 'yt-va-back-history';
    backButton.textContent = 'Back to summary';
    backButton.addEventListener('click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      restoreBeforeHistory();
    });
    section.append(backButton);
    if (video?.videoId) {
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'yt-va-delete-history';
      deleteButton.textContent = 'Delete this video history';
      deleteButton.addEventListener('click', async (event) => {
        if (!isTrustedUserEvent(event)) return;
        if (!confirm('Delete saved summaries, answers, and audio for this video?')) return;
        await chrome.storage.local.remove(archiveKey(video.videoId));
        await audioDbDeleteForVideo(video.videoId).catch(() => {});
        currentArchive = createArchive(video.videoId, video);
        clearOutput();
        setStatus('History deleted for this video.');
      });
      section.append(deleteButton);
    }
    if (!archive.entries.length) {
      const empty = document.createElement('p');
      empty.className = 'yt-va-archive-empty';
      empty.textContent = video?.videoId
        ? 'No saved summaries or answers for this video yet.'
        : 'Select a video to see video-specific history.';
      section.append(empty);
    }
    for (const entry of [...archive.entries].reverse()) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'yt-va-archive-item';
      const type = document.createElement('span');
      type.className = 'yt-va-archive-type';
      type.textContent = entry.kind || 'saved';
      const title = document.createElement('strong');
      title.textContent = entry.title || entry.kind;
      const preview = document.createElement('p');
      preview.textContent = String(entry.text || '').replace(/\s+/g, ' ').slice(0, 180);
      const time = document.createElement('small');
      time.textContent = [formatArchiveTime(entry.createdAt), entry.model].filter(Boolean).join(' • ');
      item.append(type, title, preview, time);
      item.addEventListener('click', (event) => {
        if (!isTrustedUserEvent(event)) return;
        output.textContent = '';
        appendOutput(entry.title || entry.kind, entry.text || '', { exportable: true });
      });
      section.append(item);
    }
    const researchHeading = document.createElement('h3');
    researchHeading.textContent = 'Research Archive';
    section.append(researchHeading);
    if (!researchArchive.length) {
      const empty = document.createElement('p');
      empty.className = 'yt-va-archive-empty';
      empty.textContent = 'No saved topic research yet.';
      section.append(empty);
    }
    for (const record of researchArchive.slice(0, 50)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'yt-va-archive-item';
      const type = document.createElement('span');
      type.className = 'yt-va-archive-type';
      type.textContent = 'research';
      const title = document.createElement('strong');
      title.textContent = record.title || `Research: ${record.topic || 'topic'}`;
      const preview = document.createElement('p');
      preview.textContent = String(record.text || '').replace(/\s+/g, ' ').slice(0, 180);
      const time = document.createElement('small');
      const sourceCount = Array.isArray(record.videos) ? `${record.videos.length} sources` : '';
      time.textContent = [formatArchiveTime(record.createdAt), sourceCount].filter(Boolean).join(' • ');
      item.append(type, title, preview, time);
      item.addEventListener('click', (event) => {
        if (!isTrustedUserEvent(event)) return;
        output.textContent = '';
        const combined = [record.text, record.matrix].filter(Boolean).join('\n\n');
        appendOutput(record.title || 'Research Brief', record.text || '', { exportable: true, exportText: combined });
        if (record.matrix) appendOutput('Comparison Matrix', record.matrix, { exportable: true, exportText: combined });
      });
      section.append(item);
    }
    output.append(section);
    output.scrollTop = 0;
    setStatus(`Archive: ${archive.entries.length} video item${archive.entries.length === 1 ? '' : 's'}, ${researchArchive.length} research item${researchArchive.length === 1 ? '' : 's'}.`);
  }

  function base64ToBlob(base64, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  }

  function isTrustedUserEvent(event) {
    if (event?.isTrusted) return true;
    setStatus('Use the visible button directly.');
    return false;
  }

  function getReadText() {
    const target = ensurePanel().querySelector('#yt-va-read-target')?.value || 'latest';
    if (target === 'extreme') return latestExtremeText || latestReadableText;
    if (target === 'full') return latestFullText || latestReadableText;
    return latestReadableText;
  }

  async function readSelectedText() {
    try {
      const textToRead = getReadText();
      if (!textToRead.trim()) {
        throw new Error('Nothing to read yet. Create that summary or answer first.');
      }

      setBusy(true);
      await requireProAccess();
      setStatus('Generating voice...');
      const response = await chrome.runtime.sendMessage({
        type: 'YT_VIDEO_ASSISTANT_ELEVENLABS',
        text: textToRead,
      });

      if (!response?.ok) {
        throw new Error(response?.error || 'Voice generation failed.');
      }

      if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
      const blob = base64ToBlob(response.audioBase64, response.mimeType || 'audio/mpeg');
      currentAudioUrl = URL.createObjectURL(blob);
      const audio = ensurePanel().querySelector('.yt-va-audio');
      audio.src = currentAudioUrl;
      audio.hidden = false;
      await audio.play();
      setStatus('Reading.');
    } catch (error) {
      setStatus(error.message || 'Voice generation failed.');
    } finally {
      setBusy(false);
    }
  }

  async function callAssistant(payload) {
    const response = await chrome.runtime.sendMessage({
      type: 'YT_VIDEO_ASSISTANT_DEEPSEEK',
      payload: {
        mode: payload.mode,
        prompt: buildPrompt(payload),
      },
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'DeepSeek request failed.');
    }

    return response.text;
  }

  async function summarizeVideo() {
    try {
      setBusy(true);
      await requireProAccess();
      const video = getActiveVideo();
      if (!video) throw new Error('Select a YouTube video first.');
      const requestToken = activeRequestToken;
      setStatus('Summarizing, please wait...');
      const transcript = await loadActiveTranscript();
      if (requestToken !== activeRequestToken || getActiveVideo()?.videoId !== video.videoId) {
        setBusy(false);
        return;
      }
      setStatus('Creating summary...');
      const text = await callAssistant({
        mode: 'summary',
        videoId: video.videoId,
        title: video.title,
        url: video.url,
        transcript,
      });
      if (requestToken !== activeRequestToken || getActiveVideo()?.videoId !== video.videoId) {
        setBusy(false);
        return;
      }
      cachedSummary = text;
      latestFullText = `Full Summary\n${text}`;
      appendOutput('Full Summary', text);
      archiveEntry('summary', 'Full Summary', text, '', video);
      setStatus('Done.');
    } catch (error) {
      setStatus(error.message || 'Failed to summarize video.');
    } finally {
      setBusy(false);
    }
  }

  async function extremeSummary() {
    try {
      setBusy(true);
      await requireProAccess();
      const video = getActiveVideo();
      if (!video) throw new Error('Select a YouTube video first.');
      const requestToken = activeRequestToken;
      setStatus('Creating extreme summary, please wait...');
      const transcript = await loadActiveTranscript();
      if (requestToken !== activeRequestToken || getActiveVideo()?.videoId !== video.videoId) {
        setBusy(false);
        return;
      }
      const text = await callAssistant({
        mode: 'extreme',
        videoId: video.videoId,
        title: video.title,
        url: video.url,
        transcript,
      });
      if (requestToken !== activeRequestToken || getActiveVideo()?.videoId !== video.videoId) {
        setBusy(false);
        return;
      }
      latestExtremeText = `Extreme Summary\n${text}`;
      latestReadableText = latestExtremeText;
      appendOutput('Extreme Summary', text);
      archiveEntry('extreme', 'Extreme Summary', text, '', video);
      setStatus('Done.');
    } catch (error) {
      setStatus(error.message || 'Failed to create extreme summary.');
    } finally {
      setBusy(false);
    }
  }

  async function askQuestion(question) {
    try {
      setBusy(true);
      await requireProAccess();
      const video = getActiveVideo();
      if (!video) throw new Error('Select a YouTube video first.');
      const requestToken = activeRequestToken;
      setStatus('Preparing answer, please wait...');
      const transcript = await loadActiveTranscript();
      if (requestToken !== activeRequestToken || getActiveVideo()?.videoId !== video.videoId) {
        setBusy(false);
        return;
      }
      setStatus('Preparing answer...');
      const text = await callAssistant({
        mode: 'question',
        videoId: video.videoId,
        title: video.title,
        url: video.url,
        transcript,
        question,
      });
      if (requestToken !== activeRequestToken || getActiveVideo()?.videoId !== video.videoId) {
        setBusy(false);
        return;
      }
      appendOutput(question, text);
      archiveEntry('question', question, text, question, video);
      setStatus(cachedSummary ? 'Done.' : 'Done. You can also summarize first.');
    } catch (error) {
      setStatus(error.message || 'Failed to answer question.');
    } finally {
      setBusy(false);
    }
  }

  function readTextNode(node) {
    if (!node || typeof node !== 'object') return '';
    if (typeof node.simpleText === 'string') return node.simpleText;
    if (Array.isArray(node.runs)) return node.runs.map((run) => run.text || '').join('').trim();
    return '';
  }

  function collectVideoRenderers(node, results = [], limit = SEARCH_RESULT_LIMIT) {
    if (!node || typeof node !== 'object' || results.length >= limit) return results;
    if (node.videoRenderer?.videoId) {
      const renderer = node.videoRenderer;
      const videoId = renderer.videoId;
      if (!results.some((item) => item.videoId === videoId)) {
        const thumbnail = renderer.thumbnail?.thumbnails?.at?.(-1)?.url
          || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        results.push({
          videoId,
          title: readTextNode(renderer.title) || 'YouTube video',
          url: videoUrl(videoId),
          thumbnail,
          channel: readTextNode(renderer.ownerText || renderer.longBylineText || renderer.shortBylineText),
          views: readTextNode(renderer.viewCountText || renderer.shortViewCountText),
          published: readTextNode(renderer.publishedTimeText),
          source: 'search',
        });
      }
    }

    for (const value of Object.values(node)) collectVideoRenderers(value, results, limit);
    return results;
  }

  function findSearchContinuations(node, continuations = []) {
    if (!node || typeof node !== 'object') return continuations;
    if (node.continuationCommand?.token) continuations.push(node.continuationCommand.token);
    for (const value of Object.values(node)) findSearchContinuations(value, continuations);
    return continuations;
  }

  async function fetchSearchContinuation(continuation, config) {
    return postInnertube('/youtubei/v1/search', {
      context: config.context,
      continuation,
    }, config);
  }

  async function collectSearchResults(query, limit = SEARCH_RESULT_LIMIT) {
      const response = await fetch(`/results?search_query=${encodeURIComponent(query)}&sp=CAMSAhAB`, {
      credentials: 'include',
    });
    if (!response.ok) throw new Error('YouTube search could not be loaded.');
    const html = await response.text();
    const initialData = extractJsonObject(html, 'ytInitialData');
    const config = getInnertubeConfigFromText(html);
    const results = collectVideoRenderers(initialData, [], limit);
    const seenContinuations = new Set();
    const queue = findSearchContinuations(initialData)
      .filter((token) => {
        if (!token || seenContinuations.has(token)) return false;
        seenContinuations.add(token);
        return true;
      });

    while (results.length < limit && queue.length && config.apiKey && config.context) {
      const data = await fetchSearchContinuation(queue.shift(), config);
      if (!data) break;
      collectVideoRenderers(data, results, limit);
      for (const token of findSearchContinuations(data)) {
        if (!token || seenContinuations.has(token)) continue;
        seenContinuations.add(token);
        queue.push(token);
      }
    }

    return results.slice(0, limit);
  }

  function parseViewCount(viewsText) {
    const text = String(viewsText || '')
      .toLowerCase()
      .replace(/,/g, '')
      .replace(/\s+/g, ' ');
    const match = text.match(/([\d.]+)\s*([kmb]|mil|mi|mio|millon|millones|million|millions|bilhao|bilhão|bilhoes|bilhões|billion|billions)?/);
    if (!match) return 0;
    const value = Number(match[1]) || 0;
    const unit = match[2] || '';
    const multiplier = ['b', 'bilhao', 'bilhão', 'bilhoes', 'bilhões', 'billion', 'billions'].includes(unit)
      ? 1_000_000_000
      : ['m', 'mi', 'mio', 'millon', 'millones', 'million', 'millions'].includes(unit)
        ? 1_000_000
        : ['k', 'mil'].includes(unit)
          ? 1_000
          : 1;
    return Math.round(value * multiplier);
  }

  function sortByPopularity(results) {
    return [...results].sort((a, b) => parseViewCount(b.views) - parseViewCount(a.views));
  }

  function tokenizeQuery(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !['the', 'and', 'for', 'with', 'how', 'best', 'video', 'videos'].includes(word));
  }

  function boundedScore(value, max) {
    return Math.max(0, Math.min(max, Math.round(value)));
  }

  function textHasAny(text, patterns) {
    return patterns.some((pattern) => pattern.test(text));
  }

  function titleCaseRisk(title = '') {
    const letters = String(title).replace(/[^A-Za-z]/g, '');
    if (letters.length < 8) return 0;
    const upper = letters.replace(/[^A-Z]/g, '').length / letters.length;
    return upper > 0.65 ? 10 : upper > 0.45 ? 5 : 0;
  }

  function publishedFreshnessScore(published = '') {
    const text = String(published || '').toLowerCase();
    if (/(hour|day|week|month|today|yesterday)/.test(text)) return 10;
    const years = Number(text.match(/(\d+)\s+year/)?.[1] || 0);
    if (!years) return 5;
    if (years <= 2) return 8;
    if (years <= 5) return 5;
    return 2;
  }

  function publishedAgeDays(published = '') {
    const text = String(published || '').toLowerCase();
    if (!text) return Infinity;
    if (/today|just now|agora|hoje/.test(text)) return 0;
    if (/yesterday|ontem/.test(text)) return 1;
    const match = text.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|s|m|h|d|w|mo|yr|yrs|segundos?|minutos?|horas?|dias?|semanas?|m[eê]ses?|anos?)/);
    if (!match) return Infinity;
    const value = Number(match[1]) || 0;
    const unit = match[2];
    if (/^(s|seconds?|secs?|segundos?)$/.test(unit)) return value / 86400;
    if (/^(m|minutes?|mins?|minutos?)$/.test(unit)) return value / 1440;
    if (/^(h|hours?|hrs?|horas?)$/.test(unit)) return value / 24;
    if (/^(d|days?|dias?)$/.test(unit)) return value;
    if (/^(w|weeks?|semanas?)$/.test(unit)) return value * 7;
    if (/^(mo|months?|m[eê]ses?)$/.test(unit)) return value * 31;
    if (/^(yr|yrs|years?|anos?)$/.test(unit)) return value * 365;
    return Infinity;
  }

  function activeDateSearchQuery(query, filters = getFinderFilters()) {
    const days = filters.days === 'today' ? 1 : Number(filters.days || 0);
    if (!Number.isFinite(days) || days <= 0) return query;
    const after = new Date();
    after.setDate(after.getDate() - days);
    const yyyy = after.getFullYear();
    const mm = String(after.getMonth() + 1).padStart(2, '0');
    const dd = String(after.getDate()).padStart(2, '0');
    return `${query} after:${yyyy}-${mm}-${dd}`;
  }

  function getFinderFilters() {
    const panel = ensurePanel();
    return {
      days: panel.querySelector('#yt-va-date-filter')?.value || 'any',
      minViews: Number(panel.querySelector('#yt-va-view-filter')?.value || 0),
      sortBy: panel.querySelector('#yt-va-sort-by')?.value || 'views',
    };
  }

  function applyVideoFilters(results, topic = '') {
    const filters = getFinderFilters();
    const maxDays = filters.days === 'any'
      ? Infinity
      : filters.days === 'today'
        ? 1
        : Number(filters.days);
    let filtered = [...results].filter((video) => {
      const viewsOk = parseViewCount(video.views) >= filters.minViews;
      const age = publishedAgeDays(video.published);
      const ageOk = maxDays === Infinity || (filters.days === 'today' ? age < 1 : age <= maxDays);
      return viewsOk && ageOk;
    });

    if (filters.sortBy === 'newest') {
      filtered.sort((a, b) => publishedAgeDays(a.published) - publishedAgeDays(b.published));
    } else if (filters.sortBy === 'best') {
      filtered = rankResearchResults(filtered, topic);
    } else {
      filtered = sortByPopularity(filtered);
    }
    return filtered.slice(0, SEARCH_RESULT_LIMIT);
  }

  function applyFinderFilters() {
    const panel = ensurePanel();
    const resultsBox = panel.querySelector('.yt-va-search-results');
    if (!lastFinderResults.length) {
      setStatus('Search first, then filter the results.');
      return [];
    }
    const topic = panel.querySelector('#yt-va-search-input')?.value.trim() || '';
    const filtered = applyVideoFilters(lastFinderResults, topic);
    renderSearchResults(resultsBox, filtered);
    toggleResults(false);
    setStatus(filtered.length
      ? `Showing ${filtered.length} filtered video${filtered.length === 1 ? '' : 's'} from ${lastFinderResults.length} candidates.`
      : `No videos matched those filters from ${lastFinderResults.length} candidates. Widen date or lower views.`);
    return filtered;
  }

  function scoreVideoForResearch(video, topic = '', transcript = '') {
    const titleText = `${video.title || ''} ${video.channel || ''}`.toLowerCase();
    const transcriptText = String(transcript || '').toLowerCase();
    const terms = tokenizeQuery(topic);
    const relevance = boundedScore(terms.reduce((score, term) => (
      score + (titleText.includes(term) ? 5 : 0) + (transcriptText.includes(term) ? 2 : 0)
    ), 0), 25);
    const reach = boundedScore(Math.log10(Math.max(1, parseViewCount(video.views))) * 3.2, 20);
    const transcriptCoverage = transcript ? boundedScore(8 + Math.min(transcript.length, 18000) / 900, 25) : 0;
    const evidenceSignals = [
      /science[-\s]?based/i, /evidence/i, /study/i, /studies/i, /research/i, /clinical/i,
      /meta[-\s]?analysis/i, /trial/i, /data/i, /explained/i,
    ];
    const expertiseSignals = [
      /\bdoctor\b/i, /\bdr\.?\b/i, /\bprofessor\b/i, /\bphd\b/i, /\bscientist\b/i,
      /\bexpert\b/i, /\bcoach\b/i, /\btrainer\b/i, /\bclinic\b/i, /\buniversity\b/i,
      /\bacademy\b/i, /\binstitute\b/i, /\bhuberman\b/i, /\bethier\b/i, /\bnippard\b/i,
    ];
    const practicalSignals = [
      /how to/i, /guide/i, /workout/i, /plan/i, /steps/i, /routine/i, /mistakes/i,
      /beginner/i, /protocol/i, /tool/i, /strategy/i,
    ];
    const clickbaitSignals = [
      /shocking/i, /secret/i, /destroy/i, /never/i, /miracle/i, /instantly/i,
      /one trick/i, /fastest/i, /guaranteed/i, /what happened next/i, /they don't want/i,
    ];
    const evidenceQuality = boundedScore(
      (transcript ? 8 : 0) + (textHasAny(titleText, evidenceSignals) ? 12 : 4),
      20
    );
    const expertise = textHasAny(titleText, expertiseSignals) ? 15 : 6;
    const practicality = textHasAny(titleText, practicalSignals) ? 15 : 7;
    const recency = publishedFreshnessScore(video.published);
    const clickbaitRisk = boundedScore(
      (textHasAny(video.title || '', clickbaitSignals) ? 14 : 3) + titleCaseRisk(video.title),
      20
    );
    const overall = Math.max(1, Math.min(100, Math.round(
      relevance + reach + evidenceQuality + transcriptCoverage + expertise + practicality + recency - clickbaitRisk
    )));
    return {
      overall,
      relevance,
      reach,
      evidenceQuality,
      transcriptCoverage,
      expertise,
      practicality,
      recency,
      clickbaitRisk,
    };
  }

  function qualityReason(video, scores, topic = '') {
    const terms = tokenizeQuery(topic);
    const title = `${video.title || ''} ${video.channel || ''}`.toLowerCase();
    const matches = terms.filter((term) => title.includes(term)).slice(0, 2);
    const reasons = [];
    if (matches.length) reasons.push(`matches ${matches.join(', ')}`);
    if (scores.evidenceQuality >= 14) reasons.push('evidence signal');
    if (scores.expertise >= 12) reasons.push('expert source');
    if (scores.practicality >= 12) reasons.push('practical');
    if (scores.clickbaitRisk >= 14) reasons.push('clickbait risk');
    if (video.views) reasons.push(video.views);
    return reasons.slice(0, 4).join(' • ') || (video.researchQuery ? `Found through ${video.researchQuery}` : 'Relevant YouTube result');
  }

  function rankResearchResults(results, topic) {
    return [...results].map((video) => {
      const scores = scoreVideoForResearch(video, topic);
      return {
        ...video,
        rankingScore: scores.overall,
        rankingScores: scores,
        rankingReason: qualityReason(video, scores, topic),
      };
    }).sort((a, b) => (b.rankingScore || 0) - (a.rankingScore || 0));
  }

  function fallbackResearchQueries(topic) {
    const cleaned = String(topic || '').trim();
    return [
      cleaned,
      `${cleaned} science based`,
      `${cleaned} expert guide`,
      `${cleaned} full workout`,
      `${cleaned} mistakes`,
      `${cleaned} beginner`,
    ].filter(Boolean);
  }

  function parseResearchQueries(text, topic) {
    const candidates = String(text || '')
      .split(/\r?\n|[,;]+/)
      .map((line) => line.replace(/^[-*\d.)\s"]+/, '').replace(/[".]+$/, '').trim())
      .filter((line) => line.length >= 4 && line.length <= 90)
      .slice(0, 8);
    const merged = [...candidates, ...fallbackResearchQueries(topic)];
    return [...new Set(merged.map((item) => item.trim()).filter(Boolean))].slice(0, 8);
  }

  async function generateResearchQueries(topic) {
    const prompt = [
      'Create YouTube search queries for researching the best videos on this topic.',
      'Return only 6 short search queries, one per line.',
      'Use different angles: science-based, expert guide, beginner, practical steps, mistakes, popular long-form.',
      'Do not number them.',
      '',
      `Topic: ${topic}`,
    ].join('\n');
    const response = await chrome.runtime.sendMessage({
      type: 'YT_VIDEO_ASSISTANT_DEEPSEEK',
      payload: { mode: 'research', prompt },
    }).catch(() => null);
    if (!response?.ok || !response.text) return fallbackResearchQueries(topic);
    return parseResearchQueries(response.text, topic);
  }

  async function collectResearchResults(topic) {
    const queries = await generateResearchQueries(topic);
    const byId = new Map();
    const filters = getFinderFilters();
    for (const query of queries) {
      setStatus(`Researching YouTube: ${query}`);
      const filteredQuery = activeDateSearchQuery(query, filters);
      const results = await collectSearchResults(filteredQuery, SEARCH_CANDIDATE_LIMIT).catch(() => []);
      for (const video of results) {
        if (!byId.has(video.videoId)) byId.set(video.videoId, { ...video, researchQuery: query });
      }
      if (byId.size >= SEARCH_CANDIDATE_LIMIT) break;
    }
    lastFinderResults = rankResearchResults([...byId.values()], topic);
    lastFinderMode = 'research';
    return applyVideoFilters(lastFinderResults, topic);
  }

  function sampleTranscriptForResearch(transcript, maxChars = 9000) {
    const text = String(transcript || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxChars) return text;
    const part = Math.floor(maxChars / 3);
    const middleStart = Math.max(0, Math.floor(text.length / 2) - Math.floor(part / 2));
    return [
      text.slice(0, part),
      text.slice(middleStart, middleStart + part),
      text.slice(-part),
    ].join('\n[...middle of transcript sampled...]\n');
  }

  function describeRisk(score) {
    if (score >= 15) return 'high';
    if (score >= 8) return 'medium';
    return 'low';
  }

  function formatTimestamp(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    const hrs = Math.floor(safe / 3600);
    const mins = Math.floor((safe % 3600) / 60);
    const secs = safe % 60;
    return hrs
      ? `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function timestampUrl(video, seconds) {
    return `${video.url || videoUrl(video.videoId)}&t=${Math.max(0, Number(seconds) || 0)}s`;
  }

  function buildFallbackResearchBrief(topic, reviewed, transcriptCount) {
    const best = reviewed[0];
    const strong = reviewed.filter((video) => video.sourceScores.overall >= 65).slice(0, 3);
    const risky = reviewed.filter((video) => video.sourceScores.clickbaitRisk >= 12).slice(0, 3);
    const practical = reviewed.filter((video) => video.sourceScores.practicality >= 12).slice(0, 3);
    return [
      '✦ Best Video',
      best
        ? `• ${best.title} — strongest local score (${best.sourceScores.overall}/100) because ${best.rankingReason}.`
        : '• No videos could be reviewed.',
      '',
      '◆ Consensus Across Sources',
      strong.length
        ? `• The strongest candidates combine topic relevance, evidence/expertise signals, practical guidance, and enough reach to be worth checking.`
        : '• The available candidates are mixed; use the matrix below before trusting one source.',
      `• Transcript coverage: ${transcriptCount} of ${reviewed.length} reviewed videos had transcript evidence.`,
      '',
      '◈ Contradictions',
      '• The local ranking cannot verify every claim without the model pass, so treat metadata-only videos as lower confidence.',
      risky.length
        ? `• Higher-risk titles: ${risky.map((video) => video.title).join('; ')}.`
        : '• No strong clickbait pattern dominated the reviewed set.',
      '',
      '✧ Practical Action Plan',
      practical.length
        ? `• Start with practical videos: ${practical.map((video) => video.title).join('; ')}.`
        : '• Start with the highest overall score, then compare it with at least two other reviewed sources.',
      '• Prefer videos with transcripts, evidence signals, clear steps, and moderate clickbait risk.',
      '',
      '◆ Red Flags',
      '• Be careful with titles promising instant, secret, miracle, guaranteed, or one-trick results.',
      '• Popularity is treated as reach, not proof.',
      '',
      '◈ Videos Reviewed',
      ...reviewed.map((video, index) => `• #${index + 1}: ${video.title} — ${video.sourceScores.overall}/100, ${video.transcriptAvailable ? 'transcript reviewed' : 'metadata only'}.`),
      '',
      'Note: This local brief was generated because the model response was unavailable. The ranking matrix below is still based on the extension quality scoring.',
    ].join('\n');
  }

  async function buildResearchBrief(topic, results) {
    const reviewTarget = Math.min(10, results.length);
    const reviewed = [];
    let transcriptCount = 0;
    for (const video of results.slice(0, reviewTarget)) {
      setStatus(`Reviewing source ${reviewed.length + 1} of ${reviewTarget}...`);
      const transcript = await loadTranscriptByVideoId(video.videoId).catch(() => '');
      const evidenceRows = transcript ? await loadTranscriptEvidenceByVideoId(video.videoId, 4).catch(() => []) : [];
      if (transcript) transcriptCount += 1;
      const scores = scoreVideoForResearch(video, topic, transcript);
      reviewed.push({
        ...video,
        rankingScore: scores.overall,
        rankingScores: scores,
        rankingReason: qualityReason(video, scores, topic),
        transcript: sampleTranscriptForResearch(transcript, 9000),
        evidenceRows,
        transcriptAvailable: Boolean(transcript),
        sourceScores: scores,
      });
      if (transcriptCount >= 8) break;
    }

    const evidence = reviewed.map((video, index) => [
      `Video ${index + 1}: ${video.title}`,
      `Channel: ${video.channel || 'Unknown'}`,
      `Views: ${video.views || 'Unknown'}`,
      `Published: ${video.published || 'Unknown'}`,
      `URL: ${video.url}`,
      `Transcript available: ${video.transcriptAvailable ? 'yes' : 'no'}`,
      `Quality scores: overall ${video.sourceScores.overall}/100, evidence ${video.sourceScores.evidenceQuality}/20, expertise ${video.sourceScores.expertise}/15, practicality ${video.sourceScores.practicality}/15, reach ${video.sourceScores.reach}/20, recency ${video.sourceScores.recency}/10, clickbait risk ${video.sourceScores.clickbaitRisk}/20.`,
      `Ranking note: ${video.rankingReason}`,
      video.evidenceRows?.length
        ? `Timestamp evidence: ${video.evidenceRows.map((row) => `${formatTimestamp(row.seconds)} ${row.text}`).join(' | ')}`
        : 'Timestamp evidence: unavailable',
      video.transcript ? `Transcript excerpt: ${video.transcript}` : 'Transcript excerpt: unavailable',
    ].join('\n')).join('\n\n');

    const matrix = [
      '◈ Source Matrix',
      ...reviewed.map((video, index) => {
        const scores = video.sourceScores;
        return [
          `• #${index + 1} | Overall ${scores.overall}/100 | ${video.title}`,
          `  Evidence ${scores.evidenceQuality}/20 | Expertise ${scores.expertise}/15 | Practicality ${scores.practicality}/15 | Reach ${scores.reach}/20 | Recency ${scores.recency}/10 | Risk ${describeRisk(scores.clickbaitRisk)} | ${video.transcriptAvailable ? 'transcript reviewed' : 'metadata only'}`,
          `  Why: ${video.rankingReason}`,
          ...(video.evidenceRows || []).slice(0, 2).map((row) => `  Source: ${formatTimestamp(row.seconds)} — ${row.text.slice(0, 180)} (${timestampUrl(video, row.seconds)})`),
        ].join('\n');
      }),
      '',
      `Coverage: ${reviewed.length} videos reviewed; ${transcriptCount} transcript${transcriptCount === 1 ? '' : 's'} available. Metadata-only sources are lower confidence.`,
      '',
    ].join('\n');

    let text = '';
    try {
      text = await callAssistant({
        mode: 'research-brief',
        title: `Research: ${topic}`,
        url: location.href,
        transcript: [
          `Topic: ${topic}`,
          `Coverage: ${reviewed.length} videos reviewed, ${transcriptCount} full/partial transcripts available.`,
          'Use the quality scores as guidance, but explain evidence limitations. Do not select a video only because it has the most views.',
          '',
          'Candidate videos ranked by the extension:',
          ...results.slice(0, 12).map((video, index) => `${index + 1}. Score ${video.rankingScore || '?'} | ${video.title} | ${video.channel || 'Unknown'} | ${video.views || 'Unknown'} | ${video.published || 'Unknown'} | ${video.url} | ${video.rankingReason || ''}`),
          '',
          'Criteria-based comparison matrix:',
          matrix,
          '',
          'Reviewed transcript evidence:',
          evidence,
        ].join('\n'),
      });
    } catch (error) {
      text = buildFallbackResearchBrief(topic, reviewed, transcriptCount);
      setStatus(`Research ranked locally. ${error.message || 'Model unavailable.'}`);
    }

    const exportText = [`# Research: ${topic}`, text, matrix].join('\n\n');
    appendOutput('Research Brief', text, { exportable: true, exportText });
    appendOutput('Comparison Matrix', matrix, { exportable: true, exportText });
    latestReadableText = `Research Brief\n${text}`;
    archiveEntry('research', `Research: ${topic}`, text, topic, getActiveVideo());
    await saveResearchArchive({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      topic,
      title: `Research: ${topic}`,
      text,
      matrix,
      videos: results.slice(0, 12).map((video) => ({
        videoId: video.videoId,
        title: video.title,
        channel: video.channel,
        views: video.views,
        published: video.published,
        url: video.url,
        rankingScore: video.rankingScore || 0,
        rankingReason: video.rankingReason || '',
        rankingScores: video.rankingScores || null,
      })),
      reviewed: reviewed.map((video) => ({
        videoId: video.videoId,
        title: video.title,
        channel: video.channel,
        views: video.views,
        published: video.published,
        url: video.url,
        transcriptAvailable: video.transcriptAvailable,
        evidenceRows: video.evidenceRows,
        scores: video.sourceScores,
      })),
      createdAt: Date.now(),
    });
    return text;
  }

  function parseNumberSelection(input, max) {
    const selected = new Set();
    for (const part of String(input || '').split(',')) {
      const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const start = Math.max(1, Number(range[1]) || 0);
        const end = Math.min(max, Number(range[2]) || 0);
        for (let number = Math.min(start, end); number <= Math.max(start, end); number += 1) {
          if (number >= 1 && number <= max) selected.add(number);
        }
        continue;
      }
      const number = Number(part.trim());
      if (Number.isInteger(number) && number >= 1 && number <= max) selected.add(number);
    }
    return [...selected].sort((a, b) => a - b);
  }

  function getCheckedResultNumbers() {
    return Array.from(ensurePanel().querySelectorAll('.yt-va-result-check:checked'))
      .map((input) => Number(input.value))
      .filter((number) => Number.isInteger(number) && number > 0)
      .sort((a, b) => a - b);
  }

  function getBatchSelectionNumbers() {
    const panel = ensurePanel();
    const preset = panel.querySelector('#yt-va-batch-preset')?.value || 'top3';
    const max = lastRenderedResults.length;
    if (preset === 'top3') return [1, 2, 3].filter((number) => number <= max);
    if (preset === 'top5') return [1, 2, 3, 4, 5].filter((number) => number <= max);
    if (preset === 'top10') return Array.from({ length: Math.min(10, max) }, (_item, index) => index + 1);
    if (preset === 'checked') return getCheckedResultNumbers();
    return parseNumberSelection(panel.querySelector('#yt-va-batch-input')?.value || '', max);
  }

  async function summarizeNumberedVideosFromControls() {
    return summarizeNumberedVideos(getBatchSelectionNumbers());
  }

  async function summarizeNumberedVideos(selection) {
    try {
      await requireProAccess();
      if (!lastRenderedResults.length) throw new Error('Search or research videos first, then enter result numbers.');
      const numbers = Array.isArray(selection)
        ? [...new Set(selection)].filter((number) => Number.isInteger(number) && number >= 1 && number <= lastRenderedResults.length).sort((a, b) => a - b)
        : parseNumberSelection(selection, lastRenderedResults.length);
      if (!numbers.length) throw new Error('Choose Top 3, Top 5, Top 10, checked videos, or custom numbers.');
      if (numbers.length > 12) throw new Error('Choose up to 12 videos at once for a clean summary.');

      setBusy(true);
      const videos = numbers.map((number) => ({ number, video: lastRenderedResults[number - 1] })).filter((item) => item.video);
      const reviewed = [];
      for (const item of videos) {
        setStatus(`Reading selected video ${reviewed.length + 1} of ${videos.length} (#${item.number})...`);
        const transcript = await loadTranscriptByVideoId(item.video.videoId).catch(() => '');
        reviewed.push({
          number: item.number,
          ...item.video,
          transcript: sampleTranscriptForResearch(transcript, 6500),
          transcriptAvailable: Boolean(transcript),
        });
      }

      const evidence = reviewed.map((video) => [
        `#${video.number}: ${video.title}`,
        `Channel: ${video.channel || 'Unknown'}`,
        `Views: ${video.views || 'Unknown'}`,
        `Published: ${video.published || 'Unknown'}`,
        `URL: ${video.url}`,
        `Transcript available: ${video.transcriptAvailable ? 'yes' : 'no'}`,
        video.transcript ? `Transcript excerpt: ${video.transcript}` : 'Transcript excerpt: unavailable',
      ].join('\n')).join('\n\n');

      setStatus('Summarizing selected videos, please wait...');
      const text = await callAssistant({
        title: `Selected videos: ${numbers.join(', ')}`,
        transcript: evidence,
        mode: 'research',
        question: [
          'Summarize these selected YouTube videos together.',
          'Use a clean, compact format with these sections:',
          '✦ Best Overall Takeaway',
          '◆ Video-by-Video Notes',
          '◈ Common Advice',
          '✧ Differences or Contradictions',
          '? What To Watch First',
          'Do not invent facts. If a video has no transcript, say it is lower confidence and use only metadata.',
        ].join('\n'),
      });
      const title = `Multi-Video Summary (${numbers.join(', ')})`;
      appendOutput(title, text, { exportable: true, exportText: text });
      latestReadableText = `${title}\n${text}`;
      archiveEntry('batch-summary', title, text, numbers.join(', '), reviewed[0]);
      setStatus(`Summarized ${reviewed.length} selected videos.`);
    } catch (error) {
      setStatus(error.message || 'Multi-video summary failed.');
    } finally {
      setBusy(false);
    }
  }

  function renderSearchResults(resultsBox, results) {
    resultsBox.textContent = '';
    lastRenderedResults = results.slice(0, SEARCH_RESULT_LIMIT);
    if (!lastRenderedResults.length) {
      const empty = document.createElement('div');
      empty.className = 'yt-va-empty-results';
      empty.textContent = 'No videos matched these filters. Try Any date, lower views, or a simpler search.';
      resultsBox.append(empty);
      return;
    }
    results.forEach((video, index) => {
      const row = document.createElement('div');
      row.className = 'yt-va-result';
      const img = document.createElement('img');
      img.src = video.thumbnail;
      img.alt = '';
      const meta = document.createElement('div');
      meta.className = 'yt-va-result-meta';
      const checkLabel = document.createElement('label');
      checkLabel.className = 'yt-va-result-check-label';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'yt-va-result-check';
      check.value = String(index + 1);
      const checkText = document.createElement('span');
      checkText.textContent = 'Include';
      checkLabel.append(check, checkText);
      const rank = document.createElement('span');
      rank.className = 'yt-va-result-rank';
      rank.textContent = `#${index + 1}`;
      const title = document.createElement('span');
      title.className = 'yt-va-result-title';
      title.textContent = video.title;
      const details = document.createElement('small');
      details.textContent = [video.channel, video.views, video.published].filter(Boolean).join(' • ');
      const reason = document.createElement('em');
      reason.textContent = [
        video.rankingScore ? `Quality ${video.rankingScore}/100` : '',
        video.rankingReason || (video.researchQuery ? `Found via: ${video.researchQuery}` : 'Ranked by popularity'),
      ].filter(Boolean).join(' • ');
      meta.append(checkLabel, rank, title, details, reason);
      const actions = document.createElement('div');
      actions.className = 'yt-va-result-actions';
      const use = document.createElement('button');
      use.type = 'button';
      use.textContent = 'Select';
      const open = document.createElement('a');
      open.href = video.url;
      open.target = '_blank';
      open.rel = 'noreferrer';
      open.textContent = 'Open';
      actions.append(use, open);
      row.append(img, meta, actions);
      const selectFromRow = (event) => {
        if (!isTrustedUserEvent(event)) return;
        selectVideo(video);
      };
      use.addEventListener('click', selectFromRow);
      open.addEventListener('click', (event) => event.stopPropagation());
      resultsBox.append(row);
    });
  }

  async function searchVideos(query) {
    const panel = ensurePanel();
    const resultsBox = panel.querySelector('.yt-va-search-results');
    resultsBox.textContent = '';
    if (!query) {
      setStatus('Type what you want to find on YouTube.');
      return;
    }

    const requestToken = activeRequestToken += 1;
    try {
      setBusy(true);
      setStatus('Searching YouTube videos...');
      const filters = getFinderFilters();
      const found = await collectSearchResults(activeDateSearchQuery(query, filters), SEARCH_CANDIDATE_LIMIT);
      if (requestToken !== activeRequestToken) return;
      lastFinderResults = found;
      lastFinderMode = 'search';
      const results = applyVideoFilters(lastFinderResults, query);
      if (requestToken !== activeRequestToken) return;
      renderSearchResults(resultsBox, results);
      toggleResults(false);
      setStatus(results.length
        ? `Showing ${results.length} filtered video${results.length === 1 ? '' : 's'} from ${lastFinderResults.length} candidates.`
        : `No videos matched those filters from ${lastFinderResults.length} candidates. Try Any date, lower views, or Sort: views.`);
    } catch (error) {
      setStatus(error.message || 'YouTube search failed.');
    } finally {
      setBusy(false);
    }
  }

  async function researchVideos(topic) {
    const panel = ensurePanel();
    const resultsBox = panel.querySelector('.yt-va-search-results');
    resultsBox.textContent = '';
    if (!topic) {
      setStatus('Type what you want researched on YouTube.');
      return;
    }

    const requestToken = activeRequestToken += 1;
    try {
      setBusy(true);
      await requireProAccess();
      if (requestToken !== activeRequestToken) return;
      setStatus('Researching YouTube, please wait...');
      const results = await collectResearchResults(topic);
      if (requestToken !== activeRequestToken) return;
      renderSearchResults(resultsBox, results);
      toggleResults(false);
      if (!results.length) {
        setStatus('No research videos matched those filters. Try Any date or lower views.');
        return;
      }
      setStatus('Building research brief...');
      await buildResearchBrief(topic, results);
      if (requestToken !== activeRequestToken) return;
      setStatus(`Research complete: ${results.length} ranked videos plus brief.`);
    } catch (error) {
      setStatus(error.message || 'YouTube research failed.');
    } finally {
      setBusy(false);
    }
  }

  function isAdContainer(element) {
    return Boolean(element.closest(
      'ytd-ad-slot-renderer, ytd-promoted-sparkles-web-renderer, ytd-display-ad-renderer, '
      + 'ytd-search-pyv-renderer, ytd-in-feed-ad-layout-renderer, ytd-player-legacy-desktop-watch-ads-renderer'
    ));
  }

  function findVideoAnchor(container) {
    return container?.matches?.('a[href*="/watch"], a[href^="/shorts/"]')
      ? container
      : container?.querySelector?.('a#thumbnail[href*="/watch"], a.ytd-thumbnail[href*="/watch"], a[href*="/watch?v="], a[href^="/shorts/"]');
  }

  function extractVideoFromThumbnail(container) {
    const anchor = findVideoAnchor(container);
    if (!anchor) return null;
    const videoId = getVideoIdFromUrl(anchor.href);
    if (!videoId) return null;
    const card = anchor.closest(
      'ytd-rich-item-renderer, ytd-rich-grid-media, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-reel-item-renderer'
    ) || anchor.parentElement;
    const titleElement = card?.querySelector('#video-title, a#video-title, h3 a, yt-formatted-string#video-title');
    const image = anchor.querySelector('img') || card?.querySelector('img');
    return normalizeVideoSelection({
      videoId,
      title: titleElement?.textContent?.trim() || anchor.getAttribute('aria-label') || 'YouTube video',
      url: videoUrl(videoId),
      thumbnail: image?.src || image?.getAttribute('src') || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      source: 'thumbnail',
    });
  }

  function mountThumbnailButtons() {
    const cards = Array.from(document.querySelectorAll(
      'ytd-rich-item-renderer, ytd-rich-grid-media, ytd-video-renderer, ytd-compact-video-renderer, '
      + 'ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-reel-item-renderer, a#thumbnail[href*="/watch"], a.ytd-thumbnail[href*="/watch"]'
    ));
    for (const card of cards) {
      if (card.dataset.ytVaMounted === '1' || isAdContainer(card)) continue;
      const anchor = findVideoAnchor(card);
      if (!anchor || isAdContainer(anchor)) continue;
      const video = extractVideoFromThumbnail(card);
      if (!video) continue;
      const mountTarget = card.matches('a#thumbnail, a.ytd-thumbnail')
        ? (anchor.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-rich-grid-media') || anchor)
        : card;
      if (mountTarget.dataset.ytVaMounted === '1') continue;
      card.dataset.ytVaMounted = '1';
      mountTarget.dataset.ytVaMounted = '1';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = THUMB_BUTTON_CLASS;
      button.textContent = 'AI';
      button.setAttribute('aria-label', `Use AI with ${video.title}`);
      if (getComputedStyle(mountTarget).position === 'static') mountTarget.style.position = 'relative';
      const handleThumbSelect = (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (!isTrustedUserEvent(event)) return;
        selectVideo(extractVideoFromThumbnail(card) || video);
      };
      for (const eventName of ['pointerdown', 'mousedown', 'click']) {
        button.addEventListener(eventName, handleThumbSelect, true);
      }
      mountTarget.append(button);
    }
  }

  function openAssistant() {
    if (!selectedVideo && getVideoId()) selectedVideo = getCurrentPageVideo();
    renderSelectedVideo();
    showSettings(false);
    ensurePanel().classList.add('is-open');
    setStatus(selectedVideo ? 'Choose Full or Extreme.' : 'Select a video or search YouTube.');
  }

  function mountButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'AI';
    button.addEventListener('click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      openAssistant();
    });
    document.body.appendChild(button);
  }

  function resetForNavigation() {
    const videoId = getVideoId();
    if (videoId !== currentVideoId) {
      activeRequestToken += 1;
      bridgeNonce = '';
      cachedTranscript = '';
      cachedSummary = '';
      latestReadableText = '';
      latestFullText = '';
      latestExtremeText = '';
      ignoreVisibleTranscriptUntilOpened = true;
      if (currentAudioUrl) {
        URL.revokeObjectURL(currentAudioUrl);
        currentAudioUrl = '';
      }
      currentVideoId = videoId;
      if (videoId) selectedVideo = getCurrentPageVideo();
      const panel = document.getElementById(PANEL_ID);
      if (panel) {
        renderSelectedVideo();
        const output = panel.querySelector('.yt-va-output');
        if (output) output.textContent = '';
        const audio = panel.querySelector('.yt-va-audio');
        if (audio) {
          audio.removeAttribute('src');
          audio.hidden = true;
        }
        panel.querySelector('.yt-va-status').textContent = 'Ready.';
      }
      mountButton();
    }
    mountThumbnailButtons();
  }

  const observer = new MutationObserver(() => {
    mountButton();
    mountThumbnailButtons();
    resetForNavigation();
  });

  globalThis.__ytVideoAssistantDebugLoadTranscript = loadTranscript;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'YT_VIDEO_ASSISTANT_EXTRACT_TRANSCRIPT_FROM_WATCH_TAB') return false;
    loadTranscript()
      .then((transcript) => sendResponse({ ok: Boolean(transcript), transcript }))
      .catch((error) => sendResponse({ ok: false, error: error.message || 'Transcript extraction failed.' }));
    return true;
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('yt-navigate-finish', resetForNavigation);
  mountButton();
  mountThumbnailButtons();
})();


