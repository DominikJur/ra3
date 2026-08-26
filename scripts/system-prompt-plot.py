#!/usr/bin/env python3
# Regenerate the system-prompt footprint chart (interactive HTML + transparent SVG preview).
#   python scripts/system-prompt-plot.py
#
# Metric: FULL system prompt = prompt text + tool definitions, approximate tokens.
#   pi (full)          ~2.5k  base + built-in tools (estimated)
#   pi + RA³ (full)    ~4.6k  measured (pi full + RA³ delta ~2.1k, scripts/prompt-footprint.mjs)
#   Cursor             ~10.2k  https://weighmyprompt.com/system-prompts/cursor
#   Codex              ~13k    https://github.com/openai/codex/issues/19212
#   Claude Code        ~18k    ~2.5k prompt + 14-17k tools: https://www.claudecodecamp.com/p/inside-claude-code-s-system-prompt
#   GitHub Copilot     ~20.5k  https://github.com/github/copilot-cli/issues/2627
import os
import plotly.graph_objects as go

LIGHT_BLUE = "#6fb3e0"
LIGHT_RED = "#ef9a9a"

entries = [
    ("pi (full)",              2500,  "≈ base + built-in tools (est.)",                    LIGHT_BLUE),
    ("pi + RA³ (full)",        4600,  "measured (+~2.1k RA³ tools/skills/policy)",          LIGHT_BLUE),
    ("Cursor (full)",         10200,  "~10.2k (WeighMyPrompt)",                             LIGHT_RED),
    ("Codex (full)",          13000,  "~13k (openai/codex issue)",                          LIGHT_RED),
    ("Claude Code (full)",    18000,  "~2.5k prompt + 14-17k tools (claudecodecamp)",       LIGHT_RED),
    ("GitHub Copilot (full)", 20500,  "~20.5k (copilot-cli issue)",                         LIGHT_RED),
]

entries.sort(key=lambda e: e[1])
names  = [e[0] for e in entries]
vals   = [e[1] for e in entries]
notes  = [e[2] for e in entries]
colors = [e[3] for e in entries]

def fmt(n):
    return f"{n/1000:.1f}k" if n >= 1000 else str(n)

fig = go.Figure(go.Bar(
    x=names,
    y=vals,
    marker=dict(color=colors, line=dict(color="white", width=1.5)),
    text=[fmt(v) for v in vals],
    textposition="outside",
    textfont=dict(color="white", size=12),
    customdata=notes,
    hovertemplate="%{x}<br>%{y:,} tokens<br>%{customdata}<extra></extra>",
))

fig.update_layout(
    title=dict(text="token comparison across coding agent harnesses", x=0.01, xanchor="left",
               font=dict(size=15, color="white")),
    yaxis_title="approx tokens",
    xaxis=dict(tickfont=dict(size=12, color="white"), linecolor="white"),
    yaxis=dict(gridcolor="rgba(255,255,255,0.15)", zeroline=False,
               tickfont=dict(color="white"), title_font=dict(color="white")),
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

try:
    fig.write_image("docs/system-prompt-footprint.svg", width=760, height=400)
    print("saved docs/system-prompt-footprint.svg")
except Exception as e:
    print(f"SVG preview skipped ({e.__class__.__name__}: {e})")
