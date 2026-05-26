const DEFAULT_CHAT_API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_ENGLISH_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
const DEFAULT_PORTUGUESE_VOICE_ID = 'ErXwobaYiN019PkySvjV';

const chatApiUrlInput = document.getElementById('chatApiUrl');
const chatProviderSelect = document.getElementById('chatProvider');
const chatApiKeyInput = document.getElementById('chatApiKey');
const chatModelSelect = document.getElementById('chatModel');
const customChatModelInput = document.getElementById('customChatModel');
const elevenInput = document.getElementById('elevenLabsApiKey');
const englishVoiceSelect = document.getElementById('englishVoice');
const customEnglishVoiceInput = document.getElementById('customEnglishVoice');
const portugueseVoiceSelect = document.getElementById('portugueseVoice');
const customPortugueseVoiceInput = document.getElementById('customPortugueseVoice');
const status = document.getElementById('status');

function setSelectOrCustom(select, customInput, value, fallback) {
  const finalValue = value || fallback;
  const option = Array.from(select.options).find((item) => item.value === finalValue);
  if (option) {
    select.value = finalValue;
    customInput.value = '';
  } else {
    select.value = 'custom';
    customInput.value = finalValue;
  }
}

function getSelectOrCustom(select, customInput, fallback) {
  return select.value === 'custom' ? (customInput.value.trim() || fallback) : select.value;
}

chrome.storage.local.get({
  chatApiUrl: DEFAULT_CHAT_API_URL,
  chatApiKey: '',
  deepseekApiKey: '',
  chatProvider: 'openai-compatible',
  chatModel: DEFAULT_MODEL,
  model: DEFAULT_MODEL,
  elevenLabsApiKey: '',
  elevenLabsEnglishVoiceId: DEFAULT_ENGLISH_VOICE_ID,
  elevenLabsPortugueseVoiceId: DEFAULT_PORTUGUESE_VOICE_ID,
}, (items) => {
  chatApiUrlInput.value = items.chatApiUrl || DEFAULT_CHAT_API_URL;
  chatProviderSelect.value = items.chatProvider || ((items.chatApiUrl || '').includes('anthropic.com') ? 'anthropic' : 'openai-compatible');
  chatApiKeyInput.value = '';
  elevenInput.value = '';
  chatApiKeyInput.placeholder = (items.chatApiKey || items.deepseekApiKey) ? 'Saved. Leave blank to keep.' : 'Paste API key';
  elevenInput.placeholder = items.elevenLabsApiKey ? 'Saved. Leave blank to keep.' : 'Paste ElevenLabs key';
  setSelectOrCustom(chatModelSelect, customChatModelInput, items.chatModel || items.model, DEFAULT_MODEL);
  setSelectOrCustom(englishVoiceSelect, customEnglishVoiceInput, items.elevenLabsEnglishVoiceId, DEFAULT_ENGLISH_VOICE_ID);
  setSelectOrCustom(portugueseVoiceSelect, customPortugueseVoiceInput, items.elevenLabsPortugueseVoiceId, DEFAULT_PORTUGUESE_VOICE_ID);
});

document.getElementById('save').addEventListener('click', () => {
  const chatApiUrl = chatApiUrlInput.value.trim() || DEFAULT_CHAT_API_URL;
  const next = {
    chatApiUrl,
    chatProvider: chatProviderSelect.value || 'openai-compatible',
    chatModel: getSelectOrCustom(chatModelSelect, customChatModelInput, DEFAULT_MODEL),
    elevenLabsEnglishVoiceId: getSelectOrCustom(englishVoiceSelect, customEnglishVoiceInput, DEFAULT_ENGLISH_VOICE_ID),
    elevenLabsPortugueseVoiceId: getSelectOrCustom(portugueseVoiceSelect, customPortugueseVoiceInput, DEFAULT_PORTUGUESE_VOICE_ID),
  };
  if (chatApiKeyInput.value.trim()) next.chatApiKey = chatApiKeyInput.value.trim();
  if (elevenInput.value.trim()) next.elevenLabsApiKey = elevenInput.value.trim();

  chrome.storage.local.set(next, async () => {
    const permission = await chrome.runtime.sendMessage({
      type: 'YT_VIDEO_ASSISTANT_REQUEST_HOST_PERMISSION',
      url: chatApiUrl,
    });
    chatApiKeyInput.value = '';
    elevenInput.value = '';
    status.textContent = permission?.ok ? 'Saved. Keys are hidden.' : (permission?.error || 'Saved. API permission still needs approval.');
    setTimeout(() => {
      status.textContent = '';
    }, 1600);
  });
});

document.getElementById('clear').addEventListener('click', () => {
  chrome.storage.local.remove(['chatApiKey', 'deepseekApiKey', 'elevenLabsApiKey'], () => {
    chatApiKeyInput.value = '';
    elevenInput.value = '';
    status.textContent = 'Keys cleared.';
  });
});
