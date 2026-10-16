#!/usr/bin/env python3
"""Generate a FULL dump PDF of everything the Soccer Flow bot reads:
- The 15 owner-authored KB entries (raw text, every character)
- The base business.json baked into the system prompt
"""
import json, urllib.request, os
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Preformatted, PageBreak,
)

OUTPUT = r"C:\Users\GalaxyBook3\Documents\Claude Code\SooceFlowUS\soccerflow-rag-full.pdf"
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://fkndtjpkrjtxftaawrxz.supabase.co")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not SERVICE_KEY:
    raise SystemExit("Set SUPABASE_SERVICE_ROLE_KEY in the environment (never hardcode it).")

NAVY   = colors.HexColor("#0A1B3F")
CORAL  = colors.HexColor("#E9522F")
INK    = colors.HexColor("#0B1120")
MUTE   = colors.HexColor("#6B7280")
PAPER  = colors.HexColor("#FBF7EF")

styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Heading1"], textColor=NAVY, fontSize=20, leading=24, spaceAfter=4, fontName="Helvetica-Bold")
H2 = ParagraphStyle("H2", parent=styles["Heading2"], textColor=NAVY, fontSize=13, leading=16, spaceBefore=14, spaceAfter=4, fontName="Helvetica-Bold")
CAT = ParagraphStyle("Cat", parent=styles["BodyText"], textColor=CORAL, fontSize=9, leading=11, spaceAfter=2, fontName="Helvetica-Bold")
META = ParagraphStyle("Meta", parent=styles["BodyText"], textColor=MUTE, fontSize=8, leading=11, spaceAfter=10, fontName="Helvetica")
BODY = ParagraphStyle("Body", parent=styles["BodyText"], textColor=INK, fontSize=9.5, leading=13, fontName="Helvetica")
MONO = ParagraphStyle("Mono", parent=styles["BodyText"], textColor=INK, fontSize=8, leading=10, fontName="Courier", leftIndent=4, rightIndent=4)
SUB = ParagraphStyle("Sub", parent=BODY, textColor=MUTE, fontSize=9, leading=12, spaceAfter=12)

CATEGORY_LABEL = {
    "business":  "BUSINESS FACT",
    "faq":       "FAQ",
    "style":     "SERVICE STYLE",
    "correction":"CORRECTION / HOW TO HANDLE",
}

def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTE)
    canvas.drawString(15*mm, 10*mm, "Soccer Flow — Full RAG Dump")
    canvas.drawRightString(195*mm, 10*mm, f"Page {doc.page}")
    canvas.restoreState()

def fetch_kb_entries():
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/kb_entries?select=id,category,text,created_at,source&order=created_at.asc",
        headers={"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))

def escape_para(text):
    """Convert raw text to Paragraph-safe HTML, preserving line breaks."""
    return (text
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\n", "<br/>")
            )

doc = SimpleDocTemplate(
    OUTPUT, pagesize=A4,
    leftMargin=15*mm, rightMargin=15*mm,
    topMargin=15*mm, bottomMargin=18*mm,
    title="Soccer Flow — Full RAG Dump",
    author="Soccer Flow",
)
story = []

# --- COVER / INTRO ---
story.append(Paragraph("Soccer Flow — Everything the bot reads", H1))
entries = fetch_kb_entries()
total_chars = sum(len(e["text"]) for e in entries)
by_cat = {}
for e in entries:
    by_cat[e["category"]] = by_cat.get(e["category"], 0) + 1
cat_line = ", ".join(f"{v} {k}" for k, v in sorted(by_cat.items()))
story.append(Paragraph(
    f"<b>{len(entries)} entries</b> owner-authored via <font face='Courier'>/admin</font>, "
    f"<b>{total_chars:,} chars</b> total, chunked into 262 vector-indexed pieces. "
    f"Breakdown: {cat_line}. Plus the base <font face='Courier'>business.json</font> file "
    f"below (always included in every prompt).", SUB))

# --- SECTION 1: KB ENTRIES (full raw text) ---
story.append(Paragraph("1 · Owner-authored KB entries (full text)", H2))
story.append(Paragraph(
    "Added through the <font face='Courier'>/admin</font> page. Policies "
    "(style + correction) are injected into every reply. Facts (business + faq) "
    "are retrieved by vector similarity against the customer's current message.",
    SUB))

for i, e in enumerate(entries, 1):
    story.append(Paragraph(f"Entry {i:02d} — {CATEGORY_LABEL.get(e['category'], e['category'].upper())}", CAT))
    story.append(Paragraph(
        f"id: <font face='Courier'>{e['id']}</font> · created {e['created_at'][:10]} · "
        f"source: {e.get('source', '-')} · {len(e['text']):,} chars",
        META))
    story.append(Paragraph(escape_para(e["text"]), BODY))
    story.append(Spacer(1, 10))

# --- SECTION 2: business.json ---
story.append(PageBreak())
story.append(Paragraph("2 · Base knowledge: business.json", H2))
story.append(Paragraph(
    "Baked into every system prompt as the primary source of truth. "
    "Owner-fed KB entries above refine and may override these base facts.",
    SUB))

bjson_path = os.path.join(
    os.path.dirname(__file__), "..", "supabase", "functions", "_shared", "business.json"
)
with open(bjson_path, encoding="utf-8") as f:
    bjson = f.read()

# Preformatted keeps formatting intact and wraps long lines.
story.append(Preformatted(bjson, MONO))

doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(f"Wrote {OUTPUT}")
print(f"  entries: {len(entries)}, total chars: {total_chars:,}")
