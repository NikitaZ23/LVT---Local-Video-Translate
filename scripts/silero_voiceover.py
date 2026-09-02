import argparse
import html
import re
import sys
import wave
from pathlib import Path

import numpy as np
import torch


TIMESTAMP_RE = re.compile(
    r"^(?P<start>\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+"
    r"(?P<end>\d{2}:\d{2}:\d{2}\.\d{3})(?:\s+.*)?$"
)
TAG_RE = re.compile(r"<[^>]+>")
LATIN_TOKEN_RE = re.compile(r"(?<![\wА-Яа-яЁё])([A-Za-z][A-Za-z0-9_+#.-]*)(?![\wА-Яа-яЁё])")
NUMBER_RE = re.compile(r"(?<![\wА-Яа-яЁё])(\d+(?:[.,]\d+)?)(?![\wА-Яа-яЁё])")
UNSUPPORTED_TTS_RE = re.compile(r"[^А-Яа-яЁё\s.,!?;:()\"'-]")
LATIN_PHRASE_REPLACEMENTS = [
    (re.compile(r"(?<![A-Za-zА-Яа-яЁё])C\+\+(?![A-Za-zА-Яа-яЁё])", re.IGNORECASE), "си плюс плюс"),
    (re.compile(r"(?<![A-Za-zА-Яа-яЁё])C#(?![A-Za-zА-Яа-яЁё])", re.IGNORECASE), "си шарп"),
    (re.compile(r"(?<![A-Za-zА-Яа-яЁё])\.NET(?![A-Za-zА-Яа-яЁё])", re.IGNORECASE), "дот нет"),
]
LATIN_PRONUNCIATIONS = {
    "ai": "эй ай",
    "api": "эй пи ай",
    "cpu": "си пи ю",
    "css": "си эс эс",
    "fps": "эф пи эс",
    "gpu": "джи пи ю",
    "html": "эйч ти эм эл",
    "http": "эйч ти ти пи",
    "https": "эйч ти ти пи эс",
    "id": "ай ди",
    "json": "джейсон",
    "npc": "эн пи си",
    "ram": "рэм",
    "sdk": "эс ди кей",
    "ui": "ю ай",
    "url": "ю ар эл",
    "ux": "ю икс",
    "vr": "ви ар",
    "ar": "эй ар",
    "unreal": "анриал",
    "engine": "энджин",
    "blueprint": "блупринт",
    "blueprints": "блупринты",
    "inventory": "инвентори",
    "system": "систем",
    "overview": "овервью",
    "migration": "майгрейшн",
    "guide": "гайд",
    "game": "гейм",
    "player": "плеер",
    "controller": "контроллер",
    "character": "кэрэктер",
    "actor": "актор",
    "pawn": "поун",
    "widget": "виджет",
    "mesh": "меш",
    "component": "компонент",
    "event": "ивент",
    "input": "инпут",
    "output": "аутпут",
    "level": "левел",
    "map": "мэп",
    "folder": "фолдер",
    "file": "файл",
    "project": "проект",
    "asset": "ассет",
    "class": "класс",
    "interface": "интерфейс",
    "function": "функция",
}
LETTER_PRONUNCIATIONS = {
    "a": "эй",
    "b": "би",
    "c": "си",
    "d": "ди",
    "e": "и",
    "f": "эф",
    "g": "джи",
    "h": "эйч",
    "i": "ай",
    "j": "джей",
    "k": "кей",
    "l": "эл",
    "m": "эм",
    "n": "эн",
    "o": "оу",
    "p": "пи",
    "q": "кью",
    "r": "ар",
    "s": "эс",
    "t": "ти",
    "u": "ю",
    "v": "ви",
    "w": "дабл ю",
    "x": "икс",
    "y": "вай",
    "z": "зет",
}
DIGIT_PRONUNCIATIONS = {
    "0": "ноль",
    "1": "один",
    "2": "два",
    "3": "три",
    "4": "четыре",
    "5": "пять",
    "6": "шесть",
    "7": "семь",
    "8": "восемь",
    "9": "девять",
}
UNITS_MASCULINE = [
    "",
    "один",
    "два",
    "три",
    "четыре",
    "пять",
    "шесть",
    "семь",
    "восемь",
    "девять",
]
UNITS_FEMININE = [
    "",
    "одна",
    "две",
    "три",
    "четыре",
    "пять",
    "шесть",
    "семь",
    "восемь",
    "девять",
]
TEENS = [
    "десять",
    "одиннадцать",
    "двенадцать",
    "тринадцать",
    "четырнадцать",
    "пятнадцать",
    "шестнадцать",
    "семнадцать",
    "восемнадцать",
    "девятнадцать",
]
TENS = [
    "",
    "",
    "двадцать",
    "тридцать",
    "сорок",
    "пятьдесят",
    "шестьдесят",
    "семьдесят",
    "восемьдесят",
    "девяносто",
]
HUNDREDS = [
    "",
    "сто",
    "двести",
    "триста",
    "четыреста",
    "пятьсот",
    "шестьсот",
    "семьсот",
    "восемьсот",
    "девятьсот",
]
TRANSLIT_REPLACEMENTS = [
    ("tion", "шен"),
    ("sion", "жен"),
    ("ght", "т"),
    ("sch", "ш"),
    ("sh", "ш"),
    ("ch", "ч"),
    ("ph", "ф"),
    ("th", "т"),
    ("ck", "к"),
    ("qu", "кв"),
    ("oo", "у"),
    ("ee", "и"),
    ("ea", "и"),
    ("ai", "эй"),
    ("ay", "эй"),
    ("ou", "ау"),
    ("ow", "оу"),
    ("oy", "ой"),
    ("oi", "ой"),
    ("ing", "инг"),
]
TRANSLIT_CHARS = {
    "a": "а",
    "b": "б",
    "c": "к",
    "d": "д",
    "e": "е",
    "f": "ф",
    "g": "г",
    "h": "х",
    "i": "и",
    "j": "дж",
    "k": "к",
    "l": "л",
    "m": "м",
    "n": "н",
    "o": "о",
    "p": "п",
    "q": "к",
    "r": "р",
    "s": "с",
    "t": "т",
    "u": "у",
    "v": "в",
    "w": "в",
    "x": "кс",
    "y": "й",
    "z": "з",
}


def parse_args():
    parser = argparse.ArgumentParser(description="Create a Russian voiceover WAV from WebVTT cues with Silero TTS.")
    parser.add_argument("--input", required=True, help="Input .vtt subtitles.")
    parser.add_argument("--output", required=True, help="Output .wav voiceover.")
    parser.add_argument("--model", required=True, help="Silero .pt model file.")
    parser.add_argument("--speaker", default="xenia", help="Silero speaker name.")
    parser.add_argument("--sample-rate", type=int, default=48000, help="Output sample rate.")
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu", help="Torch device for TTS.")
    parser.add_argument("--threads", type=int, default=4, help="CPU threads for Torch.")
    parser.add_argument("--max-speed", type=float, default=1.35, help="Maximum cue speed-up to fit timestamps.")
    parser.add_argument("--volume", type=float, default=0.92, help="Voice gain before final normalization.")
    parser.add_argument("--check", action="store_true", help="Load model and synthesize a tiny sample only.")
    return parser.parse_args()


def parse_timestamp(value):
    hours, minutes, rest = value.split(":")
    seconds, millis = rest.split(".")
    return (
        int(hours) * 3600
        + int(minutes) * 60
        + int(seconds)
        + int(millis) / 1000
    )


def parse_vtt(path):
    lines = Path(path).read_text(encoding="utf-8-sig").splitlines()
    cues = []
    current = None

    for line in lines:
        stripped = line.strip()
        match = TIMESTAMP_RE.match(stripped)
        if match:
            if current:
                cues.append(current)
            current = {
                "start": parse_timestamp(match.group("start")),
                "end": parse_timestamp(match.group("end")),
                "text": [],
            }
            continue

        if current is None:
            continue

        if not stripped:
            cues.append(current)
            current = None
            continue

        current["text"].append(line)

    if current:
        cues.append(current)

    cleaned = []
    for cue in cues:
        text = clean_text(" ".join(cue["text"]))
        if text:
            cleaned.append({**cue, "text": text})
    return cleaned


def clean_text(value):
    text = TAG_RE.sub("", value)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return prepare_tts_text(text)


def prepare_tts_text(value):
    text = value
    for pattern, replacement in LATIN_PHRASE_REPLACEMENTS:
        text = pattern.sub(replacement, text)

    text = normalize_tts_symbols(text)
    text = LATIN_TOKEN_RE.sub(lambda match: pronounce_latin_token(match.group(1)), text)
    text = NUMBER_RE.sub(lambda match: pronounce_number(match.group(1)), text)
    text = UNSUPPORTED_TTS_RE.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def strict_tts_text(value):
    text = normalize_tts_symbols(value)
    text = NUMBER_RE.sub(lambda match: pronounce_number(match.group(1)), text)
    text = UNSUPPORTED_TTS_RE.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def normalize_tts_symbols(value):
    text = value.replace("№", " номер ")
    text = text.replace("%", " процентов ")
    text = text.replace("&", " и ")
    text = text.replace("+", " плюс ")
    text = text.replace("=", " равно ")
    text = text.replace("/", " ")
    text = text.replace("\\", " ")
    text = text.replace("…", ".")
    text = text.replace("—", "-").replace("–", "-")
    return text


def pronounce_latin_token(token):
    if re.search(r"[._-]", token):
        parts = [part for part in re.split(r"[._-]+", token) if part]
        return " ".join(pronounce_latin_token(part) for part in parts)

    lower = token.lower()
    if lower in LATIN_PRONUNCIATIONS:
        return LATIN_PRONUNCIATIONS[lower]

    mixed = re.fullmatch(r"([A-Za-z]+)(\d+)", token)
    if mixed and (mixed.group(1).isupper() or len(mixed.group(1)) <= 3):
        return f"{pronounce_latin_token(mixed.group(1))} {pronounce_digits(mixed.group(2))}"

    if token.isupper() and len(token) <= 8:
        return spell_latin_token(token)

    if len(token) <= 3 and token.isalpha():
        return spell_latin_token(token)

    return transliterate_latin_word(token)


def spell_latin_token(token):
    pieces = []
    for char in token.lower():
        if char in LETTER_PRONUNCIATIONS:
            pieces.append(LETTER_PRONUNCIATIONS[char])
        elif char in DIGIT_PRONUNCIATIONS:
            pieces.append(DIGIT_PRONUNCIATIONS[char])
    return " ".join(pieces) or token


def pronounce_digits(value):
    return " ".join(DIGIT_PRONUNCIATIONS.get(char, char) for char in value)


def pronounce_number(value):
    token = value.replace(",", ".")
    if "." in token:
        integer, fraction = token.split(".", 1)
        integer_text = pronounce_integer(integer)
        fraction_text = " ".join(DIGIT_PRONUNCIATIONS.get(char, char) for char in fraction if char.isdigit())
        return f"{integer_text} целых {fraction_text}".strip()

    return pronounce_integer(token)


def pronounce_integer(value):
    digits = value.lstrip("0") or "0"
    if len(digits) > 9:
        return pronounce_digits(value)

    number = int(digits)
    if number == 0:
        return "ноль"

    millions = number // 1_000_000
    thousands = (number // 1_000) % 1_000
    rest = number % 1_000
    parts = []

    if millions:
        parts.append(pronounce_hundreds(millions, feminine=False))
        parts.append(decline_counted_word(millions, "миллион", "миллиона", "миллионов"))

    if thousands:
        parts.append(pronounce_hundreds(thousands, feminine=True))
        parts.append(decline_counted_word(thousands, "тысяча", "тысячи", "тысяч"))

    if rest:
        parts.append(pronounce_hundreds(rest, feminine=False))

    return " ".join(part for part in parts if part)


def pronounce_hundreds(number, feminine=False):
    parts = []
    units = UNITS_FEMININE if feminine else UNITS_MASCULINE
    parts.append(HUNDREDS[number // 100])
    remainder = number % 100

    if 10 <= remainder <= 19:
        parts.append(TEENS[remainder - 10])
    else:
        parts.append(TENS[remainder // 10])
        parts.append(units[remainder % 10])

    return " ".join(part for part in parts if part)


def decline_counted_word(number, one, few, many):
    last_two = number % 100
    last = number % 10
    if 11 <= last_two <= 19:
        return many
    if last == 1:
        return one
    if 2 <= last <= 4:
        return few
    return many


def transliterate_latin_word(token):
    word = token.lower()
    for source, replacement in TRANSLIT_REPLACEMENTS:
        word = word.replace(source, replacement)

    return "".join(TRANSLIT_CHARS.get(char, char) for char in word)


def load_model(model_path, device, threads):
    torch.set_num_threads(max(1, threads))
    actual_device = device
    if device == "cuda" and not torch.cuda.is_available():
        print("CUDA is not available for Torch, falling back to CPU.", file=sys.stderr)
        actual_device = "cpu"

    importer = torch.package.PackageImporter(model_path)
    model = importer.load_pickle("tts_models", "model")
    model.to(torch.device(actual_device))
    return model, actual_device


def synthesize(model, text, speaker, sample_rate, cue_index=None):
    try:
        audio = apply_tts(model, text, speaker, sample_rate)
    except Exception as error:
        fallback_text = strict_tts_text(text)
        if fallback_text and fallback_text != text:
            try:
                print(
                    f"Retry cue {cue_index or '?'} with safer text: {fallback_text[:80]}",
                    file=sys.stderr,
                )
                audio = apply_tts(model, fallback_text, speaker, sample_rate)
            except Exception as fallback_error:
                print(
                    f"Skip cue {cue_index or '?'}: {fallback_error.__class__.__name__}: {fallback_error}",
                    file=sys.stderr,
                )
                return np.zeros(0, dtype=np.float32)
        else:
            print(
                f"Skip cue {cue_index or '?'}: {error.__class__.__name__}: {error}",
                file=sys.stderr,
            )
            return np.zeros(0, dtype=np.float32)

    return normalize_audio(audio)


def apply_tts(model, text, speaker, sample_rate):
    with torch.inference_mode():
        # Silero's accent/yo preprocessing can try to download Stanza resources.
        # Keep it disabled so LVT voiceover stays fully offline.
        return model.apply_tts(
            text=text,
            speaker=speaker,
            sample_rate=sample_rate,
            put_accent=False,
            put_yo=False,
        )


def normalize_audio(audio):
    if isinstance(audio, torch.Tensor):
        audio = audio.detach().cpu().numpy()

    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    if audio.size == 0:
        return audio

    peak = float(np.max(np.abs(audio)))
    if peak > 1:
        audio = audio / peak
    return audio


def fit_audio_to_cue(audio, cue_duration, sample_rate, max_speed):
    target_samples = int(cue_duration * sample_rate)
    if target_samples <= 0 or audio.size <= target_samples:
        return audio

    speed = audio.size / target_samples
    if speed > max_speed:
        return audio

    source = np.linspace(0, 1, num=audio.size, endpoint=False)
    target = np.linspace(0, 1, num=target_samples, endpoint=False)
    return np.interp(target, source, audio).astype(np.float32)


def mix_cues(cues, model, speaker, sample_rate, max_speed, volume):
    output = np.zeros(1, dtype=np.float32)

    for index, cue in enumerate(cues, start=1):
        print(f"[{index}/{len(cues)}] {cue['text'][:80]}", file=sys.stderr)
        audio = synthesize(model, cue["text"], speaker, sample_rate, index)
        audio = fit_audio_to_cue(audio, cue["end"] - cue["start"], sample_rate, max_speed)
        if audio.size == 0:
            continue

        start = max(0, int(cue["start"] * sample_rate))
        end = start + audio.size
        if end > output.size:
            output = np.pad(output, (0, end - output.size))

        output[start:end] += audio * volume

    peak = float(np.max(np.abs(output))) if output.size else 0
    if peak > 0.98:
        output = output * (0.98 / peak)
    return np.clip(output, -1, 1)


def write_wav(path, audio, sample_rate):
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)

    with wave.open(str(output_path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())


def main():
    args = parse_args()

    if not Path(args.model).is_file():
        print(f"Silero model not found: {args.model}", file=sys.stderr)
        return 2

    model, device = load_model(args.model, args.device, args.threads)

    if args.check:
        audio = synthesize(model, "Проверка озвучки.", args.speaker, args.sample_rate)
        print(f"OK: device={device}, speaker={args.speaker}, samples={audio.size}")
        return 0

    cues = parse_vtt(args.input)
    if not cues:
        print("No subtitle cues with text found.", file=sys.stderr)
        return 2

    voiceover = mix_cues(cues, model, args.speaker, args.sample_rate, args.max_speed, args.volume)
    write_wav(args.output, voiceover, args.sample_rate)
    print(f"Saved voiceover: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
