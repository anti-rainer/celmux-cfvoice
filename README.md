# Celmux OpenAI-compatible Worker

This Worker exposes the two OpenAI-compatible endpoints used by simultaneous
interpretation:

- `POST /v1/audio/transcriptions`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/audio/speech`

It uses Cloudflare Workers AI internally. Celmux configures transcription,
translation, and speech synthesis separately. Translation and speech synthesis
may reuse the transcription provider's Base URL and API key while retaining
their own model IDs, or use independent OpenAI-compatible providers. A
different implementation can be used without changing Celmux when it exposes
the matching endpoint. Ollama can therefore serve translation while a separate
Whisper-compatible service handles transcription.

Deploy with Wrangler and configure the invocation secret separately:

```sh
npx wrangler deploy
npx wrangler secret put CELMUX_API_TOKEN
```

The Cloudflare management token and `CELMUX_API_TOKEN` must never be committed.
