try {
  if (chrome.runtime.getManifest().version_name === 'local-dev') {
    importScripts('config.local.js');
  }
} catch (_error) {
  self.YT_VIDEO_ASSISTANT_CONFIG = self.YT_VIDEO_ASSISTANT_CONFIG || {};
}

const DEFAULT_CHAT_API_URL = 'https://api.deepseek.com/chat/completions';
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const LICENSE_VALIDATE_URL = '';
const LICENSE_RESTORE_URL = '';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_CHAT_PROVIDER = 'openai-compatible';
const DEFAULT_ENGLISH_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
const DEFAULT_PORTUGUESE_VOICE_ID = 'ErXwobaYiN019PkySvjV';
const CHAT_TIMEOUT_MS = 45_000;
const TTS_TIMEOUT_MS = 60_000;
const MAX_CHAT_RESPONSE_CHARS = 1_000_000;
const MAX_AUDIO_BYTES = 12_000_000;
const TEMP_TAB_TIMEOUT_MS = 45_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getConfig() {
  const config = self.YT_VIDEO_ASSISTANT_CONFIG || {};
  const stored = await chrome.storage.local.get({
    chatApiUrl: '',
    chatApiKey: '',
    chatModel: '',
    chatProvider: '',
    deepseekApiKey: '',
    model: '',
    elevenLabsApiKey: '',
    elevenLabsEnglishVoiceId: '',
    elevenLabsPortugueseVoiceId: '',
  });

  return {
    chatApiUrl: String(stored.chatApiUrl || config.chatApiUrl || DEFAULT_CHAT_API_URL).trim(),
    chatProvider: String(stored.chatProvider || config.chatProvider || inferProvider(stored.chatApiUrl || config.chatApiUrl || DEFAULT_CHAT_API_URL)).trim(),
    chatApiKey: String(stored.chatApiKey || stored.deepseekApiKey || config.chatApiKey || config.deepseekApiKey || '').trim(),
    chatModel: String(stored.chatModel || stored.model || config.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    elevenLabsApiKey: String(stored.elevenLabsApiKey || config.elevenLabsApiKey || '').trim(),
    englishVoiceId: String(
      stored.elevenLabsEnglishVoiceId || config.elevenLabsEnglishVoiceId || DEFAULT_ENGLISH_VOICE_ID
    ).trim(),
    portugueseVoiceId: String(
      stored.elevenLabsPortugueseVoiceId || config.elevenLabsPortugueseVoiceId || DEFAULT_PORTUGUESE_VOICE_ID
    ).trim(),
  };
}

async function getPublicSettings() {
  const config = await getConfig();
  return {
    chatApiUrl: config.chatApiUrl,
    chatProvider: config.chatProvider,
    chatModel: config.chatModel,
    hasChatApiKey: Boolean(config.chatApiKey),
    hasElevenLabsApiKey: Boolean(config.elevenLabsApiKey),
    elevenLabsEnglishVoiceId: config.englishVoiceId,
    elevenLabsPortugueseVoiceId: config.portugueseVoiceId,
  };
}

async function getInstallId(providedInstallId = '') {
  const existing = String(providedInstallId || '').trim();
  if (existing) return existing.slice(0, 120);
  const stored = await chrome.storage.local.get({ ytVaInstallId: '' });
  if (stored.ytVaInstallId) return stored.ytVaInstallId;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const installId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  await chrome.storage.local.set({ ytVaInstallId: installId });
  return installId;
}

async function validateLicenseWithServer(licenseKey, providedInstallId = '') {
  const finalKey = String(licenseKey || '').trim().toUpperCase();
  if (!finalKey) throw new Error('Paste a license key first.');
  const installId = await getInstallId(providedInstallId);
  const response = await fetchWithTimeout(LICENSE_VALIDATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ licenseKey: finalKey, installId }),
  }, CHAT_TIMEOUT_MS);
  const responseText = await response.text();
  let data = {};
  if (responseText.trim()) {
    try {
      data = JSON.parse(responseText);
    } catch (_error) {
      throw new Error('License server returned an unreadable response.');
    }
  }
  if (!response.ok || !data.valid) {
    await chrome.storage.local.set({
      ytVaLicenseKey: finalKey,
      ytVaLicenseStatus: data.status || '',
      ytVaProValidatedAt: Date.now(),
    });
    throw new Error(data.error || `License validation failed: ${response.status}`);
  }
  await chrome.storage.local.set({
    ytVaLicenseKey: finalKey,
    ytVaLicenseStatus: data.status || 'active',
    ytVaLicenseEmail: data.email || '',
    ytVaLicenseTrialEndsAt: data.trialEndsAt || '',
    ytVaLicenseCurrentPeriodEnd: data.currentPeriodEnd || '',
    ytVaProValidatedAt: Date.now(),
  });
  return data;
}

async function saveLicenseFromCheckout(license) {
  const finalKey = String(license?.licenseKey || '').trim().toUpperCase();
  if (!finalKey) throw new Error('Checkout did not return a license key.');
  await chrome.storage.local.set({
    ytVaLicenseKey: finalKey,
    ytVaLicenseStatus: license.status || 'active',
    ytVaLicenseEmail: license.email || '',
    ytVaLicenseTrialEndsAt: license.trialEndsAt || '',
    ytVaLicenseCurrentPeriodEnd: license.currentPeriodEnd || '',
    ytVaProValidatedAt: Date.now(),
    ytVaFreeActionsUsed: 0,
  });
  return {
    licenseKey: finalKey,
    status: license.status || 'active',
    email: license.email || '',
    trialEndsAt: license.trialEndsAt || '',
    currentPeriodEnd: license.currentPeriodEnd || '',
  };
}

async function restorePurchaseWithServer(email) {
  const finalEmail = String(email || '').trim().toLowerCase();
  if (!finalEmail || !finalEmail.includes('@')) throw new Error('Enter an email address.');
  const installId = await getInstallId();
  const response = await fetchWithTimeout(LICENSE_RESTORE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: finalEmail, installId }),
  }, CHAT_TIMEOUT_MS);
  const responseText = await response.text();
  let data = {};
  if (responseText.trim()) {
    try {
      data = JSON.parse(responseText);
    } catch (_error) {
      throw new Error('License server returned an unreadable restore response.');
    }
  }
  if (!response.ok || !data.valid || !data.license) {
    throw new Error(data.error || `Purchase restore failed: ${response.status}`);
  }
  return saveLicenseFromCheckout(data.license);
}

async function saveSettingsFromPage(settings) {
  const current = await getConfig();
  const next = {
    chatApiUrl: String(settings.chatApiUrl || current.chatApiUrl || DEFAULT_CHAT_API_URL).trim(),
    chatProvider: String(settings.chatProvider || inferProvider(settings.chatApiUrl || current.chatApiUrl || DEFAULT_CHAT_API_URL)).trim(),
    chatModel: String(settings.chatModel || current.chatModel || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    elevenLabsEnglishVoiceId: String(
      settings.elevenLabsEnglishVoiceId || current.englishVoiceId || DEFAULT_ENGLISH_VOICE_ID
    ).trim(),
    elevenLabsPortugueseVoiceId: String(
      settings.elevenLabsPortugueseVoiceId || current.portugueseVoiceId || DEFAULT_PORTUGUESE_VOICE_ID
    ).trim(),
  };

  await chrome.storage.local.set(next);
  const chatPermission = await requestEndpointPermission(next.chatApiUrl);
  const voicePermission = await requestEndpointPermission(`${ELEVENLABS_API_URL}/${next.elevenLabsEnglishVoiceId}`);
  return {
    ok: Boolean(chatPermission.ok && voicePermission.ok),
    chatPermission,
    voicePermission,
    error: chatPermission.error || voicePermission.error || '',
  };
}

function endpointOriginPattern(urlText) {
  try {
    const url = new URL(urlText);
    const isLoopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) return '';
    return `${url.origin}/*`;
  } catch (_error) {
    return '';
  }
}

function inferProvider(urlText) {
  try {
    const host = new URL(urlText).hostname;
    if (host.includes('anthropic.com')) return 'anthropic';
    return DEFAULT_CHAT_PROVIDER;
  } catch (_error) {
    return DEFAULT_CHAT_PROVIDER;
  }
}

async function hasEndpointPermission(urlText) {
  const origin = endpointOriginPattern(urlText);
  if (!origin) return false;
  return chrome.permissions.contains({ origins: [origin] });
}

async function requestEndpointPermission(urlText) {
  const origin = endpointOriginPattern(urlText);
  if (!origin) return { ok: false, error: 'Use an https API endpoint.' };
  const alreadyGranted = await chrome.permissions.contains({ origins: [origin] });
  if (alreadyGranted) return { ok: true };
  const granted = await chrome.permissions.request({ origins: [origin] });
  return granted ? { ok: true } : { ok: false, error: `Chrome permission was not granted for ${origin}` };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('The API request timed out.');
    throw new Error('The API request failed. Check the endpoint and network.');
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextWithRetry(url, options, timeoutMs) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchWithTimeout(url, options, timeoutMs);
    const responseText = await response.text();
    if (responseText.length > MAX_CHAT_RESPONSE_CHARS) {
      throw new Error('The chat model response was too large.');
    }
    if (response.ok || response.status < 500 || attempt === 1) {
      return { response, responseText };
    }
    lastError = new Error(`Temporary API error: ${response.status}`);
  }
  throw lastError || new Error('The API request failed.');
}

function statusError(status, fallback) {
  if (status === 401 || status === 403) return 'API key or endpoint permission was rejected.';
  if (status === 429) return 'API quota or rate limit was reached.';
  return fallback;
}

async function askChatModel(payload) {
  const config = await getConfig();
  if (!config.chatApiKey) {
    throw new Error('Add a chat model API key in settings.');
  }
  if (!await hasEndpointPermission(config.chatApiUrl)) {
    throw new Error('Open settings, save the API endpoint, and approve Chrome access for it.');
  }

  if (config.chatProvider === 'anthropic' || config.chatApiUrl.includes('api.anthropic.com')) {
    return askAnthropicModel(payload, config);
  }

  return askOpenAiCompatibleModel(payload, config);
}

function maxTokensForMode(mode) {
  return mode === 'question' ? 900 : mode === 'extreme' ? 450 : 1400;
}

async function askOpenAiCompatibleModel(payload, config) {
  const { response, responseText } = await fetchTextWithRetry(config.chatApiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.chatApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.chatModel,
      messages: [
        {
          role: 'system',
          content: 'You are a precise video assistant. Use only the supplied transcript. Do not invent facts.',
        },
        { role: 'user', content: payload.prompt },
      ],
      temperature: 0.2,
      max_tokens: maxTokensForMode(payload.mode),
    }),
  }, CHAT_TIMEOUT_MS);

  let data = {};
  if (responseText.trim()) {
    try {
      data = JSON.parse(responseText);
    } catch (_error) {
      throw new Error('The chat model returned an unreadable response.');
    }
  }

  if (!response.ok) {
    throw new Error(statusError(response.status, data.error?.message || `Chat model request failed: ${response.status}`));
  }

  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('The chat model returned an empty response.');
  return text.trim();
}

async function askAnthropicModel(payload, config) {
  const { response, responseText } = await fetchTextWithRetry(config.chatApiUrl, {
    method: 'POST',
    headers: {
      'x-api-key': config.chatApiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.chatModel || 'claude-3-5-haiku-latest',
      system: 'You are a precise video assistant. Use only the supplied transcript. Do not invent facts.',
      messages: [{ role: 'user', content: payload.prompt }],
      temperature: 0.2,
      max_tokens: maxTokensForMode(payload.mode),
    }),
  }, CHAT_TIMEOUT_MS);

  let data = {};
  if (responseText.trim()) {
    try {
      data = JSON.parse(responseText);
    } catch (_error) {
      throw new Error('Anthropic returned an unreadable response.');
    }
  }

  if (!response.ok) {
    throw new Error(statusError(response.status, data.error?.message || `Anthropic request failed: ${response.status}`));
  }

  const text = (data.content || [])
    .map((part) => part?.type === 'text' ? part.text : '')
    .join('')
    .trim();
  if (!text) throw new Error('Anthropic returned an empty response.');
  return text;
}

function detectLanguage(text) {
  const normalized = text.toLowerCase();
  const portugueseSignals = [
    'ção', 'ções', 'não', 'você', 'vocês', 'para', 'com ', 'uma ', 'que ', 'por ',
    'mais', 'também', 'resumo', 'pontos', 'perguntas', 'vídeo', 'história',
  ];
  const score = portugueseSignals.reduce((total, token) => total + (normalized.includes(token) ? 1 : 0), 0);
  return score >= 2 ? 'pt' : 'en';
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

async function readWithElevenLabs(text) {
  const config = await getConfig();
  if (!config.elevenLabsApiKey) {
    throw new Error('Add an ElevenLabs API key in settings.');
  }

  const language = detectLanguage(text);
  const voiceId = language === 'pt' ? config.portugueseVoiceId : config.englishVoiceId;
  if (!await hasEndpointPermission(`${ELEVENLABS_API_URL}/${voiceId}`)) {
    const permission = await requestEndpointPermission(`${ELEVENLABS_API_URL}/${voiceId}`);
    if (!permission.ok) throw new Error(permission.error || 'Chrome permission was not granted for ElevenLabs.');
  }
  const response = await fetchWithTimeout(`${ELEVENLABS_API_URL}/${encodeURIComponent(voiceId)}`, {
    method: 'POST',
    headers: {
      'xi-api-key': config.elevenLabsApiKey,
      Accept: 'audio/mpeg',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: text.slice(0, 4500),
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: true,
      },
    }),
  }, TTS_TIMEOUT_MS);

  if (!response.ok) {
    let message = statusError(response.status, `ElevenLabs request failed: ${response.status}`);
    try {
      const data = await response.json();
      message = statusError(response.status, data?.detail?.message || data?.message || message);
    } catch (_error) {}
    throw new Error(message);
  }

  const audio = await response.arrayBuffer();
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    throw new Error('The generated audio was too large.');
  }
  return arrayBufferToBase64(audio);
}

function createTab(createProperties) {
  return chrome.tabs.create(createProperties);
}

function removeTab(tabId) {
  return chrome.tabs.remove(tabId).catch(() => {});
}

async function askTabForTranscript(tabId) {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < TEMP_TAB_TIMEOUT_MS) {
    try {
      const response = await Promise.race([
        chrome.tabs.sendMessage(tabId, {
          type: 'YT_VIDEO_ASSISTANT_EXTRACT_TRANSCRIPT_FROM_WATCH_TAB',
        }),
        sleep(18000).then(() => ({ ok: false, error: 'Transcript attempt timed out.' })),
      ]);
      if (response?.ok && response.transcript) return response.transcript;
      lastError = response?.error || '';
    } catch (error) {
      lastError = error?.message || '';
    }
    await sleep(1000);
  }
  throw new Error(lastError || 'The temporary video tab did not expose a transcript.');
}

async function extractTranscriptInTempTab(videoId) {
  if (!/^[\w-]{6,20}$/.test(String(videoId || ''))) {
    throw new Error('Invalid YouTube video ID.');
  }
  const tab = await createTab({
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`,
    active: false,
  });
  try {
    await sleep(3500);
    return await askTabForTranscript(tab.id);
  } finally {
    if (tab?.id) await removeTab(tab.id);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'YT_VIDEO_ASSISTANT_DEEPSEEK') return false;

  askChatModel(message.payload)
    .then((text) => sendResponse({ ok: true, text }))
    .catch((error) => sendResponse({ ok: false, error: error.message || 'Chat model request failed.' }));

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'YT_VIDEO_ASSISTANT_ELEVENLABS') return false;

  readWithElevenLabs(String(message.text || ''))
    .then((audioBase64) => sendResponse({ ok: true, audioBase64, mimeType: 'audio/mpeg' }))
    .catch((error) => sendResponse({ ok: false, error: error.message || 'ElevenLabs request failed.' }));

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'YT_VIDEO_ASSISTANT_REQUEST_HOST_PERMISSION') return false;

  requestEndpointPermission(String(message.url || ''))
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error.message || 'Chrome permission request failed.' }));

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'YT_VIDEO_ASSISTANT_GET_PUBLIC_SETTINGS') return false;

  getPublicSettings()
    .then((settings) => sendResponse({ ok: true, settings }))
    .catch((error) => sendResponse({ ok: false, error: error.message || 'Settings could not be loaded.' }));

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'YT_VIDEO_ASSISTANT_SAVE_SETTINGS') return false;

  saveSettingsFromPage(message.settings || {})
    .then((permission) => sendResponse({ ok: true, permission }))
    .catch((error) => sendResponse({ ok: false, error: error.message || 'Settings could not be saved.' }));

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'YT_VIDEO_ASSISTANT_VALIDATE_LICENSE') return false;

  validateLicenseWithServer(message.licenseKey || '', message.installId || '')
    .then((license) => sendResponse({ ok: true, license }))
    .catch((error) => sendResponse({ ok: false, error: error.message || 'License validation failed.' }));

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'YT_VIDEO_ASSISTANT_SAVE_LICENSE_FROM_CHECKOUT') return false;

  saveLicenseFromCheckout(message.license || {})
    .then((license) => sendResponse({ ok: true, license }))
    .catch((error) => sendResponse({ ok: false, error: error.message || 'Checkout license could not be saved.' }));

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'YT_VIDEO_ASSISTANT_RESTORE_PURCHASE') return false;

  restorePurchaseWithServer(message.email || '')
    .then((license) => sendResponse({ ok: true, license }))
    .catch((error) => sendResponse({ ok: false, error: error.message || 'Purchase could not be restored.' }));

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'YT_VIDEO_ASSISTANT_OPEN_OPTIONS') return false;

  chrome.runtime.openOptionsPage()
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message || 'Options could not be opened.' }));

  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'YT_VIDEO_ASSISTANT_EXTRACT_TRANSCRIPT_IN_TEMP_TAB') return false;

  extractTranscriptInTempTab(String(message.videoId || ''))
    .then((transcript) => sendResponse({ ok: Boolean(transcript), transcript }))
    .catch((error) => sendResponse({ ok: false, error: error.message || 'Temporary transcript extraction failed.' }));

  return true;
});

