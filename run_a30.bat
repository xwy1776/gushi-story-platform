@echo off
REM 实验 A 扩样跑批：30 故事 x 4 档 x 5 段 x 3 轮（共 1800 段）。
REM
REM 为什么是独立进程：会话里起的后台任务会随会话结束被杀（本项目栽过三次）。
REM 由 Start-Process 以隐藏窗口启动，输出追加到 logs\a30_run.log。
REM 进度用 run_a30_status.bat 看。
REM
REM 轮次说明：脚本没有 --rounds 参数，"一轮"就是把同一条命令跑一遍，
REM 每遍落一份带时间戳的 JSON，最后用 --rounds-report 汇总（与 s15 的跑法一致）。
cd /d "%~dp0"
if not exist logs mkdir logs
echo. >> logs\a30_run.log
echo ============================================================ >> logs\a30_run.log
echo [%date% %time%] START a30 run >> logs\a30_run.log

echo [%date% %time%] ROUND 1/3 START >> logs\a30_run.log
call npx tsx tests/ab_ablation.ts --stories=30 --segments=5 >> logs\a30_run.log 2>&1
echo [%date% %time%] ROUND 1/3 EXIT=%ERRORLEVEL% >> logs\a30_run.log

echo [%date% %time%] ROUND 2/3 START >> logs\a30_run.log
call npx tsx tests/ab_ablation.ts --stories=30 --segments=5 >> logs\a30_run.log 2>&1
echo [%date% %time%] ROUND 2/3 EXIT=%ERRORLEVEL% >> logs\a30_run.log

echo [%date% %time%] ROUND 3/3 START >> logs\a30_run.log
call npx tsx tests/ab_ablation.ts --stories=30 --segments=5 >> logs\a30_run.log 2>&1
echo [%date% %time%] ROUND 3/3 EXIT=%ERRORLEVEL% >> logs\a30_run.log

echo [%date% %time%] ROUNDS REPORT START >> logs\a30_run.log
call npx tsx tests/ab_ablation.ts --rounds-report --only=s30x5seg --out=s30_rounds_report.md >> logs\a30_run.log 2>&1
echo [%date% %time%] ROUNDS REPORT EXIT=%ERRORLEVEL% >> logs\a30_run.log

echo [%date% %time%] ALL DONE >> logs\a30_run.log
