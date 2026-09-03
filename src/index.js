const DEFAULT_ASR_MODEL = '@cf/openai/whisper-large-v3-turbo';
const DEFAULT_TRANSLATION_MODEL = '@cf/meta/llama-3.2-3b-instruct';
const MULTILINGUAL_SPEECH_MODEL = '@cf/myshell-ai/melotts';
const ENGLISH_SPEECH_MODEL = '@cf/deepgram/aura-2-en';
const SPANISH_SPEECH_MODEL = '@cf/deepgram/aura-2-es';
const MAX_AUDIO_BYTES = 1024 * 1024;
const AUDIO_TYPES = new Set([
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/x-wav',
  'application/octet-stream',
]);

const corsHeaders = {
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Max-Age': '86400',
};

function json(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: { ...corsHeaders, 'Cache-Control': 'no-store' },
  });
}

function error(status, code, message) {
  return json({
    error: {
      message,
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      param: null,
      code,
    },
  }, status);
}

function bearerToken(request) {
  const authorization = request.headers.get('Authorization') || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

function isAuthorized(request, expectedToken) {
  const supplied = new TextEncoder().encode(bearerToken(request));
  const expected = new TextEncoder().encode(expectedToken || '');
  if (supplied.length === 0 || supplied.length !== expected.length) return false;

  let difference = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    difference |= supplied[index] ^ expected[index];
  }
  return difference === 0;
}

function encodeBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function normalizeLanguage(value) {
  const language = String(value || '').trim();
  return language && language.toLowerCase() !== 'auto' ? language : undefined;
}

function asrModel(value) {
  const model = String(value || '').trim();
  // Celmux exposes one logical recognition/translation model setting. Only
  // pass through an explicit Workers AI ASR model on the transcription
  // endpoint; text or logical multimodal names are routed to our ASR model.
  if (model.startsWith('@cf/') && /\/whisper(?:-|$)/i.test(model)) return model;
  return DEFAULT_ASR_MODEL;
}

function translationModel(value) {
  const model = String(value || '').trim();
  // Never send chat payloads to Whisper/TTS models merely because the same
  // logical model name was used for transcription.
  if (model.startsWith('@cf/') && !/(?:\/whisper(?:-|$)|\/aura-|\/melotts(?:-|$))/i.test(model)) {
    return model;
  }
  return DEFAULT_TRANSLATION_MODEL;
}

function speechModel(value, language) {
  const model = String(value || '').trim();
  if (model.startsWith('@cf/')) return model;
  if (language === 'en') return ENGLISH_SPEECH_MODEL;
  if (language === 'es') return SPANISH_SPEECH_MODEL;
  return MULTILINGUAL_SPEECH_MODEL;
}

function speechLanguage(instructions, input) {
  const requested = String(instructions || '').match(/\bin\s+([a-z]{2,3}(?:-[A-Z]{2})?)\b/);
  if (requested) return requested[1].split('-', 1)[0].toLowerCase();
  if (/[\u3040-\u30ff]/u.test(input)) return 'ja';
  if (/[\uac00-\ud7af]/u.test(input)) return 'ko';
  if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(input)) return 'zh';
  return 'en';
}

async function transcribe(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return error(400, 'invalid_multipart_form', 'Expected multipart/form-data.');
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return error(400, 'file_required', 'The file field is required.');
  }
  const contentType = (file.type || 'application/octet-stream')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (!AUDIO_TYPES.has(contentType)) {
    return error(415, 'unsupported_media_type', 'The file must contain supported audio.');
  }
  if (file.size === 0) return error(400, 'empty_audio', 'The audio file is empty.');
  if (file.size > MAX_AUDIO_BYTES) {
    return error(413, 'audio_too_large', 'The audio file exceeds the 1 MiB limit.');
  }

  const inputs = {
    audio: encodeBase64(await file.arrayBuffer()),
    task: 'transcribe',
    beam_size: 1,
    condition_on_previous_text: false,
  };
  const language = normalizeLanguage(form.get('language'));
  if (language) inputs.language = language;

  const result = await env.AI.run(asrModel(form.get('model')), inputs);
  const text = typeof result?.text === 'string' ? result.text.trim() : '';
  if (!text) return error(502, 'empty_transcription', 'Speech recognition returned no text.');
  return json({
    text,
    language: result?.transcription_info?.language || result?.language || language || null,
  });
}

async function chatCompletion(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return error(400, 'invalid_json', 'Expected a JSON request body.');
  }
  if (!Array.isArray(payload?.messages) || payload.messages.length === 0) {
    return error(400, 'messages_required', 'The messages field is required.');
  }
  const messages = payload.messages
    .filter((message) => message && ['system', 'user', 'assistant'].includes(message.role))
    .map((message) => ({ role: message.role, content: String(message.content || '') }))
    .filter((message) => message.content);
  if (messages.length === 0) {
    return error(400, 'messages_required', 'No supported messages were provided.');
  }

  const result = await env.AI.run(translationModel(payload.model), {
    messages,
    max_tokens: Math.min(512, Math.max(32, Number(payload.max_tokens) || 192)),
    temperature: Number.isFinite(Number(payload.temperature)) ? Number(payload.temperature) : 0,
  });
  const content = typeof result?.response === 'string' ? result.response.trim() : '';
  if (!content) return error(502, 'empty_completion', 'The chat model returned no text.');

  return json({
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: String(payload.model || 'llama-3.2-3b-instruct'),
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
  });
}

async function responses(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return error(400, 'invalid_json', 'Expected a JSON request body.');
  }
  const input = typeof payload?.input === 'string' ? payload.input.trim() : '';
  if (!input) return error(400, 'input_required', 'The input field must be a non-empty string.');
  const messages = [];
  if (payload.instructions) messages.push({ role: 'system', content: String(payload.instructions) });
  messages.push({ role: 'user', content: input });
  const result = await env.AI.run(translationModel(payload.model), {
    messages,
    max_tokens: Math.min(512, Math.max(32, Number(payload.max_output_tokens) || 192)),
    temperature: Number.isFinite(Number(payload.temperature)) ? Number(payload.temperature) : 0,
  });
  const text = typeof result?.response === 'string' ? result.response.trim() : '';
  if (!text) return error(502, 'empty_response', 'The response model returned no text.');
  const id = `resp_${crypto.randomUUID()}`;
  return json({
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: payload.instructions || null,
    model: String(payload.model || 'llama-3.2-3b-instruct'),
    output: [{
      type: 'message',
      id: `msg_${crypto.randomUUID()}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
  });
}

async function speech(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return error(400, 'invalid_json', 'Expected a JSON request body.');
  }
  const input = String(payload?.input || '').trim();
  if (!input) return error(400, 'input_required', 'The input field is required.');
  if (new TextEncoder().encode(input).length > 4096) {
    return error(413, 'input_too_large', 'The speech input exceeds 4 KiB.');
  }
  const language = speechLanguage(payload.instructions, input);
  const model = speechModel(payload.model, language);
  const aura = model.includes('/aura-');
  const explicitCloudflareModel = String(payload.model || '').trim().startsWith('@cf/');
  const inputs = aura
    ? { text: input, encoding: 'mp3', ...(explicitCloudflareModel && payload.voice ? { speaker: payload.voice } : {}) }
    : { prompt: input, lang: language };
  const result = await env.AI.run(model, inputs, { returnRawResponse: true });
  if (!(result instanceof Response) || !result.ok || !result.body
    || !result.headers.get('Content-Type')?.startsWith('audio/')) {
    return error(502, 'empty_speech', 'Speech synthesis returned no audio.');
  }
  return new Response(result.body, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Cache-Control': 'no-store',
      'Content-Type': result.headers.get('Content-Type') || 'audio/mpeg',
    },
  });
}

function models() {
  return json({
    object: 'list',
    data: [
      { id: 'whisper-large-v3-turbo', object: 'model', owned_by: 'cloudflare' },
      { id: 'llama-3.2-3b-instruct', object: 'model', owned_by: 'cloudflare' },
      { id: 'gpt-4o-mini-tts', object: 'model', owned_by: 'cloudflare' },
    ],
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (!env.CELMUX_API_TOKEN || !isAuthorized(request, env.CELMUX_API_TOKEN)) {
      return error(401, 'invalid_api_key', 'A valid bearer token is required.');
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    try {
      if (request.method === 'GET' && path === '/v1/models') return models();
      if (request.method === 'POST' && path === '/v1/audio/transcriptions') {
        return await transcribe(request, env);
      }
      if (request.method === 'POST' && path === '/v1/chat/completions') {
        return await chatCompletion(request, env);
      }
      if (request.method === 'POST' && path === '/v1/responses') {
        return await responses(request, env);
      }
      if (request.method === 'POST' && path === '/v1/audio/speech') {
        return await speech(request, env);
      }
      return error(404, 'not_found', 'The requested OpenAI-compatible endpoint does not exist.');
    } catch (cause) {
      console.error('OpenAI-compatible request failed', cause);
      return error(502, 'provider_failed', 'The AI service could not process this request.');
    }
  },
};
