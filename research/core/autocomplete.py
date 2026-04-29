"""YouTube/Google autocomplete để gợi ý long-tail keyword (không cần API key)."""
from __future__ import annotations

import string
import xml.etree.ElementTree as ET
from typing import Iterable

import requests

ENDPOINT = "https://suggestqueries.google.com/complete/search"


def suggest(seed: str, hl: str = "vi", gl: str = "VN") -> list[str]:
    """Trả về các gợi ý từ YouTube cho seed keyword."""
    params = {"client": "youtube", "ds": "yt", "q": seed, "hl": hl, "gl": gl}
    r = requests.get(ENDPOINT, params=params, timeout=10)
    r.raise_for_status()
    text = r.text.strip()
    # JSONP: window.google.ac.h([...]) hoặc XML toplevel
    start = text.find("[")
    end = text.rfind("]")
    if start >= 0 and end > start:
        try:
            import json

            data = json.loads(text[start : end + 1])
            return [item[0] if isinstance(item, list) else item for item in data[1]]
        except Exception:
            pass
    try:
        root = ET.fromstring(text)
        return [s.attrib["data"] for s in root.iter("suggestion")]
    except Exception:
        return []


def expand(seed: str, hl: str = "vi", gl: str = "VN", alphabet: Iterable[str] | None = None) -> list[str]:
    """Gọi autocomplete cho seed + ' a', seed + ' b'... để mở rộng long-tail."""
    out: list[str] = []
    seen: set[str] = set()
    for s in suggest(seed, hl=hl, gl=gl):
        if s not in seen:
            seen.add(s)
            out.append(s)
    letters = alphabet if alphabet is not None else list(string.ascii_lowercase)
    for ch in letters:
        for s in suggest(f"{seed} {ch}", hl=hl, gl=gl):
            if s not in seen:
                seen.add(s)
                out.append(s)
    return out
