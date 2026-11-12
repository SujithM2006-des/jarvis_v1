"""Create Word, Excel and PowerPoint files for JARVIS (bridge/skills.mjs).

    python office_create.py SPEC.json   -> writes the file named in the spec, prints its path

SPEC: {"kind": "pptx"|"xlsx"|"docx", "path": "...", ...}
  pptx: {"title": "...", "subtitle": "...", "slides": [{"title": "...", "bullets": [...], "notes": "..."}]}
  xlsx: {"sheets": [{"name": "...", "rows": [[...], ...]}]}   first row is the header
  docx: {"title": "...", "blocks": [{"type": "heading"|"paragraph"|"bullets"|"numbered", "text": "...", "items": [...]}]}
"""

import json
import sys
from pathlib import Path


def pptx(spec):
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.util import Inches, Pt

    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)  # 16:9
    accent = RGBColor(0x1F, 0x7F, 0xD6)

    s = prs.slides.add_slide(prs.slide_layouts[0])
    s.shapes.title.text = spec.get("title", "Presentation")
    if len(s.placeholders) > 1:
        s.placeholders[1].text = spec.get("subtitle", "")
    s.shapes.title.text_frame.paragraphs[0].runs[0].font.color.rgb = accent

    for sl in spec.get("slides", []):
        slide = prs.slides.add_slide(prs.slide_layouts[1])
        slide.shapes.title.text = sl.get("title", "")
        slide.shapes.title.text_frame.paragraphs[0].runs[0].font.color.rgb = accent
        body = slide.placeholders[1].text_frame
        body.clear()
        for i, b in enumerate(sl.get("bullets", [])):
            p = body.paragraphs[0] if i == 0 else body.add_paragraph()
            p.text = str(b)
            p.font.size = Pt(22)
        if sl.get("notes"):
            slide.notes_slide.notes_text_frame.text = sl["notes"]
    prs.save(spec["path"])


def xlsx(spec):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    wb.remove(wb.active)
    for sh in spec.get("sheets", []) or [{"name": "Sheet1", "rows": []}]:
        ws = wb.create_sheet(str(sh.get("name", "Sheet"))[:31])
        for r in sh.get("rows", []):
            ws.append(r)
        if ws.max_row >= 1:
            for c in ws[1]:
                c.font = Font(bold=True, color="FFFFFF")
                c.fill = PatternFill("solid", fgColor="1F7FD6")
            ws.freeze_panes = "A2"
        for col in range(1, ws.max_column + 1):
            width = max((len(str(ws.cell(row=r, column=col).value or "")) for r in range(1, ws.max_row + 1)), default=8)
            ws.column_dimensions[get_column_letter(col)].width = min(60, max(8, width + 2))
    wb.save(spec["path"])


def docx(spec):
    from docx import Document

    doc = Document()
    if spec.get("title"):
        doc.add_heading(spec["title"], 0)
    for b in spec.get("blocks", []):
        t = b.get("type", "paragraph")
        if t == "heading":
            doc.add_heading(b.get("text", ""), int(b.get("level", 1)))
        elif t in ("bullets", "numbered"):
            style = "List Bullet" if t == "bullets" else "List Number"
            for item in b.get("items", []):
                doc.add_paragraph(str(item), style=style)
        else:
            doc.add_paragraph(b.get("text", ""))
    doc.save(spec["path"])


def main():
    spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
    {"pptx": pptx, "xlsx": xlsx, "docx": docx}[spec["kind"]](spec)
    sys.stdout.reconfigure(encoding="utf-8")
    print(spec["path"])


if __name__ == "__main__":
    main()
