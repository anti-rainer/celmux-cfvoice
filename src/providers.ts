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

export async function translate(ai: Ai, text: string, target: string): Promise<string> {
  if (!target || target.toLowerCase() === "auto") return "";
  const result = await ai.run("@cf/meta/llama-3.2-3b-instruct", {
    messages: [
      { role: "system", content: `Translate telephone speech to ${target}. Return only the translation.` },
      { role: "user", content: text },
    ],
    max_tokens: 256,
    temperature: 0,
  });
  if (!result || typeof result !== "object" || !("response" in result)) return "";
  return String((result as { response?: unknown }).response || "").trim();
}

export function normalizeSpeechVoice(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "asteria";
  const voice = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{1,31}$/.test(voice) ? voice : "asteria";
}
