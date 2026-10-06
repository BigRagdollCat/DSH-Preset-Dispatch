# 上下文与派遣展示：实施及验证记录

状态：实施中；不作为全部验收通过证明。代码基线为 v0.6.0 / Git `62a5b7ad89f608c5a9e7f7221780dbf3113883b3`，接口基线为本机 DSH 0.2.0-rc.2。未提交、未发布。

需求与工作范围见 [需求](<08-context-and-dispatch-visibility-requirements.md>)、[工作清单](<09-context-and-dispatch-visibility-worklist.md>)。

## 1. 自动测试证据

| 阶段 | 冻结范围 | 命令 | 结果 | 解释 |
|---|---|---|---|---|
| 基线 | 修改生产代码前的 v0.6.0 | `node scripts/test.mjs` | exit 0；190 pass / 0 fail | 证明旧测试基线，不证明新增功能 |
| A 初次 GREEN/回归 | 短提示与精简目录候选及新增目录测试 | `node --check core.js`、`node --check routing.js` | 两项 exit 0 | 仅语法 |
| A 初次 GREEN/回归 | 同一候选 | `node scripts/test.mjs` | exit 1；215 tests / 207 pass / 8 fail / 0 skipped | 未达到 GREEN。包括旧默认目录断言、新夹具缺 preflight/on、空错误值与锁定缺省断言。测试作者已修正，尚未重跑；阶段 B 同时修改生产模块，需冻结后再验证 |
| C 初次 RED | 压缩模块不存在；只导入独立测试 | `node --input-type=module -e "await import('./test/query-compaction.test.js')"` | exit 1；23 tests / 1 pass / 22 fail / 0 skipped | 21 项为明确缺失行为断言；1 项为真实计量包导出加载错误，不计为有效行为 RED |
| C 第二次 RED | 压缩模块仍不存在；修正真实计量包公共导出后 | 同上 | exit 1；25 tests / 0 pass / 25 fail / 0 skipped | 24 项缺少实现；1 项为父目录/子描述事件断言错误。后者不计有效 RED。测试作者随后修正断言、内容计价及官方 surface 路径；尚未据此取得 GREEN |
| B 修复前候选 | 阶段 B 冻结候选（A/B/C 未接线） | `node scripts/test.mjs` | exit 1；306 tests / 279 pass / 27 fail / 0 skipped | 真实缺陷与夹具/契约问题混合，分类见下 |
| B 修复+V11+严格绑定 | HEAD 62a5b7a 加工作区改动 | `node --test-reporter=tap --test-reporter-destination=.tmp/tap-verify-round3.txt scripts/test.mjs` | exit 1；320 tests / 312 pass / 8 fail / 0 skipped | 4 项真实产品缺陷、4 项夹具缺陷；无环境错误、无跳过、未发现上一轮通过本轮转失败的回归项 |
| 阶段 C 接线 | 新增接线模块与 15 项测试 | `node --test-reporter=tap --test-reporter-destination=.tmp/tap-verify-round5.txt scripts/test.mjs` | exit 0；335 tests / 335 pass / 0 fail / 0 skipped | 新增接线测试全绿，上一轮 320 项零回归 |
| 审查缺陷修复 | 10 项审查缺陷 + 17 项新断言 | `node --test-reporter=tap --test-reporter-destination=.tmp/tap-verify-round6.txt scripts/test.mjs` | exit 1；352 tests / 351 pass / 1 fail / 0 skipped | 唯一失败为 pending 流对无关更新多发一帧（真实缺陷），其余 16 项新断言与 335 项基线全绿 |
| 最终候选 | 定点修复 pending 过滤 | `node --test-reporter=tap --test-reporter-destination=.tmp/tap-verify-round7.txt scripts/test.mjs` | exit 0；352 tests / 352 pass / 0 fail / 0 skipped | 目标失败转绿，上一轮 351 项零回归、无丢失测试 |

RED 指目标行为缺失导致的实际失败；环境错误、导入夹具错误不能用来证明目标行为失败。测试作者的预期计数不替代本表执行结果。

## 2. 接口调查结论

- `preset_list` 默认提供精简目录；显式 `diagnostic:true` 保留完整诊断。`catalogId` 是父会话关联编号，不是授权票据。
- `ToolOutputDefinition.presentationMeta(args,value)` 写入合法 `tool/result.meta`，用于 UI，不能进入模型正文。
- `request/header` 的 `header.config` 为宿主已提交请求配置。`adapterDefaults.reasoningEffort` 只有默认来源标识；不能据此推断具体值，也不能证明提供方已接受请求。
- `sessionProjections` 支持纯同步增量计算；未知 key 在客户端返回 `undefined`，按能力缺失处理。不要反复扫描全日志，不注册私有 Session 事件。
- `tool.call.toolview` 的 `preset_dispatch` 键未被占用。必须自己保留 preparing/start/result、错误和结果展开；卡片 props 不含子代理实际请求配置。
- `conversation.input.left` 可追加普通输入区徽标。一次性子代理只读预览替换整个输入区，需另用 `conversation.session.header.actions` 的独立列表项。不占已被官方使用的 lineage/model 单一座位。
- 父会话 `subagent/catalog` 持有精确子编号和创建信息，**不是**子会话 `subagent/descriptor`。目录只能证明关联，不能独自证明请求开始。
- 官方替换由紧邻的 `compaction/prune` 和 `tool/result` 单节点 replace 组成。孤立 prune 不扣减；替换两次追加不是磁盘事务。原审计记录不删，模型消息来自当前 surface。

## 3. 当前运行验收限制

现有 GUI 地址为 `http://127.0.0.1:3080`。代理浏览器 default 会话打开裸地址后显示 DSH Web 认证要求；尚未取得经过认证的 GUI 操作证据。未搜索凭证或绕过认证。

Host 模块使用稳定导入，需要协调维护窗口重启当前 DSH 进程；不能在实现与验证子代理运行中重启。未启动替代服务器。尚未验证新代码已被当前 Host 加载，也未验证浅色、深色、窄屏、父工具卡片、子会话或只读预览。

阶段 C 默认关闭。尚未取得 Flash/Codex 查询→派遣→后续请求、恢复/分支、缓存/续接或费用对比证据；不能以字符减少宣称已节省 Token 或费用。

当前 GUI 观测：派遣卡片已渲染，但显示名称/版本/计划为“未知”和“实时状态不可用”。同一轮 `preset_list` 仍返回旧版完整目录（含 `hostPool`、`unauthorizedModels` 与未启用预设），证明当前 Host 进程未重启，运行信封与可见性接口尚未加载。该观测只证明客户端半边已生效，不证明阶段 B 展示功能可用。

## 4. 冻结候选审查

阶段 B 独立只读审查未通过。主代理已核对以下问题：Host 修改历史副本却未更新活动票据；结束时可能覆盖实际配置；历史缺少父会话与查询编号；可见性接口未严格匹配全部编号；普通输入区注册成功后缺少只读预览头部入口；运行中卡片忽略实际配置；观察折叠缺少继承边界和序号去重；默认强度来源被猜测。

实际观察不得依赖最近 50 条历史。投影使用真实 zod 契约；所有聊天注册和订阅必须在卸载时释放。审查未执行测试，也未验证完整 Git 差异；实现者自测不计独立验收。

阶段 C 独立模块已写完，尚未接线和验收。主代理只读检查发现：模块尚未用派遣调用参数识别未结束关联，也未要求已提交实际请求观测字段。修复前不能压缩查询。

新增测试仍需纠正契约：派遣时名称和版本快照不得因后来重命名而改变；普通输入区和只读预览头部应分别注册；React 模拟必须在依赖变化或卸载时清理，不能创建订阅后立即清理并把旧渲染树当成更新结果。

## 5. 修复轮与独立验证

阶段 B 修复轮由单一生产写者完成 16 项：历史内部行访问器 `history.get(id)`、观察回写活动票据、`parentSession` 关联、严格编号匹配、流生命周期与卸载关闭、活动票据优先、观测级适配器默认、按序号去重、投影继承边界与真实 zod、`observationSummary` 的 `verification`、`status` 不可改写、运行信封、客户端父会话与 `planned` 字段、双插槽注册与释放、压缩资格两项新门槛、打包清单补 `query-compaction.js`。随后追加两项：可见性父会话严格绑定；V11 卡片导航入口，服务经 `ctx.get` 获取，缺失时只隐藏对应入口。

独立验证在冻结候选上执行，得到 320 tests / 312 pass / 8 fail。判定 3 项真实产品缺陷：卡片身份字段被后到的帧覆盖且 start 阶段不读信封；投影 `init` 的 `firstLive` 被空状态展开覆盖，继承前缀防护成为死代码；可见性流在运行结束时推送终态帧却不关闭。另 4 项为夹具缺陷：可见性历史替身广播前不落盘，两处子徽标投影缺 `parentSession`。

身份契约裁决：result 阶段以派遣时信封为准，信封缺的字段由记录行补；start 阶段以记录行首个可用值为准并冻结，信封只作拿到记录行之前的回落；状态、实际配置与实时状态始终以记录行为准，不冻结。

阶段 C 的 Host 接线（query-compaction-host.js）已实现并默认关闭，独立验证为 335 tests / 335 pass、exit 0，上一轮 320 项零回归。

随后独立只读代码审查确认 10 项缺陷，建议交付前修复：真实派遣返回值缺少 `parentSessionId`，使压缩资格在真实链路永不成立；`tool/call` 未保存调用参数，未结束关联检查失效；pending 流被无关更新关闭；预留子会话编号被当成启动证明而提供入口；配置变化基线被清空导致重复或漏记；序号去重只覆盖最近 256 个请求；首次读取已结算记录仍保留订阅；start 阶段固定显示等待文案；插件卸载竞态可能在卸载后留下插槽贡献。审查同时确认未发现 catalogId 授权绕过，历史存储域版本保持 1，打包清单已覆盖四个新模块，客户端未引入 Harness Client 包依赖。

## 6. 最终门禁与剩余验收

最终候选（HEAD `62a5b7a` 加工作区改动）四项门禁全部 exit 0，由独立验证角色执行：

| 门禁 | 命令 | 结果 |
|---|---|---|
| 语法与冻结表 | `node scripts/check.mjs` | 54 个模块语法通过；57 行冻结哈希一致；57 个必需文件全覆盖 |
| 全量测试 | `node scripts/test.mjs` | 352 tests / 352 pass / 0 fail / 0 skipped |
| 真实打包 | `node scripts/pack-check.mjs` | 真实 `npm pack --dry-run`：70 个文件、1526441 字节，无 tarball 残留 |
| 存储契约 | `node scripts/storage-contract-check.mjs` | 真实 `defineDomain` 接受本插件声明；`preset_dispatch_history` v1、表 `runs` |

剩余未完成项需要真实宿主与用户确认：

1. 重启当前 DSH 进程后验证界面：派遣卡片的计划/实际显示、子会话徽标、V11 入口、浅深色与窄屏、一次性只读预览。
2. 在授权模型池内验证 Flash/Codex 的查询→派遣→后续请求、恢复/分支、缓存与费用；在此之前压缩保持默认关闭。
3. 发布与版本号更新未做；本轮未提交、未安装、未发布。

## 7. 重启后的真实宿主检查

用户在重启 `dsh web` 进程后，主代理在运行实例上确认：

- `preset_list` 返回精简目录（含 `catalog` 标记、`rules`、`omittedPresets`，不再返回 `hostPool`/`unauthorizedModels`），证明阶段 A 与新 Host 已加载。
- `/api/preset-dispatch/visibility` 返回 400「Authenticated operator request required」（本插件门禁），未知同级路径仍返回 401，证明可见性路由已注册。
- 一次真实前台派遣返回 `parentSessionId`、`runId`、`presetVersion`、`observationState:"finished"`，并从子会话已提交请求观测到实际配置（`observedSeq:13`、`verified:true`）。
- 后台派遣如实返回 `childStarted:false`，与 V11「编号未确认不显示入口」一致。

同一次检查发现一个**真实客户端回归**：`tool.call.toolview` 的占用键不再包含 `preset_dispatch`，两个徽标插槽也没有本插件贡献。原因是修复轮把三个界面贡献包在 `ctx.slots.inject('chat surfaces', …)` 里，而 `'chat surfaces'` 不是已声明的插槽名；真实 Host 的 `inject` 只在插槽已声明时才执行回调，因此回调永不执行。

该回归未被 352 项测试发现，因为测试夹具的假 `inject` 无条件立即调用工厂。修复：生产改为按三个真实插槽名分别 `ctx.effect(() => ctx.slots.inject('<插槽名>', () => ctx.slots.register(...)), label)`（与官方插件写法一致）；测试夹具的 `inject` 改为只在插槽名已声明时调用工厂，并新增「每个注入键必须是已声明插槽」的断言。真实界面复验需用户刷新页面后在已认证页面上确认。
