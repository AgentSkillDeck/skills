# Qwen3 voices (optional, Apple Silicon)

A second voice engine next to Supertonic: Qwen3-TTS 1.7B, run on the Mac's GPU with mlx-audio. It takes delivery as an instruction in words, so emotion lands better than with the speed and filter chain Supertonic needs. Supertonic stays the default and the only engine on Windows, Linux and Intel Macs.

## When to offer it

- The user is on macOS with Apple Silicon (`setup.mjs --check` shows `"qwen3": {"supported": true}`), and
- the piece needs a natural documentary or conversational read, or a voice designed from a description.

Otherwise cast Supertonic. A Qwen line on an unsupported machine exits 2 with a hint to recast.

## Install: ask first

`--check` reports it under `"qwen3"` (`"optional": true`); its absence never fails the check. Ask once, with the facts:

> Qwen3 voices need a separate install: about 3.1 GB of model weights (Qwen3-TTS, Apache-2.0) and the mlx-audio runner (MIT) in `~/.agentskilldeck/venv-qwen3`. It runs offline afterwards and nothing is uploaded. Install now?

```sh
node scripts/setup.mjs --install-qwen3            # CustomVoice: the nine voices
node scripts/setup.mjs --install-qwen3 --design   # also VoiceDesign (about 3 GB more)
```

Weights already in the Hugging Face cache are reused, never downloaded again. Ask separately before `--design`: it is only for `qwen:design`. `AGENTSKILLDECK_QWEN3_PYTHON` points at an existing Python that already has `mlx-audio`, which skips the venv. Rendering speed is about real time (10 s of render per 10 s line) on an M-series Mac with memory to spare, and slower when memory is tight. Render one piece at a time.

## Voices

| Cast as | Gender | Native language | Notes |
|---|---|---|---|
| `qwen:ryan` | male | English | warm, measured; strong documentary narrator |
| `qwen:aiden` | male | English | lighter, quicker |
| `qwen:vivian` | female | Chinese | |
| `qwen:serena` | female | Chinese | |
| `qwen:uncle_fu` | male | Chinese | older |
| `qwen:dylan` | male | Chinese (Beijing) | |
| `qwen:eric` | male | Chinese (Sichuan) | |
| `qwen:ono_anna` | female | Japanese | |
| `qwen:sohee` | female | Korean | |
| `qwen:design` | from `gender:` | any | VoiceDesign: the voice comes from `describe:` |

Every voice speaks English, Chinese, German, Italian, Portuguese, Spanish, Japanese, Korean, French and Russian; the native-English voices sound most natural in English. None is a real person.

```yaml
cast:
  NARRATOR: { voice: qwen:ryan, style: "Documentary narrator" }
  ANA:      { voice: qwen:design, describe: "A bright young woman with a crisp British accent", gender: female }
  ELI:      { voice: M3 }        # Supertonic and Qwen lines mix freely
```

- `style:` is a persona that stays constant for the speaker; the line's emotion is added after it.
- `describe:` (required for `qwen:design`) is the voice itself, in words: age, gender, accent, timbre. Never describe a real person ("sounds like <name>").
- `gender:` picks the breath and gasp samples for `qwen:design` (the named voices know theirs).

## Delivery

Each of the 14 emotions maps to an instruction sentence (`QWEN_INSTRUCT` in `lib/presets.mjs`); modifiers add a clause (`slow`: "Take it slower than usual."). The speed, gain and filter values in [delivery](delivery.md) are not applied on top of Qwen output: the instruction carries the delivery. The pause before and after the line still applies. Nonverbals are always spliced from the sample pack (Qwen has no native laugh tag).

## Audition

```sh
node scripts/audition.mjs "The lamp had burned for forty years." --voices qwen --out /abs/out/audition
node scripts/audition.mjs "The lamp had burned for forty years." --voices qwen:ryan,M3 --emotion calm --style "Documentary narrator" --out /abs/out/audition
node scripts/audition.mjs "Welcome back." --describe "A calm older woman, low and warm, slight Scottish accent" --out /abs/out/audition
```

`--voices qwen` takes all nine; with `--describe` it adds the designed voice. Files are named `qwen-ryan.mp3` and so on.

## QA and retakes

Same gate as Supertonic: every take is transcribed and checked, and a failing line is re-rendered with the next seed. Seeds change the take on Qwen too. For tech narration, pass `--qa-model small` or `medium` to `produce.mjs`: base whisper mishears more terms. A term that keeps failing needs a lexicon entry ([script-format](script-format.md), `lexicon:`).

Measured on 17 Nov 2026 (ryan and aiden, calm, documentary style): numbers ("eleven fifty-eight", "twenty twenty-four") and `--force-with-lease` were read correctly without a respelling, and a sentence-initial "The" was kept. "git" was heard as "get" by every whisper size on some takes; the bundled lexicon respells it.

## Cloning

Cloning stays on the existing path (`clone:<name>`, Chatterbox, with the consent statement; [your-voice](your-voice.md)). The Qwen Base model's 3-second clone is not wired in.

## Licences

Qwen3-TTS weights: Apache-2.0 (commercial use allowed). mlx-audio: MIT. `CREDITS.md` names the engine and the voice for each Qwen speaker. Disclose synthetic narration as for any voice ([ethics-licensing](ethics-licensing.md)).
