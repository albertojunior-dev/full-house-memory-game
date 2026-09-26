#!/usr/bin/env python3
"""Generate Mesa Cheia voice packs with Azure Speech using only stdlib.

Credentials are read from AZURE_SPEECH_KEY and AZURE_SPEECH_REGION. They are
never written to disk or printed. Run `preview` first, listen to the 30 samples,
then run `generate` to create every menu and connector clip.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_JS = ROOT / "data.js"
SELECTION_FILE = ROOT / "tools" / "azure-selected-voices.json"
PREVIEW_DIR = ROOT / "voice-previews"
AUDIO_DIR = ROOT / "assets" / "audio"
LANGUAGES = ("pt", "en", "es")
AVATAR_GENDERS = {1: "Male", 2: "Female", 3: "Female", 4: "Male", 5: "Female",
                  6: "Male", 7: "Female", 8: "Male", 9: "Male", 10: "Male"}
LOCALES = {
    "pt": ["pt-PT", "pt-BR"],
    "en": ["en-GB", "en-US", "en-IE", "en-AU", "en-CA"],
    "es": ["es-ES", "es-MX", "es-US", "es-AR", "es-CO"],
}
CONNECTORS = {
    "pt": {
        "conn_greet_morning": "Bom dia.", "conn_greet_afternoon": "Boa tarde.", "conn_greet": "Boa noite.",
        "conn_drink_intro": "Para mim, para beber,", "conn_drink_outro": "por favor.",
        "conn_entrada_intro": "Como entrada, vou querer", "conn_principal_intro": "Como prato principal, vou querer",
        "conn_principal_mid": "acompanhado de", "conn_sobremesa_intro": "De sobremesa, vou querer",
    },
    "en": {
        "conn_greet_morning": "Good morning.", "conn_greet_afternoon": "Good afternoon.", "conn_greet": "Good evening.",
        "conn_drink_intro": "I'll have", "conn_drink_outro": "to drink, please.",
        "conn_entrada_intro": "For starters, I'll have the", "conn_principal_intro": "For the main course, I'll have the",
        "conn_principal_mid": "with", "conn_sobremesa_intro": "For dessert, I'll have the",
    },
    "es": {
        "conn_greet_morning": "Buenos días.", "conn_greet_afternoon": "Buenas tardes.", "conn_greet": "Buenas noches.",
        "conn_drink_intro": "Para beber, quiero", "conn_drink_outro": "por favor.",
        "conn_entrada_intro": "De entrada, quiero", "conn_principal_intro": "De principal, quiero",
        "conn_principal_mid": "con", "conn_sobremesa_intro": "De postre, quiero",
    },
}


def credentials() -> tuple[str, str]:
    key = os.environ.get("AZURE_SPEECH_KEY", "").strip()
    region = os.environ.get("AZURE_SPEECH_REGION", "").strip().lower().replace(" ", "")
    if not key or not region:
        raise SystemExit("Define AZURE_SPEECH_KEY and AZURE_SPEECH_REGION before running this command.")
    return key, region


def request(url: str, key: str, *, body: bytes | None = None, headers: dict[str, str] | None = None) -> bytes:
    all_headers = {"Ocp-Apim-Subscription-Key": key, **(headers or {})}
    req = urllib.request.Request(url, data=body, headers=all_headers, method="POST" if body is not None else "GET")
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=45) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            if exc.code in (429, 500, 502, 503) and attempt < 4:
                time.sleep(2 ** attempt)
                continue
            detail = exc.read().decode("utf-8", "replace")[:300]
            raise RuntimeError(f"Azure returned HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            if attempt < 4:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"Could not reach Azure Speech: {exc.reason}") from exc
    raise RuntimeError("Azure request failed after retries.")


def list_voices() -> list[dict]:
    key, region = credentials()
    url = f"https://{region}.tts.speech.microsoft.com/cognitiveservices/voices/list"
    return json.loads(request(url, key).decode("utf-8"))


def is_candidate(voice: dict, lang: str, gender: str) -> bool:
    short_name = voice.get("ShortName", "")
    if voice.get("Gender") != gender or not short_name.endswith("Neural") or "HD" in short_name:
        return False
    locales = {voice.get("Locale", ""), *(voice.get("SecondaryLocaleList") or [])}
    return bool(locales.intersection(LOCALES[lang]))


def select_voices(available: list[dict]) -> dict[str, list[dict]]:
    selected: dict[str, list[dict]] = {}
    for lang in LANGUAGES:
        used: set[str] = set()
        assignments: list[dict] = []
        for avatar in range(1, 11):
            gender = AVATAR_GENDERS[avatar]
            candidates = [v for v in available if is_candidate(v, lang, gender) and v.get("ShortName") not in used]
            candidates.sort(key=lambda v: (LOCALES[lang].index(v["Locale"]) if v.get("Locale") in LOCALES[lang] else 99, v["ShortName"]))
            if not candidates:
                raise RuntimeError(f"Not enough distinct {gender.lower()} voices for {lang}. Run the 'voices' command to inspect availability.")
            voice = candidates[0]
            used.add(voice["ShortName"])
            assignments.append({
                "avatar": avatar, "gender": gender.lower(), "folder": f"avatar_{avatar:02d}",
                "shortName": voice["ShortName"], "locale": voice["Locale"],
                "displayName": voice.get("DisplayName", voice["ShortName"]),
            })
        selected[lang] = assignments
    return selected


def load_or_create_selection(refresh: bool = False) -> dict[str, list[dict]]:
    if SELECTION_FILE.exists() and not refresh:
        return json.loads(SELECTION_FILE.read_text(encoding="utf-8"))
    selection = select_voices(list_voices())
    SELECTION_FILE.write_text(json.dumps(selection, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return selection


def synthesize(text: str, voice: dict, destination: Path) -> None:
    key, region = credentials()
    ssml = (
        f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="{html.escape(voice["locale"])}">'
        f'<voice name="{html.escape(voice["shortName"])}">{html.escape(text)}</voice></speak>'
    ).encode("utf-8")
    url = f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1"
    audio = request(url, key, body=ssml, headers={
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "MesaCheiaVoiceGenerator/1.0",
    })
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(audio)


def speech_phrase_rows() -> dict[str, list[list[str]]]:
    """Read the ten connector styles directly from data.js."""
    source = DATA_JS.read_text(encoding="utf-8")
    block = source.split("const SPEECH_PHRASES = {", 1)[1].split("const SPEECH_VARIANTS", 1)[0]
    rows: dict[str, list[list[str]]] = {lang: [] for lang in LANGUAGES}
    current: str | None = None
    for raw_line in block.splitlines():
        line = raw_line.strip()
        match = re.match(r"(pt|en|es):\s*\[$", line)
        if match:
            current = match.group(1)
        elif current and line.startswith('["'):
            rows[current].append(json.loads(line.rstrip(",")))
        elif current and line == "],":
            current = None
    if any(len(rows[lang]) != 10 for lang in LANGUAGES):
        raise RuntimeError("Could not read the ten avatar speech styles from data.js.")
    return rows


def clip_manifest(lang: str, avatar: int) -> dict[str, str]:
    source = DATA_JS.read_text(encoding="utf-8")
    js_string = r'((?:\\.|[^"\\])*)'
    pattern = re.compile(
        r'\{\s*id:\s*"' + js_string + r'",\s*pt:\s*"' + js_string
        + r'",\s*en:\s*"' + js_string + r'",\s*es:\s*"' + js_string + r'"\s*\}'
    )
    clips = dict(CONNECTORS[lang])
    row = speech_phrase_rows()[lang][avatar - 1]
    for clip_id, text in zip(
        ("conn_drink_intro", "conn_drink_outro", "conn_entrada_intro", "conn_principal_intro", "conn_principal_mid", "conn_sobremesa_intro"),
        row,
    ):
        clips[clip_id] = text
    for raw_id, raw_pt, raw_en, raw_es in pattern.findall(source):
        clip_id, pt, en, es = [json.loads(f'"{value}"') for value in (raw_id, raw_pt, raw_en, raw_es)]
        text = {"pt": pt, "en": en, "es": es}[lang]
        clips[clip_id] = text + "."
    if len(clips) < 90:
        raise RuntimeError("Could not extract the menu texts from data.js.")
    return clips


def preview_text(lang: str, avatar: int) -> str:
    row = speech_phrase_rows()[lang][avatar - 1]
    drink = {"pt": "água com gás", "en": "sparkling water", "es": "agua con gas"}[lang]
    main = {"pt": "bife da casa", "en": "house steak", "es": "bistec de la casa"}[lang]
    side = {"pt": "batata frita", "en": "fries", "es": "patatas fritas"}[lang]
    return f'{CONNECTORS[lang]["conn_greet"]} {row[0]} {drink} {row[1]} {row[3]} {main}, {row[4]} {side}.'


def show_selection(selection: dict[str, list[dict]]) -> None:
    for lang in LANGUAGES:
        print(f"\n{lang.upper()}")
        for voice in selection[lang]:
            print(f"  Avatar {voice['avatar']:02d} ({voice['gender']}): {voice['shortName']} [{voice['locale']}]")


def preview(refresh: bool) -> None:
    selection = load_or_create_selection(refresh)
    show_selection(selection)
    total = 30
    done = 0
    for lang in LANGUAGES:
        for voice in selection[lang]:
            destination = PREVIEW_DIR / lang / f"avatar_{voice['avatar']:02d}.mp3"
            synthesize(preview_text(lang, voice["avatar"]), voice, destination)
            done += 1
            print(f"[{done:02d}/{total}] {destination.relative_to(ROOT)}")
            time.sleep(0.15)
    print("\nPreviews ready. Listen to the files in voice-previews before running generate.")


def mark_recorded(lang: str) -> None:
    source = DATA_JS.read_text(encoding="utf-8")
    for avatar in range(1, 11):
        profile_id = f'{lang}_avatar_{avatar:02d}'
        pattern = rf'(id:\s*"{re.escape(profile_id)}"[^\n]*recorded:\s*)false'
        source, count = re.subn(pattern, r'\1true', source)
        if count != 1:
            raise RuntimeError(f"Could not activate voice profile {profile_id} in data.js.")
    DATA_JS.write_text(source, encoding="utf-8")


def generate(languages: list[str]) -> None:
    selection = load_or_create_selection()
    jobs = [(lang, voice, clip_id, text) for lang in languages for voice in selection[lang]
            for clip_id, text in clip_manifest(lang, voice["avatar"]).items()]
    pending = [(lang, voice, clip_id, text) for lang, voice, clip_id, text in jobs
               if not (AUDIO_DIR / lang / voice["folder"] / f"{clip_id}.mp3").exists()]
    print(f"Total: {len(jobs)} clips; already present: {len(jobs) - len(pending)}; pending: {len(pending)}")
    for index, (lang, voice, clip_id, text) in enumerate(pending, 1):
        destination = AUDIO_DIR / lang / voice["folder"] / f"{clip_id}.mp3"
        synthesize(text, voice, destination)
        print(f"[{index}/{len(pending)}] {lang}/{voice['folder']}/{clip_id}.mp3")
        time.sleep(0.15)
    for lang in languages:
        expected = sum(len(clip_manifest(lang, voice["avatar"])) for voice in selection[lang])
        actual = sum(1 for voice in selection[lang] for clip_id in clip_manifest(lang, voice["avatar"])
                     if (AUDIO_DIR / lang / voice["folder"] / f"{clip_id}.mp3").exists())
        if actual == expected:
            mark_recorded(lang)
            print(f"{lang.upper()}: complete ({actual}/{expected}) and activated in data.js.")
        else:
            print(f"{lang.upper()}: incomplete ({actual}/{expected}); profiles remain disabled.")


def status(languages: list[str]) -> None:
    selection = load_or_create_selection()
    show_selection(selection)
    for lang in languages:
        expected = sum(len(clip_manifest(lang, voice["avatar"])) for voice in selection[lang])
        actual = sum(1 for voice in selection[lang] for clip_id in clip_manifest(lang, voice["avatar"])
                     if (AUDIO_DIR / lang / voice["folder"] / f"{clip_id}.mp3").exists())
        print(f"{lang.upper()}: {actual}/{expected} clips")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Mesa Cheia Azure voice packs")
    parser.add_argument("command", choices=("voices", "preview", "generate", "status"))
    parser.add_argument("--lang", choices=LANGUAGES, action="append", help="Limit generate/status to one or more languages")
    parser.add_argument("--refresh", action="store_true", help="Choose a fresh set of voices from Azure")
    args = parser.parse_args()
    languages = args.lang or list(LANGUAGES)
    try:
        if args.command == "voices": show_selection(load_or_create_selection(args.refresh))
        elif args.command == "preview": preview(args.refresh)
        elif args.command == "generate": generate(languages)
        else: status(languages)
    except KeyboardInterrupt:
        print("\nStopped safely. Run the same command again to resume.")
        raise SystemExit(130)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
