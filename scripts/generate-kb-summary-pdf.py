#!/usr/bin/env python3
"""Generate a one-page PDF summary of the Soccer Flow RAG knowledge base."""
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether
)
from reportlab.lib.enums import TA_LEFT

OUTPUT = r"C:\Users\GalaxyBook3\Documents\Claude Code\SooceFlowUS\soccerflow-rag-summary.pdf"

NAVY   = colors.HexColor("#0A1B3F")
CORAL  = colors.HexColor("#E9522F")
GRASS  = colors.HexColor("#2E9B3D")
WAVE   = colors.HexColor("#3BAEE8")
INK    = colors.HexColor("#0B1120")
MUTE   = colors.HexColor("#6B7280")
PAPER  = colors.HexColor("#FBF7EF")
LINE   = colors.HexColor("#D4D4D8")

styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Heading1"], textColor=NAVY, fontSize=22, leading=26, spaceBefore=0, spaceAfter=6, fontName="Helvetica-Bold")
H2 = ParagraphStyle("H2", parent=styles["Heading2"], textColor=NAVY, fontSize=13, leading=16, spaceBefore=14, spaceAfter=6, fontName="Helvetica-Bold")
H3 = ParagraphStyle("H3", parent=styles["Heading3"], textColor=CORAL, fontSize=10, leading=12, spaceBefore=8, spaceAfter=3, fontName="Helvetica-Bold")
BODY = ParagraphStyle("Body", parent=styles["BodyText"], textColor=INK, fontSize=9.5, leading=13, spaceAfter=4, fontName="Helvetica")
BULLET = ParagraphStyle("Bullet", parent=BODY, leftIndent=12, bulletIndent=0, spaceAfter=2)
SUB = ParagraphStyle("Sub", parent=BODY, textColor=MUTE, fontSize=8.5, leading=11)
TITLE_SUB = ParagraphStyle("TitleSub", parent=BODY, textColor=MUTE, fontSize=10, leading=13, spaceAfter=14)

def table(data, col_widths, header=True):
    t = Table(data, colWidths=col_widths, repeatRows=1 if header else 0)
    style = TableStyle([
        ("FONT", (0,0), (-1,-1), "Helvetica", 9),
        ("TEXTCOLOR", (0,0), (-1,-1), INK),
        ("ROWBACKGROUNDS", (0,1 if header else 0), (-1,-1), [PAPER, colors.white]),
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("LEFTPADDING", (0,0), (-1,-1), 6),
        ("RIGHTPADDING", (0,0), (-1,-1), 6),
        ("TOPPADDING", (0,0), (-1,-1), 5),
        ("BOTTOMPADDING", (0,0), (-1,-1), 5),
        ("LINEBELOW", (0,0), (-1,0), 1, NAVY),
        ("LINEBELOW", (0,-1), (-1,-1), 0.5, LINE),
    ])
    if header:
        style.add("FONT", (0,0), (-1,0), "Helvetica-Bold", 9)
        style.add("TEXTCOLOR", (0,0), (-1,0), NAVY)
    t.setStyle(style)
    return t

def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTE)
    canvas.drawString(15*mm, 10*mm, "Soccer Flow — RAG Knowledge Base Summary")
    canvas.drawRightString(195*mm, 10*mm, f"Page {doc.page}")
    canvas.restoreState()

doc = SimpleDocTemplate(
    OUTPUT, pagesize=A4,
    leftMargin=15*mm, rightMargin=15*mm,
    topMargin=15*mm, bottomMargin=18*mm,
    title="Soccer Flow RAG Summary",
    author="Soccer Flow",
)

story = []
story.append(Paragraph("Soccer Flow — RAG Knowledge Base", H1))
story.append(Paragraph("What the AI knows + the rules it must follow.  15 entries · ~88K chars · 262 chunks indexed.", TITLE_SUB))

# --- BUSINESS FACTS ---
story.append(Paragraph("Business facts", H2))
story.append(table([
    ["Location", "Liberty Station, San Diego"],
    ["Google Maps Pin", "https://maps.app.goo.gl/nM7BdK1kGnrPzB4F6"],
    ["Coordinates", "32.7329790, -117.2143550"],
    ["Instagram", "@soccerflowus"],
    ["Languages", "English, Spanish, Portuguese"],
], [45*mm, 135*mm]))

# --- PROGRAMAS & HORARIOS ---
story.append(Paragraph("Programs &amp; schedule", H2))
story.append(table([
    ["Program", "Ages", "Saturday", "Monday", "Duration"],
    ["Explorers", "2–3",  "9:00 AM",  "4:00 PM", "~45 min"],
    ["Juniors",   "4–6",  "10:00 AM", "5:00 PM", "~60 min"],
    ["Academy",   "7–11", "11:00 AM", "5:00 PM", "~60 min"],
], [32*mm, 20*mm, 35*mm, 35*mm, 28*mm]))
story.append(Paragraph("<b>Age flexibility:</b> near-2 and 12-year-olds accepted under evaluation. "
                       "<b>Class format:</b> training + games (1v1, 2v2, 4v4, 5v5).", SUB))

# --- PRICING & LINKS ---
story.append(Paragraph("Pricing &amp; official enrollment links", H2))
story.append(table([
    ["Plan", "Price", "Plan ID"],
    ["Once a Week (1st child)", "$87/month", "plan_58ea8568242142"],
    ["Unlimited (1st child)",   "$97/month", "plan_228b73dcc53a4e"],
    ["Sibling Once a Week",     "$67/month", "plan_ef071b08101d47"],
    ["Sibling Unlimited",       "$77/month", "plan_c4f5a02c097745"],
], [55*mm, 30*mm, 90*mm]))
story.append(Paragraph("Base URL: <font name='Helvetica-Oblique'>https://soccerflow.pushpress.com/landing/plans/&lt;plan_id&gt;</font>", SUB))
story.append(Spacer(1, 4))
story.append(Paragraph("<b>Free Trial:</b> first class free, no commitment. "
                       "<b>T-shirt:</b> included with enrollment (NOT with trial). "
                       "<b>Cancellation:</b> 30-day notice.", SUB))

# --- FREE TRIAL BOOKING ---
story.append(Paragraph("Free trial — required fields to confirm booking", H2))
for line in [
    "1. Child's name",
    "2. Child's age",
    "3. Chosen day (Monday or Saturday)",
    "4. Clear parent/guardian confirmation",
]:
    story.append(Paragraph("• " + line, BULLET))
story.append(Paragraph("Time is auto-derived from the child's age — never ask separately.", SUB))

# --- STYLE RULES ---
story.append(Paragraph("Style rules (always apply)", H2))

story.append(Paragraph("Do", H3))
for line in [
    "Act like a real person — warm, professional, concise, WhatsApp-style",
    "Short natural messages",
    "Answer the question first, then guide the conversation",
    "One question per message",
    "Match the customer's language (EN / ES / PT)",
]:
    story.append(Paragraph("✓ " + line, BULLET))

story.append(Paragraph("Never", H3))
for line in [
    "Use the em-dash <b>—</b>",
    "Use the soccer-ball emoji ⚽",
    "Re-ask info already given (name, age, day, language…)",
    "Invent price / schedule / location / date / discount",
    "Say \"our team will contact you\" automatically",
    "Close prematurely (\"have a great day\") when there's an opening to keep helping",
    "Pressure the customer or use false urgency",
    "Promise competitive-team placement before the trial",
    "Promise a specific new location / opening date",
    "Offer sibling discount proactively",
    "Tell customer to \"look for Felipe\" on arrival",
    "Generate, modify or shorten the Google Maps link or any of the 4 enrollment links",
]:
    story.append(Paragraph("✗ " + line, BULLET))

# --- CRITICAL OVERRIDES ---
story.append(Paragraph("Critical overrides (corrections — win over everything)", H2))
story.append(table([
    ["Trigger", "Required behavior"],
    ["Customer asks about location", "ALWAYS send \"Liberty Station\" + the full Google Maps link"],
    ["Customer says \"too far\"", "Acknowledge, ask neighborhood (if unknown), explain expansion, invite to one trial"],
    ["Trial already scheduled", "NEVER offer another"],
    ["Customer asks for enrollment", "Present the 2 options (1x/wk vs Unlimited) BEFORE sending any link"],
    ["Family with 2+ kids", "1st child = standard price, others = sibling price"],
    ["\"I need to talk to my husband/wife\"", "Give space, don't push for scheduling"],
    ["Rain / bad weather", "NEVER assume cancellation — wait for owner's call"],
    ["Holiday", "NEVER assume class is on — confirm first"],
], [60*mm, 120*mm]))

# --- FAQ topics ---
story.append(Paragraph("FAQ topics covered (29 Q&amp;A pairs indexed)", H2))
faqs = [
    "What is Soccer Flow",      "Pricing / monthly cost",   "Location / Google Maps",
    "Days & times",             "Beginner / no experience", "What to bring (cleats optional)",
    "Spanish-speaking coaches", "What happens during class","Games / leagues / competitive",
    "Liberty Station too far",  "Trial is free",            "T-shirt included",
    "Almost-2 or 12 y/o",       "Pick Mon/Sat with 1x/wk",  "Special equipment",
    "Bad weather",              "Holidays",                 "Cancel membership (30-day)",
    "Agreement / contract",     "Where to enroll",          "Who to find on arrival",
    "Reschedule trial",         "Sibling discount",         "Family plan",
    "Financial assistance",     "Class length",             "Parents stay/watch",
    "What's included",          "How payment works",
]
# render as 3-column table
rows = [faqs[i:i+3] for i in range(0, len(faqs), 3)]
story.append(table(rows, [60*mm, 60*mm, 60*mm], header=False))

doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(f"Wrote {OUTPUT}")
