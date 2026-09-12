import { describe, expect, it } from "vitest";
import { translationText } from "./providers";
import { normalizeSpeechModel, normalizeSpeechVoice } from "./voices";

describe("speech models", () => {
  it("falls back to Aura-1 for unknown models", () => {
    expect(normalizeSpeechModel(undefined)).toBe("@cf/deepgram/aura-1");
    expect(normalizeSpeechModel("bogus")).toBe("@cf/deepgram/aura-1");
  });

  it("validates voices against the selected model", () => {
    expect(normalizeSpeechVoice("@cf/deepgram/aura-2-es", "aquila")).toBe("aquila");
    expect(normalizeSpeechVoice("@cf/deepgram/aura-2-es", "asteria")).toBe("aquila");
    expect(normalizeSpeechVoice("@cf/deepgram/aura-2-en", "luna")).toBe("luna");
    expect(normalizeSpeechVoice("@cf/deepgram/aura-1", "luna")).toBe("luna");
  });
});

describe("translation output", () => {
  it("reads both Workers AI response shapes", () => {
    expect(translationText({ response: " 你好 " })).toBe("你好");
    expect(translationText({ choices: [{ message: { content: " hello " } }] })).toBe("hello");
    expect(translationText({ choices: [] })).toBe("");
    expect(translationText(null)).toBe("");
  });
});
