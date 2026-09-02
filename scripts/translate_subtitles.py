import argparse
import re
import sys
from pathlib import Path


TIMESTAMP_RE = re.compile(r"^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}")


def parse_args():
    parser = argparse.ArgumentParser(description="Translate WebVTT subtitle cues with Argos Translate.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--target", required=True)
    return parser.parse_args()


def translate_text(text, source_lang, target_lang):
    try:
        from argostranslate import translate
    except Exception as exc:
        raise RuntimeError(
            "Argos Translate is not installed. Install it with: pip install argostranslate"
        ) from exc

    return translate.translate(text, source_lang, target_lang)


def flush_cue(buffer, output, source_lang, target_lang):
    if not buffer:
        return

    cue_text = "\n".join(buffer).strip()
    if not cue_text:
        return

    translated = translate_text(cue_text, source_lang, target_lang)
    output.extend(translated.splitlines() or [translated])


def translate_vtt(input_path, output_path, source_lang, target_lang):
    lines = Path(input_path).read_text(encoding="utf-8-sig").splitlines()
    output = []
    cue_buffer = []
    in_cue_text = False

    for line in lines:
        stripped = line.strip()

        if not output and stripped != "WEBVTT":
            output.append("WEBVTT")
            output.append("")

        if stripped == "WEBVTT" or stripped.startswith("NOTE"):
            flush_cue(cue_buffer, output, source_lang, target_lang)
            cue_buffer = []
            in_cue_text = False
            output.append(line)
            continue

        if TIMESTAMP_RE.match(stripped):
            flush_cue(cue_buffer, output, source_lang, target_lang)
            cue_buffer = []
            in_cue_text = True
            output.append(line)
            continue

        if stripped == "":
            flush_cue(cue_buffer, output, source_lang, target_lang)
            cue_buffer = []
            in_cue_text = False
            output.append("")
            continue

        if in_cue_text:
            cue_buffer.append(line)
        else:
            output.append(line)

    flush_cue(cue_buffer, output, source_lang, target_lang)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(output_path).write_text("\n".join(output).strip() + "\n", encoding="utf-8")


def main():
    args = parse_args()
    try:
        translate_vtt(args.input, args.output, args.source, args.target)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
