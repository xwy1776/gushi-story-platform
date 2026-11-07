# CI 使用与协作规范
## 1. CI工作流说明
仓库已配置 `.github/workflows/type-check.yml`，在PR提交、push到远端分支时自动执行：
- `npx tsc --noEmit`：TypeScript全量类型检查，零错误方可通过。

## 2. PR合并强制规则
1. 所有Pull Request合并入主分支前，**必须通过CI类型检查**；
2. CI报错不允许强行merge；需要开发者本地执行 `npx tsc --noEmit` 修复全部类型错误后再推送；
3. 如果CI因外部环境偶然失败，可重新触发运行，不允许绕过CI直接合并。

## 3. 本地开发前置校验
开发者提交代码前，本地务必执行，提前捕获类型问题：
```bash
npx tsc --noEmit