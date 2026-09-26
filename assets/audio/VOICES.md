# Azure voice packs

Each of the 10 avatars maps to one permanent voice profile per language. A
full table can therefore have 10 genuinely distinct voices.

Generated packs use this structure:

```text
assets/audio/pt/avatar_01/*.mp3
...
assets/audio/pt/avatar_10/*.mp3
```

The same folders are generated under `en` and `es`. Original language-level
`.m4a` files remain as automatic fallbacks.

## Secure setup on macOS

From the project directory, set credentials only for the current Terminal
window. Never paste them into source files or commit them:

```bash
read -s AZURE_SPEECH_KEY
export AZURE_SPEECH_KEY
export AZURE_SPEECH_REGION="norwayeast"
```

After the first command, paste Key 1 or Key 2 and press Enter. Nothing is
shown while pasting; this is expected. Do not type the key in the command.

## 1. Generate and review previews

```bash
python3 tools/generate_azure_voices.py preview
```

This queries the voices available to the Azure resource, assigns four female
and six male voices to the matching avatars, stores the non-secret mapping in
`tools/azure-selected-voices.json`, and creates 30 samples in `voice-previews/`.
Each sample also demonstrates that avatar's own sentence structure.

To discard that selection and choose a fresh compatible set:

```bash
python3 tools/generate_azure_voices.py preview --refresh
```

## 2. Generate the complete packs

Generate one language at a time:

```bash
python3 tools/generate_azure_voices.py generate --lang pt
python3 tools/generate_azure_voices.py generate --lang en
python3 tools/generate_azure_voices.py generate --lang es
```

Or generate all three:

```bash
python3 tools/generate_azure_voices.py generate
```

The command skips existing files, retries temporary Azure errors, and can be
stopped safely with `Ctrl+C`. Running it again resumes from the missing clip.
Once a language is complete, its 10 profiles are activated automatically in
`data.js`.

Check progress at any time:

```bash
python3 tools/generate_azure_voices.py status
```

When finished, close the Terminal window or run `unset AZURE_SPEECH_KEY`.
