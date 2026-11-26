# 图像第二评分者 · 接包与评分流程（2026-11-15）

> 对应任务：`Docs/ablation/团队进度与下周任务_20261108.md` §5.2 黄夏薇「独立复评图像」
> 负责人：黄夏薇（第二评分者）
> **当前状态：阻塞** —— 截至 2026-11-15，本机与 GitHub 均未收到章真毓的干净盲评包。
> 本文件是该包到位后的**接包核验清单 + 评分流程**，收到包后按此执行。

---

## 一、依赖与验收口径

| 项 | 要求 |
|---|---|
| 图片数量 | 24–45 张（任务卡：24–45 张） |
| 评分者 | 黄夏薇，**不得**查看 condition / seed / 原文件路径 / 档位映射 |
| 评分内容 | 只按冻结 rubric 评外观呈现分；不知道每张图属于 before/after |
| 交付物 | 第二评分者评分表（匿名 ID + 评分项），及恢复映射后的 `scores_images_human_rater2.csv` |
| 后续统计 | 人工 A × 人工 B κ、人工 A × AI κ、人工 B × AI κ，三者分开报告 |

---

## 二、接包核验清单（收到包后先做完再评分）

### 2.1 文件层面

- [ ] 图片张数在 **24–45** 之间，且每张都有编号（如 `IMG_001`）；
- [ ] 图片文件名**不含**故事名、段号、condition（before/after）、seed；
- [ ] 评分表只有：匿名 ID、图片文件、评分项、备注、scored_by；
- [ ] **不含** `condition`、`seed`、`original_file`、`story`、`segment_index` 列；
- [ ] 映射密钥（匿名 ID → 故事/段/condition）是**单独文件**，评分期间不打开。

### 2.2 泄漏自检命令

在包的评分表与说明文件所在目录执行：

```bash
grep -niE "condition|seed|original_file|before|after|isolated|shared" <评分表>.csv <说明>.html
```

- [ ] 除表头说明中允许出现的「本表不含条件信息」字样外，**无命中**；
- [ ] 若评分表是 HTML，另查内嵌 JS 里是否带条件字段：

```bash
grep -niE "condition|seed|original" <评分表>.html
```

### 2.3 评分规范

- [ ] rubric 与实验冻结版一致（外观 6 项：age_sex / face / hair / build / outfit / prop，6 分制）；
- [ ] 说明清楚「char_present=0 时其余项记 0」；
- [ ] 有「说不准 / 不可核」的填写约定（留空并在 notes 注明）。

> 只要有一项不满足，**不要开始评分**，先退回章真毓重建包。

---

## 三、评分流程

1. **先核验**（第二节），核验通过再打开图片。
2. 逐张评分，**不做跨图身份比较**（这是另一项 paired 判定，不属于本条任务）。
3. 评分结果写入 `评分表_空白.csv` 的匿名 ID 行（该空白表**不含**条件列）。
4. 评完后交给持有密钥的人（章真毓或肖文宇）做映射恢复，得到
   `scores_images_human_rater2.csv`，列格式与 `scripts/analyze-paired-consistency.ts`
   读取的 `scores_images_human.csv` 一致（含 story / segment_index / condition）。
5. 恢复映射是**评分之后**的事；评分过程中第二评分者不得接触映射。

---

## 四、统计依赖

任务要求「人工-人工 κ 与人工-AI κ 分开报告」。当前仓库状态：

| 需求 | 现状 |
|---|---|
| 人工 × AI 一致率与 κ | ✅ `scripts/analyze-paired-consistency.ts` 已支持（读 `scores_images_human.csv`，以「呈现分 ≥ 5」为二值标签） |
| 人工 A × 人工 B κ | ✅ `scripts/image-human-interrater.ts`（2026-11-26 补齐；带 `--selftest`） |

用法（B 表恢复映射后，三份表放在同一实验目录）：

```bash
npx tsx scripts/image-human-interrater.ts --dir <实验输出目录>
npx tsx scripts/image-human-interrater.ts --selftest
```

脚本按 `story|segment_index|condition` 对齐两份人工表，输出逐图完全一致率、二值一致率、
Cohen's κ 与分项一致率；若目录里有 `scores_images.csv`，另出 A×AI、B×AI 两张表。
**不要手算后写死数字**，一律以上述脚本输出为准。

---

## 五、本目录文件

| 文件 | 用途 |
|---|---|
| `README_接包与评分流程.md` | 本文件 |
| `评分表_空白.csv` | 匿名评分表模板（无 condition / seed / 原文件列） |

> 图片与映射密钥不放入本仓库（体积大且属实验数据）；本目录只放评分流程与空表。
