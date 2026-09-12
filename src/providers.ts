/** Canonical ISO-639-1 language code for both Flux and Whisper.
 *
 * Whisper accepts ISO-639-1 language codes (zh, en, ...), not regional
 * BCP-47 tags such as zh-CN. Keep the Agent state in this canonical form so
 * both realtime Flux and chunked Whisper receive the same value.
 */
export function normalizeLanguage(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const normalized = value.trim().replaceAll("_", "-").toLowerCase();
  if (normalized === "auto") return "auto";
  if (normalized.startsWith("zh")) return "zh";
  return normalized.split("-", 1)[0] || fallback;
}

export function explicitLanguage(value: string): boolean {
  return Boolean(value.trim()) && value.trim().toLowerCase() !== "auto";
}

/**
 * `sourceLanguage` describes the remote party. Automatic detection remains
 * valid for incoming transcription, but synthesized uplink speech needs a
 * concrete target immediately. English is the deterministic default until a
 * remote language is selected explicitly.
 */
export function outgoingTranslationLanguage(sourceLanguage: string): string {
  return explicitLanguage(sourceLanguage) ? sourceLanguage.trim() : "en";
}

/**
 * glm-4.7-flash is the current fast multilingual default (the official
 * voice-agent example uses it too). It costs $0.06/M input + $0.40/M output
 * versus $0.051/$0.34 for llama-3.2-3b: a typical sentence of 20 input and 30
 * output tokens costs about $0.000013, which is negligible next to streaming
 * STT ($0.0077 per audio minute) and Aura TTS. The older model stays as a
 * fallback so one model's outage does not drop translations.
 */
const TRANSLATION_MODELS = [
  "@cf/zai-org/glm-4.7-flash",
  "@cf/meta/llama-3.2-3b-instruct",
] as const;

/** Read a translation from either the legacy `{response}` or OpenAI-style
 * `{choices:[{message:{content}}]}` Workers AI output shape. */
export function translationText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  if (typeof record.response === "string") return record.response.trim();
  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (first && typeof first === "object") {
      const message = (first as Record<string, unknown>).message;
      if (message && typeof message === "object") {
        const content = (message as Record<string, unknown>).content;
        if (typeof content === "string") return content.trim();
      }
    }
  }
  return "";
}

export async function translate(ai: Ai, text: string, target: string): Promise<string> {
  if (!target || target.toLowerCase() === "auto") return "";
  for (const model of TRANSLATION_MODELS) {
    try {
      const result = await ai.run(model, {
        messages: [
          { role: "system", content: `Translate telephone speech to ${target}. Return only the translation.` },
          { role: "user", content: text },
        ],
        max_tokens: 256,
        temperature: 0,
      });
      const translated = translationText(result);
      if (translated) return translated;
    } catch (error) {
      console.warn("Cloudflare translation model failed", {
        model,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return "";
}
