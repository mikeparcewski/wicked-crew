/**
 * The text-to-speech manifest (DES studio#1140, "One engine, one install, owned by crew's voice service"): data
 * only. The engine is the person's own `pip install` of piper-tts from PyPI, run as a separate program; crew never
 * ships or hosts it (it is GPL-3.0-or-later). The voices are two licence-cleared files each, fetched from Hugging
 * Face at one pinned commit and held to a sha256 and a size. Only these voices can be installed.
 */

export const TTS_ENGINE = Object.freeze({
  name: 'piper-tts',
  version: '1.8.0',
  licence: 'GPL-3.0-or-later',
  /** The one index the person's pip is pointed at. */
  index: 'https://pypi.org/simple',
});

/** rhasspy/piper-voices at this commit; every voice file URL is built from it. */
export const TTS_VOICES_COMMIT = '2f358b6a560e3a913ebf509b2f3344f20b367f94';
export const TTS_VOICES_SOURCE = 'huggingface.co/rhasspy/piper-voices';

export interface TtsVoiceFile { path: string; sha256: string; bytes: number }

export interface TtsVoice {
  id: string;
  name: string;
  accent: string;
  licence: string;
  clearance: { basis: string; reviewed: string };
  /** The model, then its config. */
  model: TtsVoiceFile;
  config: TtsVoiceFile;
}

export const TTS_VOICES: readonly Readonly<TtsVoice>[] = Object.freeze([
  {
    id: 'en_US-joe-medium',
    name: 'Joe',
    accent: 'US English, medium',
    licence: 'CC0',
    clearance: { basis: 'dataset CC0 (MODEL_CARD); fine-tuned from the rdh base, CC0; no attribution needed', reviewed: '2026-11-12' },
    model: { path: 'en/en_US/joe/medium/en_US-joe-medium.onnx', sha256: 'abf4b998e34045cbd00eaf050de2de620f81ded6eb8b85a24b022a1c2b3f08d2', bytes: 63_221_984 },
    config: { path: 'en/en_US/joe/medium/en_US-joe-medium.onnx.json', sha256: '7b5f0293c0bf5bda8e377be1696da84af798befeef31038e43beefc01fe858da', bytes: 5465 },
  },
  {
    id: 'en_GB-cori-high',
    name: 'Cori',
    accent: 'UK English, high',
    licence: 'Public domain',
    clearance: { basis: 'LibriVox recordings, public domain (MODEL_CARD); trained from scratch; no attribution needed', reviewed: '2026-11-12' },
    model: { path: 'en/en_GB/cori/high/en_GB-cori-high.onnx', sha256: '470b4dd634c98f8a4850d7626ffc3dfc90774628eeef6605a6dd8f88f30a5903', bytes: 114_219_352 },
    config: { path: 'en/en_GB/cori/high/en_GB-cori-high.onnx.json', sha256: '9e7fb5b5671612c22f3c81cbe46c1ae87b031a4632bcb509e499dad6f1e2adec', bytes: 4963 },
  },
]);

export function ttsVoiceUrl(file: TtsVoiceFile): string {
  return `https://huggingface.co/rhasspy/piper-voices/resolve/${TTS_VOICES_COMMIT}/${file.path}`;
}
