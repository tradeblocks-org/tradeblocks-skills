#!/usr/bin/env python3
"""Render the three is-this-filter-real views from a result JSON as PNGs.

Optional helper for clients that cannot draw charts themselves.
Usage: python3 render_charts.py result.json OUTDIR
Needs only matplotlib. Reads the result object described in
references/result-schema.md and never computes statistics itself.
"""
import json
import os
import sys

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
except ImportError:
    sys.exit("matplotlib is not installed: pip install matplotlib (or show the views as tables)")

COLORS = {"lt": "#2a6fdb", "gt": "#d9822b", "best": "#c0392b", "centre": "#1e8449", "neutral": "#7f8c8d"}


def _money(v):
    return f"{v:,.0f}" if abs(v) >= 100 else f"{v:.3g}"


def _obj(r):
    """Risk purpose: plot the objective delta; edge purpose: P&L delta."""
    o = r.get("objective") or "totalPl"
    return (o, "objectiveDelta", f"Δ {o} vs covered baseline") if o != "totalPl" else (o, "delta", "Δ total P&L vs covered baseline ($)")


def _title(fig, r, view):
    fig.suptitle(f"{r['field']} on {r['block']}: {view}", fontsize=11, x=0.02, ha="left")


def threshold_curve(r, out):
    obj, key, ylabel = _obj(r)
    fig, ax = plt.subplots(figsize=(7, 4.2), dpi=160)
    region = set(r.get("region", {}).get("thresholds") or [])
    centre_dir = (r.get("centre") or {}).get("direction")
    for direction in ("lt", "gt"):
        pts = sorted((p for p in r["curve"] if p["direction"] == direction and p.get(key) is not None),
                     key=lambda p: p["threshold"])
        seen = set()
        pts = [p for p in pts if not (p["threshold"] in seen or seen.add(p["threshold"]))]
        if not pts:
            continue
        xs = [p["threshold"] for p in pts]
        ys = [p[key] for p in pts]
        label = "keep below threshold" if direction == "lt" else "keep above threshold"
        ax.plot(xs, ys, "-", color=COLORS[direction], lw=1.5, label=label)
        ax.scatter([p["threshold"] for p in pts if p["eligible"]], [p[key] for p in pts if p["eligible"]],
                   color=COLORS[direction], s=18, zorder=3)
        ax.scatter([p["threshold"] for p in pts if not p["eligible"]], [p[key] for p in pts if not p["eligible"]],
                   facecolors="none", edgecolors=COLORS[direction], s=18, zorder=3)
        if direction == centre_dir and region:
            rx = [x for x in xs if x in region]
            if rx:
                ax.axvspan(min(rx), max(rx) if max(rx) > min(rx) else min(rx) + 1e-9, color=COLORS["centre"], alpha=0.12, lw=0)
    for key in ("best", "centre"):
        c = r.get(key)
        if c:
            ax.axvline(c["threshold"], color=COLORS[key], ls="--", lw=1, label=f"{key} {c['threshold']:.3g} ({c['direction']})")
    ax.axhline(0, color=COLORS["neutral"], lw=0.8)
    ax.set_xlabel("threshold")
    ax.set_ylabel(ylabel)
    ax.legend(fontsize=7, frameon=False)
    ax.text(0.01, 0.01, "hollow = not eligible (kept < {:.0%} or too few removed days)".format(r["rule"]["minKeptFraction"]),
            transform=ax.transAxes, fontsize=7, color=COLORS["neutral"])
    sig = r.get("significance") or {}
    p = sig.get("pValueHolm") if len(sig.get("family") or []) > 1 else sig.get("pValue")
    if p is not None:
        obj = sig.get("objective") or "totalPl"
        ax.text(0.99, 0.98, f"selection-adjusted p ({obj}) = {p:.3g}" + (" (Holm)" if len(sig.get("family") or []) > 1 else ""),
                transform=ax.transAxes, ha="right", va="top", fontsize=8)
    _title(fig, r, "threshold curve")
    fig.tight_layout()
    fig.savefig(os.path.join(out, "1_threshold_curve.png"))
    plt.close(fig)


def per_year(r, out):
    years = r.get("years") or []
    if not years:
        return
    fig, ax = plt.subplots(figsize=(7, 4), dpi=160)
    xs = list(range(len(years)))
    w = 0.38
    obj = r.get("objective") or "totalPl"
    if obj != "totalPl" and any(y.get("objectiveDeltaCentre") is not None for y in years):
        ax.bar(xs, [y.get("objectiveDeltaCentre") or 0 for y in years], w, color=COLORS["centre"], label="centre")
        ylabel = f"Δ {obj}"
    else:
        best = [y.get("deltaBest") for y in years]
        if any(v is not None for v in best):
            ax.bar([x - w / 2 for x in xs], [v or 0 for v in best], w, color=COLORS["neutral"], label="best")
        ax.bar([x + w / 2 for x in xs], [y.get("deltaCentre") or 0 for y in years], w, color=COLORS["centre"], label="centre")
        ylabel = "Δ total P&L ($)"
    ax.set_xticks(xs, [f"{y['year']}\n(n={y['covered']})" for y in years], fontsize=8)
    ax.axhline(0, color=COLORS["neutral"], lw=0.8)
    ax.set_ylabel(ylabel)
    ax.legend(fontsize=8, frameon=False)
    _title(fig, r, "per year")
    fig.tight_layout()
    fig.savefig(os.path.join(out, "2_per_year.png"))
    plt.close(fig)


def _hbars(ax, bars, xlabel):
    ys = list(range(len(bars)))[::-1]
    vals = [v for _, v in bars]
    ax.barh(ys, vals, color=[COLORS["centre"] if v > 0 else COLORS["best"] for v in vals])
    ax.set_yticks(ys, [k for k, _ in bars], fontsize=8)
    for y, v in zip(ys, vals):
        ax.text(v, y, " " + _money(v) + " ", va="center", ha="left" if v >= 0 else "right", fontsize=7)
    ax.axvline(0, color=COLORS["neutral"], lw=0.8)
    ax.margins(x=0.25)
    ax.set_xlabel(xlabel, fontsize=8)


def robustness(r, out):
    obj = r.get("objective") or "totalPl"
    risk = obj != "totalPl"
    totals = []
    if risk:
        cd = (r.get("centre") or {}).get("objectiveDelta")
        totals.append(("full history", cd))
        for d in r.get("singleDay") or []:
            w = d.get("objectiveDeltaWithout") or {}
            for part in ("before", "after"):
                if isinstance(w, dict) and w.get(part) is not None:
                    totals.append((f"{part} {d['date']}", w[part]))
        totals_label = f"Δ {obj}, centre threshold"
    else:
        totals.append(("full history", (r.get("centre") or {}).get("delta")))
        for d in r.get("singleDay") or []:
            totals.append((f"without {d['date']}", d.get("deltaWithout")))
        totals_label = "Δ total P&L, centre threshold ($)"
    totals = [(k, v) for k, v in totals if v is not None]
    oos = r.get("oos") or {}
    halves = [(k, oos.get(f)) for k, f in (("1st half (chosen here)", "isDeltaPerKept"),
                                           ("2nd half (fixed threshold)", "oosDeltaPerKept"))]
    halves = [(k, v) for k, v in halves if v is not None]
    halves_label = "Δ per kept trade ($)"
    if risk or not halves:  # risk purpose: objective change on the second half only (P&L cost is in the verdict)
        v = oos.get("oosObjectiveDelta")
        halves = [("2nd half (fixed threshold)", v)] if v is not None else []
        halves_label = f"Δ {obj}, 2nd half"
    if not totals and not halves:
        return
    panels = [p for p in ((totals, totals_label), (halves, halves_label)) if p[0]]
    fig, axes = plt.subplots(1, len(panels), figsize=(7.5, 3.4), dpi=160, squeeze=False)
    for ax, (bars, label) in zip(axes[0], panels):
        _hbars(ax, bars, label)
    if halves and oos.get("isThreshold") is not None:
        axes[0][-1].set_title(f"split {oos.get('split')}, threshold {oos['isThreshold']:.3g} "
                              f"({oos.get('isDirection', '')})", fontsize=8)
    _title(fig, r, "robustness")
    fig.tight_layout()
    fig.savefig(os.path.join(out, "3_robustness.png"))
    plt.close(fig)


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    with open(sys.argv[1]) as f:
        r = json.load(f)
    os.makedirs(sys.argv[2], exist_ok=True)
    threshold_curve(r, sys.argv[2])
    per_year(r, sys.argv[2])
    robustness(r, sys.argv[2])
    print("\n".join(sorted(p for p in os.listdir(sys.argv[2]) if p.endswith(".png"))))


if __name__ == "__main__":
    main()
