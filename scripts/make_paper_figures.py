#!/usr/bin/env python3
"""Generate the three paper figures used by the v1.1 review draft."""

from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "Docs" / "ablation" / "figures"
OUT.mkdir(parents=True, exist_ok=True)

plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei"]
plt.rcParams["axes.unicode_minus"] = False
plt.rcParams["figure.dpi"] = 120
plt.rcParams["savefig.dpi"] = 300

INK = "#1f2937"
MUTED = "#6b7280"
BLUE = "#356a9a"
TEAL = "#2f7d79"
ORANGE = "#c27a35"
RED = "#a94d4d"
LIGHT = "#f6f7f9"
LINE = "#d6dae0"


def box(ax, xy, text, width, height, color, fontsize=11):
    x, y = xy
    patch = FancyBboxPatch(
        (x, y),
        width,
        height,
        boxstyle="round,pad=0.02,rounding_size=0.08",
        linewidth=1.2,
        edgecolor=color,
        facecolor=color + "14",
    )
    ax.add_patch(patch)
    ax.text(
        x + width / 2,
        y + height / 2,
        text,
        ha="center",
        va="center",
        color=INK,
        fontsize=fontsize,
        linespacing=1.35,
    )


def arrow(ax, start, end, color=INK, rad=0.0):
    ax.add_patch(
        FancyArrowPatch(
            start,
            end,
            arrowstyle="-|>",
            mutation_scale=14,
            linewidth=1.3,
            color=color,
            connectionstyle=f"arc3,rad={rad}",
        )
    )


def figure_pipeline():
    fig, ax = plt.subplots(figsize=(12, 6.2))
    ax.set_xlim(0, 12)
    ax.set_ylim(0, 6.2)
    ax.axis("off")

    box(ax, (0.25, 2.3), "续写请求\nstory / branch / 当前段", 1.85, 1.25, BLUE, 10.5)
    box(ax, (2.55, 3.65), "叙事状态表\n按 branchId 取键", 2.0, 0.9, TEAL, 10)
    box(ax, (2.55, 2.5), "分叉感知知识图谱\n节点与边按 branchId 过滤", 2.0, 0.9, TEAL, 10)
    box(ax, (2.55, 1.35), "分支记忆\n公共前文 + 平行分支摘要", 2.0, 0.9, TEAL, 10)
    box(ax, (5.2, 2.3), "Prompt 组装\n动态 token 预算", 1.75, 1.25, ORANGE, 10.5)
    box(ax, (7.55, 2.3), "基础模型续写", 1.55, 1.25, BLUE, 10.5)
    box(ax, (9.7, 2.3), "记忆回写\n抽取状态与关系", 1.75, 1.25, TEAL, 10.5)

    arrow(ax, (2.1, 2.92), (2.55, 4.1))
    arrow(ax, (2.1, 2.92), (2.55, 2.95))
    arrow(ax, (2.1, 2.92), (2.55, 1.8))
    arrow(ax, (4.55, 4.1), (5.2, 3.25))
    arrow(ax, (4.55, 2.95), (5.2, 2.95))
    arrow(ax, (4.55, 1.8), (5.2, 2.65))
    arrow(ax, (6.95, 2.92), (7.55, 2.92))
    arrow(ax, (9.1, 2.92), (9.7, 2.92))
    arrow(ax, (10.55, 3.55), (10.55, 4.55), TEAL)
    arrow(ax, (10.15, 4.55), (3.55, 4.55), TEAL)
    arrow(ax, (3.55, 4.55), (3.55, 4.1), TEAL)
    ax.text(6.95, 4.72, "写入打标，读出过滤；新段落继续回写当前分支", ha="center", fontsize=10, color=TEAL)

    ax.text(0.25, 5.55, "图 1  分支感知记忆参考管线", fontsize=15, fontweight="bold", color=INK)
    ax.text(
        0.25,
        0.45,
        "每个记忆载体都携带 branchId；当前实现中 Character 与 DirectorState 仍是已知例外。",
        fontsize=9.5,
        color=MUTED,
    )
    fig.tight_layout()
    fig.savefig(OUT / "fig1_pipeline.png", bbox_inches="tight", facecolor="white")
    fig.savefig(OUT / "fig1_pipeline.svg", bbox_inches="tight", facecolor="white")
    plt.close(fig)


def figure_benchmark():
    fig, axes = plt.subplots(1, 2, figsize=(12, 5.2), gridspec_kw={"width_ratios": [1.1, 1]})
    for ax in axes:
        ax.set_xlim(0, 6)
        ax.set_ylim(0, 5)
        ax.axis("off")

    ax = axes[0]
    ax.text(0.1, 4.7, "(a) 冲突分叉的构造", fontsize=13, fontweight="bold", color=INK)
    box(ax, (1.75, 3.55), "共享 opener\n同一分叉点", 2.5, 0.8, BLUE)
    box(ax, (0.25, 1.85), "分支甲\n只在甲上续写 5 段", 2.25, 0.95, TEAL)
    box(ax, (3.5, 1.85), "分支乙\n事实只作干扰项", 2.25, 0.95, RED)
    arrow(ax, (2.6, 3.55), (1.5, 2.8))
    arrow(ax, (3.4, 3.55), (4.55, 2.8))
    ax.text(0.3, 0.85, "硬约束：两侧均非标准历史\n否则模型先验会替记忆作答", fontsize=9.5, color=MUTED)

    ax = axes[1]
    ax.text(0.1, 4.7, "(b) 三档对照与三类判定", fontsize=13, fontweight="bold", color=INK)
    box(ax, (0.2, 3.2), "isolated\n分支隔离", 1.65, 0.7, TEAL)
    box(ax, (2.15, 3.2), "shared\n单线结构化记忆", 1.75, 0.7, RED)
    box(ax, (4.15, 3.2), "rag\n单线检索", 1.55, 0.7, ORANGE)
    box(ax, (0.6, 1.55), "关键词法", 1.4, 0.62, BLUE)
    box(ax, (2.3, 1.55), "LLM-as-Judge", 1.55, 0.62, BLUE)
    box(ax, (4.1, 1.55), "双标注者", 1.4, 0.62, BLUE)
    for x in (1.0, 3.0, 4.9):
        arrow(ax, (x, 3.2), (x, 2.17))
    ax.text(0.25, 0.7, "配对单位 = 故事/分叉；报告净泄漏增量，不比较绝对率", fontsize=9.5, color=MUTED)

    fig.suptitle("图 2  跨分支污染基准与评测协议", fontsize=15, fontweight="bold", x=0.04, ha="left", y=1.01)
    fig.tight_layout()
    fig.savefig(OUT / "fig2_benchmark.png", bbox_inches="tight", facecolor="white")
    fig.savefig(OUT / "fig2_benchmark.svg", bbox_inches="tight", facecolor="white")
    plt.close(fig)


def bar_panel(ax, labels, values, colors, ylabel, title, ylim=(0, 75)):
    bars = ax.bar(labels, values, color=colors, width=0.6)
    ax.set_ylim(*ylim)
    ax.set_ylabel(ylabel, color=INK)
    ax.set_title(title, loc="left", fontsize=12, color=INK, fontweight="bold")
    ax.grid(axis="y", color=LINE, linewidth=0.8, alpha=0.8)
    ax.set_axisbelow(True)
    ax.spines[["top", "right"]].set_visible(False)
    ax.tick_params(colors=MUTED, labelsize=9.5)
    for bar, value in zip(bars, values):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            value + 1.2,
            f"{value:.1f}%",
            ha="center",
            va="bottom",
            fontsize=10,
            color=INK,
            fontweight="bold",
        )


def figure_results():
    fig, axes = plt.subplots(1, 3, figsize=(14, 4.6))

    bar_panel(
        axes[0],
        ["none", "state", "graph", "both"],
        [53.3, 25.6, 41.1, 17.8],
        [MUTED, TEAL, ORANGE, BLUE],
        "退化复读率",
        "(a) 实验 A：四档消融",
    )
    axes[0].text(0.02, 0.94, "state p=0.0011；graph p=0.118", transform=axes[0].transAxes, fontsize=9.2, color=MUTED)

    bar_panel(
        axes[1],
        ["隔离", "单线"],
        [12, 67],
        [TEAL, RED],
        "Judge 污染率",
        "(b) 实验 B：两档主分析",
        ylim=(0, 80),
    )
    axes[1].text(0.02, 0.88, "净降低 55pp；t=8.88, p=3.4e-8", transform=axes[1].transAxes, fontsize=9.2, color=MUTED)

    bar_panel(
        axes[2],
        ["隔离", "RAG", "单线"],
        [5, 12, 61],
        [TEAL, ORANGE, RED],
        "Judge 污染率",
        "(c) 三档同轮外部对照",
        ylim=(0, 72),
    )
    axes[2].text(0.02, 0.88, "RAG vs 隔离 p=0.112（不显著）", transform=axes[2].transAxes, fontsize=9.2, color=MUTED)
    axes[2].text(0.02, 0.80, "RAG vs 单线 p=1.33e-6", transform=axes[2].transAxes, fontsize=9.2, color=MUTED)

    fig.suptitle("图 3  主要实验结果", fontsize=15, fontweight="bold", x=0.04, ha="left", y=1.02)
    fig.tight_layout()
    fig.savefig(OUT / "fig3_results.png", bbox_inches="tight", facecolor="white")
    fig.savefig(OUT / "fig3_results.svg", bbox_inches="tight", facecolor="white")
    plt.close(fig)


if __name__ == "__main__":
    figure_pipeline()
    figure_benchmark()
    figure_results()
    print(f"figures written to {OUT}")
