# YouTube Researcher AI

Free open-source Chrome extension by **D04 Products** for finding, ranking, comparing, summarizing, asking questions about, and listening to YouTube research videos.

## Why This Exists

Most YouTube summarizers help only after you already chose a video. YouTube Researcher AI is built for the full research workflow:

- Find relevant YouTube videos on a topic.
- Rank and filter results by views, date, and practical quality signals.
- Select videos from search results without opening each one first.
- Summarize one video in Full or Extreme mode.
- Ask follow-up questions about the selected video.
- Research multiple videos and compare advice, contradictions, red flags, and action steps.
- Read summaries aloud with ElevenLabs.
- Save summaries, answers, audio, and research briefs locally in the browser.

## Best Use Cases

- Fitness and health research
- AI tools and software tutorials
- Product reviews
- Business and marketing ideas
- Study and learning workflows
- Coding tutorials
- Investing and market research
- Any topic where YouTube has too many videos and you need the best answer fast

## Features

- YouTube search from the extension panel
- Up to 50 video results per search
- Filters for publish date and minimum views
- Sort by views, newest, or research quality
- AI button on YouTube video pages and video cards
- Full summary
- Extreme one-paragraph summary
- Follow-up Q&A
- Multi-video research comparison
- Local history/archive
- Markdown-style readable output
- ElevenLabs text-to-speech
- Provider settings for DeepSeek, OpenAI-compatible APIs, OpenRouter, xAI/Grok, Anthropic Claude, Ollama, LM Studio, and custom endpoints

## Install From Source

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select this project folder.
6. Open YouTube and click the YouTube Researcher AI button.

## API Keys

This extension does not include API keys. Add your own keys in extension settings.

Recommended setup:

- Chat model: DeepSeek, OpenAI, OpenRouter, xAI/Grok, Anthropic Claude, Ollama, LM Studio, or your own OpenAI-compatible server.
- Voice: ElevenLabs API key if you want summaries read aloud.

Keys are stored in Chrome extension storage on your own browser profile.

## Privacy

The extension reads YouTube page data only for features you use. It sends transcript/search/question text only to the AI or voice provider you configure. History is stored locally in your browser.

See [PRIVACY.md](PRIVACY.md).

## Project Status

This is an early open-source release. It works as a browser extension loaded manually through Chrome Developer Mode. Contributions, bug reports, and UI improvements are welcome.

## Brand

Built by **D04 Products**, the digital software side of Dental04.

## License

MIT License. See [LICENSE](LICENSE).
