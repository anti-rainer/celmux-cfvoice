/**
 * Workers AI speech models used by the Cloudflare voice stack.
 *
 * Prices are the Workers AI list prices from the model pages and are kept
 * here only to document the free-tier trade-off: Aura-2 costs twice as much
 * per character as Aura-1, while translation tokens are negligible compared
 * with streaming STT. The Celmux settings UI mirrors the voice IDs below.
 */
export type SpeechVoice = {
  id: string;
  label: string;
  gender: "female" | "male";
};

export type SpeechModel = {
  id: string;
  label: string;
  defaultVoice: string;
  /** USD per 1k characters (Workers AI list price). */
  pricePer1kChars: number;
  voices: SpeechVoice[];
};

function voice(id: string, gender: "female" | "male", accent = ""): SpeechVoice {
  const name = id.charAt(0).toUpperCase() + id.slice(1);
  const kind = gender === "female" ? "女声" : "男声";
  return { id, label: `${name}（${kind}${accent ? `·${accent}` : ""}）`, gender };
}

const aura1: SpeechVoice[] = [
  voice("asteria", "female"),
  voice("luna", "female"),
  voice("stella", "female"),
  voice("athena", "female"),
  voice("hera", "female"),
  voice("angus", "male"),
  voice("arcas", "male"),
  voice("orion", "male"),
  voice("orpheus", "male"),
  voice("zeus", "male"),
  voice("perseus", "male"),
  voice("helios", "male"),
];

const aura2English: SpeechVoice[] = [
  voice("amalthea", "female", "菲律宾"),
  voice("andromeda", "female"),
  voice("apollo", "male"),
  voice("arcas", "male"),
  voice("aries", "male"),
  voice("asteria", "female"),
  voice("athena", "female"),
  voice("atlas", "male"),
  voice("aurora", "female"),
  voice("callista", "female"),
  voice("cora", "female"),
  voice("cordelia", "female"),
  voice("delia", "female"),
  voice("draco", "male", "英式"),
  voice("electra", "female"),
  voice("harmonia", "female"),
  voice("helena", "female"),
  voice("hera", "female"),
  voice("hermes", "male"),
  voice("hyperion", "male", "澳式"),
  voice("iris", "female"),
  voice("janus", "female"),
  voice("juno", "female"),
  voice("jupiter", "male"),
  voice("luna", "female"),
  voice("mars", "male"),
  voice("minerva", "female"),
  voice("neptune", "male"),
  voice("odysseus", "male"),
  voice("ophelia", "female"),
  voice("orion", "male"),
  voice("orpheus", "male"),
  voice("pandora", "female", "英式"),
  voice("phoebe", "female"),
  voice("pluto", "male"),
  voice("saturn", "male"),
  voice("thalia", "female"),
  voice("theia", "female", "澳式"),
  voice("vesta", "female"),
  voice("zeus", "male"),
];

const aura2Spanish: SpeechVoice[] = [
  voice("sirio", "male", "墨西哥"),
  voice("nestor", "male", "西班牙"),
  voice("carina", "female", "西班牙"),
  voice("celeste", "female", "哥伦比亚"),
  voice("alvaro", "male", "西班牙"),
  voice("diana", "female", "西班牙"),
  voice("aquila", "male", "拉美"),
  voice("selena", "female", "拉美"),
  voice("estrella", "female", "墨西哥"),
  voice("javier", "male", "墨西哥"),
];

export const SPEECH_MODELS: SpeechModel[] = [
  {
    id: "@cf/deepgram/aura-1",
    label: "Aura-1",
    defaultVoice: "asteria",
    pricePer1kChars: 0.015,
    voices: aura1,
  },
  {
    id: "@cf/deepgram/aura-2-en",
    label: "Aura-2 English",
    defaultVoice: "luna",
    pricePer1kChars: 0.03,
    voices: aura2English,
  },
  {
    id: "@cf/deepgram/aura-2-es",
    label: "Aura-2 Spanish",
    defaultVoice: "aquila",
    pricePer1kChars: 0.03,
    voices: aura2Spanish,
  },
];

export const DEFAULT_SPEECH_MODEL = SPEECH_MODELS[0].id;

export function speechModel(value: unknown): SpeechModel {
  if (typeof value === "string") {
    const id = value.trim().toLowerCase();
    const match = SPEECH_MODELS.find(model => model.id === id);
    if (match) return match;
  }
  return SPEECH_MODELS[0];
}

export function normalizeSpeechModel(value: unknown): string {
  return speechModel(value).id;
}

export function normalizeSpeechVoice(modelId: unknown, value: unknown): string {
  const model = speechModel(modelId);
  if (typeof value === "string") {
    const id = value.trim().toLowerCase();
    if (model.voices.some(entry => entry.id === id)) return id;
  }
  return model.defaultVoice;
}
