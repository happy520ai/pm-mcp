# 1.2.0 首次失败保留记录

本文件记录升版之前真实发生的失败与范围，作为复核说明，不是测试通过数据。

## 失败一：验收门禁恒定失败

`npm run gate` 退出码 1。同一次执行里：结构与安全检查硬红旗 0 个；质量矩阵 PASS（`.pm/quality-runs/quality-20261027-073546-347-0000.json`，test/build/typecheck/coverage 四项均 passed）；acceptance 阶段 FAIL，报告 `pm-mcp-local-20261027-073546-8b36c114`，errors=8。

首个错误为 `QUALITY_THRESHOLD_NOT_MET`：`QR-FS-TOOLS` 实测 58，未达到 `equal 48`；随后级联出 `REQUIREMENT_TESTS_NOT_PASSED`、`RISK_CONTROLS_NOT_VERIFIED`、`TEST_NOT_PASSED` 与三条 `TRACEABILITY_INCOMPLETE`。8 条错误全部源自同一处工具计数，与当轮文档改动无关。

## 失败二：无人值守工作流里的门禁从未执行

首个自动编排轮次的 workflow 在第 4 段调用 `world.run("npm", ["run","gate"])` 时失败：`spawn C:\Program Files\nodejs\npm ENOENT`（Windows 下 shell-less spawn 找不到 `npm`）。把命令改为 `npm.cmd` 后用同一脚本重派，报 `'"C:\Program Files\nodejs\npm.cmd"' 不是内部或外部命令`，同样未执行成功。

即：workflow 内的确定性门禁两次都没真正跑到，当轮报告的 gate 结论来自子代理自己的手动执行，随后由心跳在工作区内独立复跑确认（退出码 1，失败点相同）。两次失败的脚本与运行记录均保留，未删除。

## 修复边界

升版只改工具计数一项（48 → 58）。没有为了让门禁变绿而放宽覆盖率、安全、治理或测试计数门槛；上述失败记录不因本版通过而被覆盖。
