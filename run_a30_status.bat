@echo off
REM 查看 a30 跑批进度。
cd /d "%~dp0"
echo ==== 日志尾部 ====
powershell -NoProfile -Command "Get-Content logs\a30_run.log -Tail 25"
echo.
echo ==== 已落盘的 s30 结果 ====
dir /b Docs\ablation\*s30x5seg* 2>nul
echo.
echo ==== 汇总报告 ====
if exist Docs\ablation\s30_rounds_report.md (echo 已生成 s30_rounds_report.md) else (echo 尚未生成)
