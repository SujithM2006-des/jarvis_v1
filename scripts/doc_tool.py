"""Read and edit Word, Excel and PowerPoint files for JARVIS (bridge/documents.mjs).

Runs in the wake listener's environment (%USERPROFILE%\\.jarvis\\wake-venv),
with python-docx, openpyxl and python-pptx — no Microsoft Office needed.

    python doc_tool.py read FILE            -> the document as text, on stdout
    python doc_tool.py edit FILE OPS.json   -> applies the edits, prints a JSON summary

Edits (a JSON list):
    {"op": "replace", "find": "...", "replace": "...", "all": true}      docx, pptx, xlsx
    {"op": "append", "text": "...", "style": "Heading 2"}                docx (style optional)
    {"op": "delete_paragraph", "find": "..."}                           docx
    {"op": "set_cell", "sheet": "Sheet1", "cell": "B4", "value": "..."}  xlsx

Formatting is kept: a replacement inside one run keeps that run's look; one
spanning runs rewrites the paragraph in its first run's style.
The bridge backs the file up before calling edit.
"""

import json
import sys
from pathlib import Path


def out(text):
    sys.stdout.reconfigure(encoding="utf-8")
    print(text)


# ---------------------------------------------------------------- reading

def read_docx(path):
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(path)
    lines = []
    for block in doc.element.body.iterchildren():
        tag = block.tag.split("}")[-1]
        if tag == "p":
            p = Paragraph(block, doc)
            text = p.text.strip()
            if not text:
                continue
            style = (p.style.name if p.style is not None else "") or ""
            if style.lower().startswith("heading") or style.lower() == "title":
                level = "".join(c for c in style if c.isdigit()) or "1"
                lines.append(f"{'#' * min(int(level), 4)} {text}")
            elif "list" in style.lower():
                lines.append(f"- {text}")
            else:
                lines.append(text)
        elif tag == "tbl":
            t = Table(block, doc)
            lines.append("[table]")
            for row in t.rows:
                lines.append(" | ".join(c.text.strip().replace("\n", " ") for c in row.cells))
            lines.append("[/table]")
    return "\n".join(lines)


def read_xlsx(path):
    from openpyxl import load_workbook

    wb = load_workbook(path, data_only=True, read_only=True)
    lines = []
    for ws in wb.worksheets:
        lines.append(f"=== Sheet: {ws.title} ===")
        count = 0
        for row in ws.iter_rows():
            cells = [(c.coordinate, c.value) for c in row if c.value is not None and str(c.value).strip() != ""]
            if not cells:
                continue
            lines.append("  ".join(f"{coord}={val}" for coord, val in cells))
            count += len(cells)
            if count > 4000:
                lines.append("… (sheet truncated)")
                break
    return "\n".join(lines)


def read_pptx(path):
    from pptx import Presentation

    prs = Presentation(path)
    lines = []
    for n, slide in enumerate(prs.slides, 1):
        lines.append(f"=== Slide {n} ===")
        for shape in slide.shapes:
            if shape.has_text_frame:
                for p in shape.text_frame.paragraphs:
                    t = "".join(r.text for r in p.runs).strip()
                    if t:
                        lines.append(t)
            if getattr(shape, "has_table", False) and shape.has_table:
                for row in shape.table.rows:
                    lines.append(" | ".join(c.text.strip() for c in row.cells))
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame.text.strip():
            lines.append(f"[notes] {slide.notes_slide.notes_text_frame.text.strip()}")
    return "\n".join(lines)


# ---------------------------------------------------------------- editing

def replace_in_paragraph(p, find, repl, everywhere):
    """Replace in a python-docx / python-pptx paragraph, keeping formatting."""
    runs = list(p.runs)
    if not runs or find not in "".join(r.text for r in runs):
        return 0
    n = 0
    for r in runs:  # inside one run: that run keeps its look
        if find in r.text:
            k = r.text.count(find) if everywhere else 1
            r.text = r.text.replace(find, repl) if everywhere else r.text.replace(find, repl, 1)
            n += k
            if not everywhere:
                return n
    if n:
        # Done within runs. Checking the joined text now would find the
        # find-string inside its own replacement ("X" -> "X Pro" -> "X Pro Pro").
        return n
    full = "".join(r.text for r in runs)
    if find in full:  # only across runs: rewrite in the first run's style
        k = full.count(find) if everywhere else 1
        runs[0].text = full.replace(find, repl) if everywhere else full.replace(find, repl, 1)
        for r in runs[1:]:
            r.text = ""
        n += k
    return n


def docx_paragraphs(doc):
    for p in doc.paragraphs:
        yield p
    for t in doc.tables:
        for row in t.rows:
            for cell in row.cells:
                yield from cell.paragraphs
    for s in doc.sections:
        for part in (s.header, s.footer):
            yield from part.paragraphs


def edit_docx(path, ops):
    from docx import Document

    doc = Document(path)
    changes, notes = 0, []
    for op in ops:
        kind = op.get("op")
        if kind == "replace":
            n = 0
            for p in docx_paragraphs(doc):
                n += replace_in_paragraph(p, op["find"], op.get("replace", ""), op.get("all", True))
                if n and not op.get("all", True):
                    break
            changes += n
            if not n:
                notes.append(f'not found: "{op["find"][:60]}"')
        elif kind == "append":
            style = op.get("style")
            try:
                if style:
                    doc.add_paragraph(op.get("text", ""), style=style)
                else:
                    doc.add_paragraph(op.get("text", ""))
            except KeyError:
                doc.add_paragraph(op.get("text", ""))
                notes.append(f'style "{style}" not in this document; added as normal text')
            changes += 1
        elif kind == "delete_paragraph":
            hit = [p for p in doc.paragraphs if op["find"] in p.text]
            for p in hit:
                p._element.getparent().remove(p._element)
            changes += len(hit)
            if not hit:
                notes.append(f'no paragraph contains "{op["find"][:60]}"')
        else:
            notes.append(f"{kind}: not supported for Word documents")
    doc.save(path)
    return changes, notes


def edit_pptx(path, ops):
    from pptx import Presentation

    prs = Presentation(path)
    changes, notes = 0, []
    for op in ops:
        if op.get("op") != "replace":
            notes.append(f'{op.get("op")}: only "replace" is supported for PowerPoint')
            continue
        n = 0
        for slide in prs.slides:
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for p in shape.text_frame.paragraphs:
                        n += replace_in_paragraph(p, op["find"], op.get("replace", ""), op.get("all", True))
        changes += n
        if not n:
            notes.append(f'not found: "{op["find"][:60]}"')
    prs.save(path)
    return changes, notes


def edit_xlsx(path, ops):
    from openpyxl import load_workbook

    wb = load_workbook(path)  # formulas kept as formulas
    changes, notes = 0, []
    for op in ops:
        kind = op.get("op")
        if kind == "set_cell":
            ws = wb[op["sheet"]] if op.get("sheet") in wb.sheetnames else wb.active
            value = op.get("value")
            if isinstance(value, str):
                try:
                    value = float(value) if "." in value else int(value)
                except ValueError:
                    pass
            ws[op["cell"]] = value
            changes += 1
        elif kind == "replace":
            n = 0
            for ws in wb.worksheets:
                for row in ws.iter_rows():
                    for c in row:
                        if isinstance(c.value, str) and op["find"] in c.value:
                            c.value = c.value.replace(op["find"], op.get("replace", ""))
                            n += 1
            changes += n
            if not n:
                notes.append(f'not found: "{op["find"][:60]}"')
        else:
            notes.append(f"{kind}: not supported for Excel")
    wb.save(path)
    return changes, notes


def main():
    action, path = sys.argv[1], sys.argv[2]
    ext = Path(path).suffix.lower()
    if action == "read":
        reader = {".docx": read_docx, ".xlsx": read_xlsx, ".xlsm": read_xlsx, ".pptx": read_pptx}.get(ext)
        if not reader:
            sys.exit(f"{ext} is not a Word, Excel or PowerPoint file")
        out(reader(path))
    elif action == "edit":
        ops = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8-sig"))  # with or without a BOM
        editor = {".docx": edit_docx, ".xlsx": edit_xlsx, ".xlsm": edit_xlsx, ".pptx": edit_pptx}.get(ext)
        if not editor:
            sys.exit(f"{ext} is not a Word, Excel or PowerPoint file")
        changes, notes = editor(path, ops)
        out(json.dumps({"changes": changes, "notes": notes}))
    else:
        sys.exit("usage: doc_tool.py read|edit FILE [OPS.json]")


if __name__ == "__main__":
    try:
        main()
    except PermissionError:
        sys.exit("The file is open in another program (close it in Word/Excel/PowerPoint first).")
