# Qwen 第二模型交叉验证

> 日期：2026-11-07
> 目的：回应主实验只使用 `deepseek-chat` 的单模型限制
> 生成模型：`qwen3.7-plus`（阿里云百炼）
> Judge：`deepseek-chat`（保持不变）

---

## 一、实验协议

为了只改变生成模型这一个变量，Qwen 只替换续写生成；叙事状态抽取、知识图谱抽取和
跨分支 Judge 仍使用主模型。两档/三档实验的 prompt、5 段续写、判定协议和统计口径
保持不变。

### 1. 环境变量

```env
SECOND_MODEL_API_KEY=...
SECOND_MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
SECOND_MODEL_NAME=qwen3.7-plus
SECOND_MODEL_ENABLE_THINKING=false
```

Qwen3 默认 thinking 模式会显著拖慢长文生成，因此第二模型显式关闭 thinking；
该设置只作用于 secondary 档，不影响主实验。

### 2. 运行方式

```bash
npx tsx tests/ab_branch_isolation.ts \
  --stories=10 --segments=5 --rounds=1 \
  --arms=isolated,shared,rag \
  --generator-model=secondary \
  --tag=qwen37plus_n10 \
  --out=branch_qwen37plus_n10_report.md
```

---

## 二、Smoke 结果

先跑了 2 个分叉 × 3 档 × 2 段 × 1 轮：

| 档位 | Judge 污染率 |
|---|---:|
| 分支隔离 | 0% |
| 单线结构化记忆 | 75% |
| RAG 单线检索 | 0% |

覆盖 6/6 组合，数据文件：

`branch_isolation_n2_qwen37plus_smoke_2026-11-07T08-11-40.json`

smoke 只用于验证 Qwen 生成、DeepSeek Judge 和落盘链路，不作论文结论。

---

## 三、正式探索性跑批

正式跑批为 10 个分叉 × 3 档 × 5 段 × 1 轮，共 150 次生成。结果文件与报告：

- `branch_isolation_n10_qwen37plus_n10_*.json`
- `branch_qwen37plus_n10_report.md`

**当前状态：运行中。** 跑完后在这里补三档污染率、逐故事胜负和统计结果，并明确它只作为
探索性交叉验证，不替代主实验的 20 组 × 3 轮结果。

---

## 四、论文写法

如果结果与主实验方向一致，可写：

> 在 10 个代表性分叉、1 轮续写的探索性复验中，Qwen3.7-Plus 生成条件下的档位排序与
> DeepSeek 主实验方向一致；该复验仅用于检验趋势的模型依赖性，不用于替代主实验的
> 20 组 × 3 轮统计结论。

如果结果不一致，必须如实报告，并把它写入单模型泛化性限制，不能只报与主实验一致的部分。
