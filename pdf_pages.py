import heapq
import json
import math
import os
import re
import sys
import unicodedata

import pypdfium2 as pdfium


def page_text(document, number):
    page = document[number - 1]
    try:
        text_page = page.get_textpage()
        try:
            return text_page.get_text_bounded().strip()
        finally:
            text_page.close()
    except pdfium.PdfiumError:
        return ""
    finally:
        page.close()


def write_inventory(document, output, numbers, **scope):
    # Keep complete text whenever it fits the model input budget. Extra excerpts
    # support quote verification when the model receives a PDF instead.
    budget = 160000
    pages = []
    clipped = []
    for number in numbers:
        text = page_text(document, number)
        keep = min(len(text), 2600 + budget)
        budget -= max(0, keep - 2600)
        pages.append(text[:keep])
        if keep < len(text):
            clipped.append(number)
    with open(output, "w", encoding="utf-8") as stream:
        json.dump({"count": len(document), "pages": pages, "clipped": clipped, **scope}, stream, ensure_ascii=False)


def inspect(document, source, output, mode, first, last):
    count = len(document)
    large_file = os.path.getsize(source) > 12 * 1024 * 1024
    if last:
        end = min(last, count)
    elif mode == "summary" and (count > 100 or large_file):
        end = min(32, count)
    elif mode == "extract" and (count > 44 or large_file):
        # The ranking pass reads the complete document once search terms are known.
        end = 0
    else:
        end = count
    write_inventory(document, output, range(first, end + 1))


def relevant_pages(document, groups):
    terms = list(dict.fromkeys(term for group in groups for term in group))
    if not terms:
        return []
    needles = [" " + term + " " for term in terms]
    hits = [0] * len(terms)
    matches = []
    for number in range(1, len(document) + 1):
        text = unicodedata.normalize("NFKC", page_text(document, number)).lower()
        text = " " + re.sub(r"[\W_]+", " ", text).strip() + " "
        mask = 0
        for index, needle in enumerate(needles):
            if needle in text:
                mask |= 1 << index
                hits[index] += 1
        if mask:
            matches.append((number, mask))
    if not matches:
        return []

    weights = {term: ((1 << index), (2 if " " in term else 1) * math.log1p(len(document) / max(1, hits[index])))
               for index, term in enumerate(terms)}
    ranks = []
    for group in groups:
        weighted = [weights[term] for term in group]
        scores = ((sum(weight for bit, weight in weighted if mask & bit), -number) for number, mask in matches)
        ranks.append([-number for score, number in heapq.nlargest(6, scores) if score > 0])

    selected = {}
    for position in range(6):
        for rank in ranks:
            if position < len(rank) and len(selected) < 20:
                selected[rank[position]] = True
    for number in list(selected):
        for neighbor in [number + 1, number - 1]:
            if len(selected) < 26 and 1 <= neighbor <= len(document):
                selected[neighbor] = True
    return sorted(selected)


def select_pages(document, output, groups):
    selected = relevant_pages(document, groups)
    kind = "targeted" if selected else "sample"
    if not selected:
        count = len(document)
        size = min(18, count)
        selected = [1 + round(i * (count - 1) / max(1, size - 1)) for i in range(size)]
    write_inventory(document, output, selected, selected=selected, kind=kind)


def slice_pages(document, output, selected):
    target = pdfium.PdfDocument.new()
    try:
        target.import_pages(document, pages=selected)
        target.save(output)
    finally:
        target.close()
    if os.path.getsize(output) <= 12 * 1024 * 1024:
        return
    images = []
    try:
        for index in selected:
            page = document[index]
            try:
                scale = min(2, 1550 / max(page.get_size()))
                bitmap = page.render(scale=scale, grayscale=True)
                try:
                    images.append(bitmap.to_pil().convert("L"))
                finally:
                    bitmap.close()
            finally:
                page.close()
        images[0].save(output, "PDF", save_all=True, append_images=images[1:], resolution=150, quality=78)
    finally:
        for image in images:
            image.close()


def render_page(document, output, number, metadata):
    with open(metadata, "w", encoding="utf-8") as stream:
        json.dump({"count": len(document)}, stream)
    if number > len(document):
        return
    page = document[number - 1]
    try:
        width, height = page.get_size()
        bitmap = page.render(scale=min(2.2, 1200 / width, 1720 / height))
        try:
            bitmap.to_pil().save(output, "PNG")
        finally:
            bitmap.close()
    finally:
        page.close()


def main():
    operation, source, output, *args = sys.argv[1:]
    document = pdfium.PdfDocument(source)
    try:
        if operation == "inspect":
            mode, first, last = args
            inspect(document, source, output, mode, int(first), int(last))
        elif operation == "select":
            select_pages(document, output, json.loads(args[0]))
        elif operation == "slice":
            slice_pages(document, output, [int(number) - 1 for number in args])
        elif operation == "render":
            render_page(document, output, int(args[0]), args[1])
        else:
            raise ValueError("Unsupported PDF operation")
    finally:
        document.close()


if __name__ == "__main__":
    main()
