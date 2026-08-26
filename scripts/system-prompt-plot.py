#!/usr/bin/env python3
# Regenerate the system-prompt footprint chart (interactive HTML + transparent SVG preview).
#   python scripts/system-prompt-plot.py
#
# Token counts and sources:
#   pi (base)         ~0.9k  measured — pi dist core/system-prompt.js (@earendil-works/pi-coding-agent)
#   pi + RA³          ~3.0k  measured — pi base + RA³ delta (scripts/prompt-footprint.mjs)
#   Claude Code       ~2.9k  https://codewithmukesh.com/blog/anatomy-claude-code-session/
#   Cursor           ~10.2k  https://weighmyprompt.com/system-prompts/cursor
#   Codex            ~13k    https://github.com/openai/codex/issues/19212
#   GitHub Copilot   ~20.5k  https://github.com/github/copilot-cli/issues/2627
import os
import plotly.graph_objects as go

entries = [
    ("pi (base)",         900,  "measured — pi dist base prompt",          "#9a9a9a"),
    ("pi + RA³",         2995,  "measured — pi base + RA³ (~2.1k delta)",  "#3f9b3f"),
    ("Claude Code",      2900,  "~2.9k base (public analysis)",             "#c05621"),
    ("Cursor",          10200,  "~10.2k full prompt (WeighMyPrompt)",       "#c05621"),
    ("Codex",           13000,  "~13k full prompt (user-reported)",         "#c05621"),
    ("GitHub Copilot",  20500,  "~20.5k full prompt (issue #2627)",         "#c05621"),
]

entries.sort(key=lambda e: e[1])
names  = [e[0] for e in entries]
vals   = [e[1] for e in entries]
notes  = [e[2] for e in entries]
colors = [e[3] for e in entries]

def fmt(n):
    return f"{n/1000:.1f}k".rstrip("0").rstrip(".") + ("k" if n >= 1000 else "") if n >= 1000 else str(n)

fig = go.Figure(go.Bar(
    x=names,
    y=vals,
    marker_color=colors,
    text=[fmt(v) for v in vals],
    textposition="outside",
    customdata=notes,
    hovertemplate="%{x}<br>%{y:,} tokens<br>%{customdata}<extra></extra>",
))

fig.update_layout(
    title=dict(text="token comparison across coding agent harnesses", x=0.01, xanchor="left", font=dict(size=15)),
    yaxis_title="approx tokens",
    xaxis=dict(tickfont=dict(size=12)),
    yaxis=dict(gridcolor="rgba(128,128,128,0.15)", zeroline=False),
    paper_bgcolor="rgba(0,0,0,0)",
    plot_bgcolor="rgba(0,0,0,0)",
    margin=dict(l=0, r=0, t=46, b=0),
    showlegend=False,
)

os.makedirs("docs", exist_ok=True)
fig.write_html(
    "docs/system-prompt-footprint.html",
    include_plotlyjs="cdn",
    full_html=True,
    config={"displaylogo": False, "responsive": True},
)
print("saved docs/system-prompt-footprint.html")

# Static transparent SVG preview for inline README display (needs kaleido).
try:
    fig.write_image("docs/system-prompt-footprint.svg", width=720, height=380)
    print("saved docs/system-prompt-footprint.svg")
except Exception as e:
    print(f"SVG preview skipped ({e.__class__.__name__}: {e})")
