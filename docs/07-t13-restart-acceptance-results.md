# T13 重启后验收结果（运行时证据）

本文件记录**在真实运行实例上**取得的验收证据。凡未取得的项目在文末列明，不写作已完成。

## 1. 新 Host 代码是否真的生效 — 通过

`node scripts/live-probe.mjs`（探测运行实例的路由）：

| 路由 | 结果 | 含义 |
|---|---|---|
| `/api/preset-dispatch/history/query` | `400 Authenticated operator request required` | 0.6.0 新增路由已注册 |
| `/api/preset-dispatch/catalog/refresh` | `400 …` | 0.6.0 新增路由已注册 |
| `/api/preset-dispatch/agent-save` | `400 …` | 统一保存端点已注册 |
| `/api/preset-dispatch/presets/save` | `401` | 已退役的旧端点确实不存在 |

`verdict: the 0.6.0 Host code IS live`。

**探针的局限（如实说明）**：它只能证明"加载了 0.6.0 时代的代码"，**不能**证明加载了最新一次改动——因为新旧代码的路由集合相同。判断最新改动是否生效，必须用下面的介质证据。这一点在验收过程中真实踩到过：用户第一次重启后探针显示 live，但介质里仍写出 `undefined.json`（见第 3 节）。

## 2. 存储域是否真的建立 — 通过

`C:\Users\<用户名>\.dsh\storages\preset_dispatch_history\runs\` 存在。

此前域名是 `preset-dispatch-history`，而介质在运行期强制 `/^[a-z][a-z0-9_]*$/`——`defineDomain` 会抛错，插件会捕获并降级为内存历史。**这类错误只会在真实介质上暴露**（类型声明与单元测试都看不出来）。修正为 `preset_dispatch_history` 后域成功建立。

## 3. 真实介质往返 — 通过

一条真实派遣产生的记录（`runs/run-muu9k0sh-gaf575.json`）：

```json
{ "version": 1, "record": {
  "id": "run-muu9k0sh-gaf575", "preset": "researcher",
  "provider": "opencode-go", "model": "deepseek-v4.1-flash", "reasoningEffort": "low",
  "modelSource": "parent-explicit", "effortSource": "parent-explicit", "presetVersion": 1,
  "policySnapshot": { "preset": "researcher", "enabled": true, "modelScope": "selected", … },
  "startedAt": "2026-10-04T20:18:36.161Z", "finishedAt": "2026-10-04T20:18:42.192Z",
  "status": "completed", "childSessionId": "1c574304-3b37-433f-a93a-a0519e6c215b" } }
```

由此确认：

- **H01 持久化**：记录真的落在真实介质上，且带版本封套（`version: 1`）。
- **H02 隐私最小化**：记录中**只有元数据**——派遣的任务正文与子代理输出**不在其中**（对照发送的任务文本可确认）。
- **写入与更新两条路径**：`startedAt` 与 `finishedAt` 同时存在，说明 `finish` 对同一条记录做了**原地更新**（同一个 id 覆盖同一份文档）。
- **id 修复生效**：主键是 `run-muu9k0sh-gaf575`，而不是此前真实出现的 `undefined`。

## 4. 介质自愈（`invalidRecords: 'backup-and-skip'`）— 通过

修复前写出的坏记录（无 `id`，无法寻址）被后端**移开并备份**为
`runs/undefined.json.bak.202610050417`，而不是让整份历史不可读。

这同时证明了三件事：介质能枚举并校验记录；schema 会拒绝缺少 `id` 的记录；隔离策略按声明工作。历史对话框因此不会显示这条假记录。

## 5. 七个角色与授权边界（实时 `preset_list`）— 通过

名称、工具模板、默认模型、默认强度逐项与 `docs/06` 的预期表一致；`dispatchable` 恰好只有这七个受管预设（四个原生预设与 `dispatch` 均为 `false`）；授权池 2 个模型、`unauthorizedModels` 如实列出其余 12 个；`catalogFailures: []`。

## 6. 门禁（在冻结候选上复跑）— 通过

| 命令 | 结果 |
|---|---|
| `node scripts/check.mjs` | 43 模块语法 / 47 行冻结哈希 / 47 必需项，退出码 0 |
| `node --test-reporter=dot scripts/test.mjs` | 退出码 0 |
| `node scripts/pack-check.mjs` | 50 个文件将发布，退出码 0 |
| `node scripts/storage-contract-check.mjs` | 真实包加载，声明被接受、非法名被拒，退出码 0 |

失败路径已由变异测试证明（移除发布清单中的必需文件 → `pack-check` 退出码 1；删除冻结表行 → `check` 退出码 1）。

## 7. 真实浏览器交互 — 通过（用户验收）

用户在实际界面逐项确认通过，并提供了截图证据：

| 项目 | 结果 |
|---|---|
| **O02 两处顺序一致** | 管理页顺序（实现开发→根因调查→规划架构→研究检索→代码审查→测试编写→测试验证）与原生 roster 顺序**完全相同**——七个当前共用同一 `order` 值，两侧都落到 id 次级排序，正是本轮对齐的那条规则 |
| **U01 模板胶囊** | 模板名与预设名相同时**隐藏**（实现开发/研究检索/测试编写/测试验证），不同时**显示**（根因调查/规划架构/代码审查 显示「只读」） |
| **U03 卡片→单弹窗** | 点卡片打开**一个**弹窗，同时含「预设设置」与「子代理派遣设置」；稳定 ID 只读 |
| 边界禁用 | 首张卡的 ↑ 为禁用态 |
| 原生视觉风格 | 卡片/边框/胶囊为原生样式，浅色与深色均正常 |
| **Esc / Tab** | Esc 关闭弹窗；Tab 在弹窗内循环 |
| **R01 草稿保护** | 有未保存更改时刷新出现提示；刷新后可恢复未完成的草稿 |
| **R05 拒绝反馈** | 被拒绝的保存把原因显示在**弹窗内**（不再被模态遮罩挡住） |
| **H04 读回** | 重启后「调用记录」仍显示先前派遣的记录（记录先落盘、再经历重启），读回路径闭合 |

验收过程中用户截图暴露出一句**自相矛盾的文案**并已修复：调用记录弹窗原文写着"插件重载后清空"（历史仅存内存时代的旧文案），与持久化后的行为正好相反；现改为"仅保留最近 50 条元数据……记录写入本地存储，重启后仍在；中断的派遣会标记为已中断"。

## 8. 仍未取得证据的项目

1. **真实回退演练**：未执行（本环境无法在不影响用户会话的情况下切换插件版本）；快照、指纹与判据见 `docs/05`。它验证的是"回退流程本身可用"，而不是本版本的行为。
2. **H03 保留上限在真实介质上的淘汰**：50 条上限与介质删除已有单元测试覆盖，但未在真实介质上制造 50+ 条记录来观察淘汰。

## 9. 结论

T01–T13 全部完成。四道门禁在冻结候选上通过：`check`（43 模块语法 / 47 行冻结哈希 / 47 必需项）、`test`、`pack`（50 个文件）、`storage-contract`（真实包运行时契约），且失败路径已由变异测试证明。
