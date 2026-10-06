# 维护说明（MAINTENANCE）

> **面向维护者**：Git 记录变更历史；冻结哈希表标识验证候选。本文件还记录门禁、入口与兼容文件生命周期及环境约束。
> 面向使用者的安装与使用说明请看 [README.md](README.md)。

---

## 原 README 内容（面向维护者）

一个 `@local/dsh-preset-dispatch` bundle，设置 → **Agent 管理**：单页卡片列表，点击任意 Agent 卡片在一个弹窗内同时编辑「角色定义」与「子代理派遣设置」。

> **设计文档**：[docs/01-requirements.md](docs/01-requirements.md)（需求与 R1–R20 验收项）、[docs/02-development-plan.md](docs/02-development-plan.md)（分阶段实现方案）。两者描述 v0.4.0 已实现的设计，保留为设计记录；文档中标记为「待确认」的问题以本文件与代码为准。

## Agent 管理（单页 + 合并弹窗）

- 视觉与交互对齐 DSH 原生「Agent 预设」页面：720px 内容列、大写分组标题、`repeat(auto-fill,minmax(268px,1fr))` 卡片网格、卡片头（名称 + ID）、说明、页脚元信息、虚线新建按钮，以及 720px 的对话框。样式仅使用 DSH 主题变量；原生内部令牌（如 `--dsw-radius-xl`、`--dsw-alias-settings-card-fill`）都带安全回退，缺失时仍可正常渲染。控件（开关 `role="switch"`、卡片、提示药丸、模型勾选列表、按钮）复用同一套自绘组件与 CSS 类。
- **点击整张卡片**打开该 Agent 的编辑弹窗，内含两个分区：**预设设置**（名称、说明、详细角色提示词、工具权限模板）与**子代理派遣设置**（允许派遣、模型范围、模型勾选、默认模型、默认/允许思考强度、锁定默认模型）。不使用折叠、不弹二级弹窗；内容区独立滚动，底部操作区固定。
- 卡片摘要直接显示派遣状态：`派遣：已启用 · <默认模型> · <强度> · N 个模型`。
- 全局项（DSH 子代理模型授权池、最大派遣深度、失效策略行清理）不属于任何单个 Agent，通过工具栏「全局设置」按钮打开的独立弹窗管理；「调用记录」同样是独立弹窗。
- 对话框可访问性：打开时焦点移入并限制在对话框内（Tab/Shift+Tab 循环，含 `summary` 与自定义 `tabindex` 元素；焦点若落在对话框外会回到首/末控件），关闭后焦点在界面空闲时回到触发元素（保存进行中触发按钮仍禁用，因此恢复会等到解禁之后，避免静默丢焦点）；`Esc`、点击遮罩或右上角关闭；未保存更改二次确认；保存进行中禁止关闭，避免回调关闭新打开的编辑器。已知限制：背景未设为 `inert`，也不支持焦点回绕到浏览器 UI 之外的完整自管理模式。
- 读取失败时工具栏按钮变为「重试读取」且始终可用（不因数据未加载而被禁用）；未加载数据时新建按钮禁用，且不会在缺失数据上打开编辑器。「重新读取」在有未保存草稿时先确认并关闭编辑器——避免旧草稿被绑定到刚读取的新 revision 后提交。
- 创建、复制、搜索、删除自有预设；删除在弹窗内二次确认。**非本插件管理的预设（原生内置与其他插件的预设）在本页完全只读**：没有点击目标、没有编辑入口、不发起任何写入；它们仍会出现在 DSH 原生 Agent 预设列表中。
- 稳定 ID 创建后不可改；复制使用新 ID。
- 预设是 `agent-managed-presets` 原生 `cordis:group` 内的 `@deepseek-ai/dsh-agent-preset` 声明，仍出现在 DSH 原生选择列表。
- 页面自带 `<style>` 注入（主题令牌 + 安全回退）。**这是必须保留的**：漏掉时页面会退化成无样式的裸 HTML（卡片变成圆点列表、文字挤在一行）——`test/client-render.test.js` 有专门的回归断言守住它。
- 通过公开 `configEditor.edit` 保存完整分组，写入 profile patch 并按 Loader 生命周期应用；不私建隐藏注册表、不直接手写托管配置。
- 内容哈希做并发校验；保存后版本递增。新会话使用新版本，已绑定会话由 DSH 引用计数保留旧版本。
- 默认预设不能删除；存在活跃会话时拒绝删除。删除关联策略保留；不存在的 ID 不能派遣。删除可能影响将来恢复旧持久化会话，应先检查历史使用。
- 初始七个 ID、名称、角色正文和模型策略保持不变。`migration-snapshot.json` 与 `migration-role-snapshot.json` 是迁移回退参考。

## 模型目录与授权（三层语义）

- **候选目录**：由 `catalog.js` 通过公开 `ctx.llm.listProviders()` → `listModels()` → `resolveModelInfo()` 组装，与 DSH 原生模型选择器同源。**不做已授权池过滤**，因此原生选择器可见的模型在这里都能看到。单个提供方失败只记录为 `failures`，不会清空目录。
- **Host 授权池**：原生设置条目 `subagent-model-selection-settings`，通过 `ctx.settings.describe()` 读取、`ctx.settings.update(ns, patch, revision)` 写入（与原生设置页同一来源）。它决定整个 Harness 允许子代理使用哪些模型。
- **预设授权列表**：每个预设自己的 `allowedModels`。勾选只是声明；保存后才生效。新增模型默认**未勾选**。
- 未授权模型在弹窗中照常列出并标记「需授权」，同时勾选后保存会被阻止，直到显式勾选「同时启用 DSH 全局模型授权」。该确认会说明影响范围：扩权作用于整个 Harness，可能影响其他子代理入口。
- 保存顺序为「授权池 → 预设定义 → 策略」，任一步失败即中止后续步骤，避免在旧前提下写入。**这不是跨存储事务**：结果按 `{hostPoolSaved, definitionSaved, policySaved, settingsSaved, errors[]}` 分项如实返回。界面按实际落盘情况措辞：零写入显示「未保存任何更改」，部分成功显示「部分已保存（已保存：…）；未保存：…」。刷新界面状态本身失败时仍返回分项结果并附 `stateError`，不会把已完成的写入报成失败。
- 并发保护：编辑器在打开时记录基线修订号（定义、策略、授权池各一），提交时原样回传。服务端要求 `settingsRevision` 与当前值一致，不一致即拒绝，**不会把过期草稿静默重挂到新版本上**。保存未全部成功时，界面**不会**采用返回的更新后修订号——草稿继续绑定基版本，再次提交仍会被拒绝，直到用户点弹窗内的「重新读取」（会放弃草稿）。单行策略合并也不会覆盖其他预设的行。
- 默认模型必须落在该预设实际可用的模型集合内；思考强度按所选模型真实能力校验（`efforts` 来自 `resolveModelInfo`），保存期即拒绝非法档位。
- 「跟随 Host 授权池」与「仅允许所选模型」两种模型范围语义保持不变。

## 子代理派遣

- 每预设派遣开关、默认模型、模型锁定、默认/允许思考档位和全局深度。
- 页面可把模型加入 Host 授权池，但必须由用户显式确认，且界面说明扩权影响整个 Harness；取消某个预设的勾选只影响该预设，不会悄悄收回其他预设仍在使用的全局授权。
- 显式、预设默认与继承三条路径的有效模型都经过同一授权校验，无法通过省略 provider/model 绕过限制；适配器负责最终档位验证。
- `preset_list({})` 默认返回**精简目录**：仅可派遣且已加载的预设、共享的已授权模型池与派遣规则，并给出 `catalogId` 与目录标记（`marker`、`formatVersion`、`mode:'compact'`、`sessionBound`、`parentSessionId`、`authorizationTicket:false`）。`catalogId` 只用于把后续派遣与调用记录关联，**不是授权票据**；派遣时仍实时复核授权。显式 `diagnostic:true` 返回完整诊断（含 `hostPool`、`unauthorizedModels`、不可派遣预设与目录失败）。
- `preset_dispatch({preset,task,provider?,model?,reasoning_effort?,run_in_background?,catalogId?})` 真正创建目标预设子代理。省略模型使用预设默认；无默认才继承父模型。显式 provider/model 必须成对；`catalogId` 可选，不参与授权判定。
- 前台返回子会话、结果、`runId`、`presetVersion`、`observationState` 与 routing；后台返回 jobId 并明确 `childStarted:false`（作业提交不等于子代理已启动），通过 job_output/job_kill 管理。
- 结果通过 `tool/result.meta` 写入**运行信封**（`marker:'preset-dispatch/run'`、`formatVersion:1`、runId、childSessionId、parentSessionId、callId、catalogId、observationState、observedRouting、status）。信封只供界面与资格判定使用，模型可见内容不变。
- 派遣记录区分**计划路由**与**实际观测**：实际配置只来自子会话已提交的 `request/header`；未观测到时标「计划配置」，恢复的旧记录标「历史配置，未核实实际请求」，不推断提供方内部默认强度。记录只保存元数据，不含任务、回答、推理或凭证。
- 记录写入持久化存储域 `preset_dispatch_history`（域版本保持 1，新增字段全部可选，旧记录仍可读）；内存保留最近 50 条用于列表。存储不可用时退回内存并报告原因，不影响派遣。
- 只读可见性接口 `GET /api/preset-dispatch/visibility?callId=…|childSessionId=…&parentSession=…`（要求已认证操作者）以 SSE 推送记录快照；编号必须精确绑定，记录带父会话时必须声明同一父会话；载荷只含元数据。
- 查询压缩 `compressUsedQueries` **默认关闭**：仅当开启、某次精简 `preset_list` 查询已被后续**已结算成功**的派遣证明使用、且目标节点仍是当前模型可见节点时，才按官方模式追加 `compaction/prune` 与单节点 `tool/result` 替换（只改 content）。工作结果、派遣结果与诊断目录永不压缩；失败只报告，不阻断回合。

## 权限与生命周期

- 五个固定工具模板：只读、研究检索、实现开发、测试编写、测试验证。角色提示词不能移除独立守卫。
- 叶子代理禁止再次派遣；测试编写限测试/夹具路径，测试验证禁止直接编辑。共享文件/团队层可能仍显示被守卫拒绝的工具。
- **不是完整操作系统沙箱**：目录搜索未完整过滤敏感文件，shell 脚本仍可能有副作用，依赖明确任务授权与 DSH 沙箱。不要把秘密置于可搜索工作区。
- 子代理继承工作目录和有效沙箱，审批固定 never，不继承一次性授权，拒绝替换安全服务。
- 深度使用本插件与 Host 的较严格上限。权限修改未开放模型保存工具；所有读写接口都要求 DSH Connection 的已认证操作者身份（`requestRejection` 为空），仅回环地址与同源 Origin 不足以通过——本地进程伪造 Host/Origin 也会被拒绝。
- 插件/父会话卸载取消并清理其后台任务。不要在所需子任务运行中切换 bundle。

## 冻结标识（本轮已验证候选）

工作区已有 Git 历史（本轮工作树基于 `62a5b7ad89f608c5a9e7f7221780dbf3113883b3`），本表以 SHA-256 前缀（取前 16 位小写）标识**本轮验证候选**。候选标识：v0.6.0（上一发布 v0.5.0）。升级、回退与逐条需求覆盖见 [升级与回退](<docs/05-upgrade-and-rollback.md>)。

| 文件 | 哈希前 16 位 |
|---|---|
| client.js | `5273cfcbebc8501b` |
| catalog.js | `baf1e3e948cd9df4` |
| core.js | `2decd866879995ab` |
| host.js | `08239ed1b78e4ed9` |
| management-api.js | `2dded6212d2baedd` |
| managed-presets.js | `fd92521797587a79` |
| settings-api.js | `b83ec60974f4c93d` |
| policy.js | `96c62b17f61c3538` |
| history.js | `80fefeacffe6c658` |
| role-managed.js | `791d6571041b7574` |
| roles.js | `7c8de0eb8e9a6760` |
| routing.js | `bf5e9d6b017cb3a2` |
| entry.js | `0461133659dab58e` |
| cordis.patch.yml | `ef207082a38131a5` |
| package.json | `eeb9ed0120b5c355` |
| index.js | `c483a209fff9b985` |
| scripts/check.mjs | `efcbf646ed5b1a96` |
| test/package.test.js | `4f5335f036f9bb8c` |
| generate-roles.mjs | `64a08dc937176b15` |
| save-protocol.js | `5eb05fcd971f2dcc` |
| scripts/test.mjs | `219a08de363ef2ed` |
| history-store.js | `c63791ddf9b32e5f` |
| test/history-store.test.js | `2f1bc6198f90a904` |
| catalog-cache.js | `71839cecefba433a` |
| test/catalog-cache.test.js | `3b80f5a03d158889` |
| migration-role-snapshot.json | `d27a2d85de8f09bc` |
| migration-snapshot.json | `e473b3905833242d` |
| role-plugin.js | `c6c6dead6b79c82a` |
| roles-active.js | `f4489bfd17a9e5eb` |
| roles-configured.js | `eb440fc6db4f04da` |
| roles-entry.js | `121011fb2280f7e9` |
| roles-final.js | `4313d69efebb572c` |
| roles-live.js | `106bb9fb233d5d25` |
| settings-final.js | `b5c68ba25bd2e39d` |
| test/agent-save.test.js | `98fbcfe06da3d7bb` |
| test/catalog.test.js | `c62db506cb4a89ae` |
| test/client-render.test.js | `b6d68d5fadf27080` |
| test/core.test.js | `9b1e7939c3ada2ce` |
| test/history.test.js | `2a0518e016359b4c` |
| test/managed-presets.test.js | `b02883daad8d6d29` |
| test/new-management-api.test.js | `500ee78f2b9ec67e` |
| test/policy.test.js | `26343faf1035e1a2` |
| test/roles.test.js | `ba5a92745a5cb4a7` |
| test/save-protocol.test.js | `33ab5fdea672d538` |
| scripts/pack-check.mjs | `dfca174cb6c8b294` |
| scripts/live-probe.mjs | `a7560132dca76d72` |
| scripts/storage-contract-check.mjs | `8251e2ce14ced99b` |
| screenshots.json | `b2e501308e5bc7b8` |
| dispatch-observation.js | `7308a4af133d064c` |
| query-compaction-host.js | `4311b14fc6a387b8` |
| query-compaction.js | `48890a5ec6a59a74` |
| test/context-catalog.test.js | `7f7b324abcbf9dc5` |
| test/dispatch-observation.test.js | `872e22e095b0ad13` |
| test/query-compaction-host.test.js | `8ec0088a7db9643f` |
| test/query-compaction.test.js | `f6207e11eec043b2` |
| test/visibility-api.test.js | `dab7b6cbad86c16b` |
| visibility-api.js | `59ea3dd69a495d10` |

独立验证证据见 [验证](#验证) 一节；浏览器端视觉与真机点击仍需用户在本机确认。

## 安装与更新

使用 DSH plugin_manager 操作当前 profile；本包无依赖和安装脚本，不另启 Web 服务器。

生成器只生成初始 bundle；用户修改以 profile patch 为权威，不从生成器重置角色。开发更新 Client 后需要现有 GUI 重建/刷新；没有 dev:web watcher 时不承诺无刷新更新。

**Host 侧代码的加载方式（稳定入口）**：bundle 入口固定为 `entry.js` → `host.js?stable` → 其余模块用同一个常量 `?stable` 查询串。这个查询串**不是版本号**，是为了避开长驻进程里被早期版本污染过的裸 `./host.js` 说明符。

由此产生一条必须遵守的规则：**改动任何 Host 模块后需要重启 DSH 才生效**。重新激活 bundle（禁用→启用）只会重新加载 Client 半边，不会重新导入 Host 模块。**不要再引入按改动递增的入口文件名或版本查询串**——那是之前 9 个 `manager-entry-v*.js` 与多处手工不同步的来源。`test/package.test.js` 检查 bundle 的稳定入口及主要模块的查询串。历史兼容 shim 暂时保留，不作本轮删除。四条已确认被 Loader 跳过的 profile 旧入口块已备份后定点清理，未卸载或重装插件。

`generate-roles.mjs` 是**引导工具**：它按 `migration-snapshot.json` 覆盖整个 `cordis.patch.yml`，会丢弃用户对预设与策略的修改，因此必须显式 `--force` 才运行。

### 入口与兼容文件的生命周期

| 文件 | 引用者 | 决定 |
|---|---|---|
| `entry.js` | bundle patch 的 `name: ./entry.js`、`index.js` | **保留**：唯一的 Host 稳定入口 |
| `index.js` | `package.json` 的 `exports['.']`、`exports['./host']` | **保留**：对外 API 面 |
| `role-plugin.js` | `package.json` 的 `exports['./role']` | **保留**：对外 API 面，退役会破坏使用者 |
| `role-managed.js` | bundle patch 中每个自有预设的 `role-policy` 插件 | **保留**：每个受管预设都依赖它 |
| `client.js` | `package.json` 的 `exports['./client']`、`dsh.client` 清单 | **保留**：Web 半边 |
| `settings-final.js`、`roles-active.js`、`roles-configured.js`、`roles-final.js`、`roles-live.js`、`roles-entry.js` | 无任何活动引用（bundle patch 指向 `entry.js`；profile 中曾指向 `roles-entry.js`/`roles-configured.js` 的旧行已被 Loader 的 name 断言跳过） | **已退役**：仅作历史文件保留，删除安全但无收益 |

约束（由 `test/package.test.js` 强制）：禁止再引入按改动递增的入口文件名；已退役的 shim 不得被任何模块重新 import；Host 代码改动需要重启 DSH 才生效。

### 统一门禁

`npm run verify` = `check` + `test` + `pack`，任一步失败即非零退出：

- `npm run check`：递归对全部 JS/MJS/CJS 执行 `node --check`；校验 README 冻结表与文件字节一致，并**要求表覆盖所有模块、测试与脚本**（漏列即失败）；`npm run check -- --write` 会同步哈希并补行。
- `npm run test`：单进程导入全部测试文件（`node --test` 会派生带管道的子进程，在本沙箱被拒）。
- `npm run pack`：对**真实** `npm pack --dry-run` 的结果断言——必需文件必须发布、本机引导资料与 scratch/依赖必须排除、dry run 不得留下 tarball。npm 的缓存与临时目录指向工作区内，因为本沙箱拒绝工作区外写入。

单页设计：Agent 弹窗同时承载角色与派遣设置，一次保存提交；全局设置与调用记录各自独立弹窗，互不干扰。刷新浏览器时有未保存提醒，关闭设置面板前请保存或取消。

## 验证

- `npm run check`：`scripts/check.mjs` 递归对工作区内全部 JS/MJS/CJS 模块（含历史模块、测试和检查脚本自身；排除依赖及隐藏目录）做 `node --check`，并校验 README 冻结哈希表与文件字节一致。运行 `npm run check -- --write` 可按当前文件改写哈希表，避免手工漂移。
- `npm run test`：`node --test test/*.test.js`。
- `npm run verify`：先 check 再 test；提交或发布前跑这一个就够。
- `test/package.test.js`：断言包根运行文件和发布目录与 `files` 对齐（明确排除依赖、锁文件、本机迁移快照及生成器）、声明路径存在、公共入口与 bundle 共用 `entry.js`、主入口模块不再使用递增版本查询串。生成器护栏目前是静态断言。

- `test/catalog.test.js`：目录按提供方分组、携带真实 `efforts`、单提供方失败被隔离、空分组丢弃、能力元数据缺失不致命。
- `test/save-protocol.test.js`（9 项）：所有权规则（自有可授权，外部与遗留行只能降级为中性行）、只对变化行判定、写入前的池快照、修订号必填、`operationId` 重放与异负载拒绝、指纹区分重试。
- `test/agent-save.test.js`（33 项）：用真实路由处理器驱动统一保存端点，且夹具**真实校验并递增修订号**（否则 CAS 断言没有意义）——预校验零写入、未授权模型被拒、确认扩权后按「池 → 策略」顺序写入、外部预设无法被授予权限、静态允许列表回退被拒、删除先停用再删除、删除失败后无可派遣残留、新建先中性化遗留行、新建可保存启用策略、定义与策略目标不一致被拒、修订号必填与过期拒绝、写入边界授权复核（收窄或读不到即零写入）、分项契约与待写分项、`operationId` 重放与查询、已退役端点不再注册。
- `test/policy.test.js`：新增保存期上下文校验（池子集、默认模型范围、按模型能力校验档位），并确认撤销授权后**读取**旧配置不再报错（只有保存会被拒）。
- `test/client-render.test.js`（36 项）：最小 React 钩子模拟器加载真实 client.js，覆盖——单页且不再调用退役端点；页面自带样式注入（含卡片网格规则，防止页面退化成裸 HTML）；卡片打开同时含两分区的唯一弹窗并载入已存提示词；目录中未授权模型照常列出并标记「需授权」；勾选未授权模型会阻止保存直到确认全局授权；自有预设保存同时提交定义+策略+已确认授权；**非本插件预设完全只读**（无按钮、无点击、不写入）；零写入报「未保存任何更改」且不再显示「部分已保存」；部分写入如实报告已落盘分项并保持基线修订号；恢复只提交未落盘分项并以刚读到的修订号围栏；冲突按**草稿基线**比较、显示服务器值 vs 草稿值、需按差异签名逐次确认；未完成草稿刷新后恢复（落盘内容**不含扩权确认**，主保存按钮仍锁定）；复制可命名而更新锁定 ID；200 但缺少分项契约视为结果未知；传输失败视为结果未知；重新读取成功后解除锁定；全局弹窗管理授权池/深度/失效策略清理；历史与新建入口；首次读取失败仍可重试且不会在缺失数据上打开编辑器；派遣卡片三阶段与真实观测帧；徽标仅对本插件子会话显示；身份快照冻结；预览头部徽标；V11 进入子会话与侧边栏入口（含服务缺失降级、未确认编号不显示入口、start 阶段以记录行状态为准）；插槽夹具只激活已声明插槽并释放返回的 disposer；卸载释放全部四个贡献且不再新增注册。

- `test/context-catalog.test.js`（26 项）：默认精简目录、显式全量诊断、`catalogId` 会话绑定与不可当授权票据、目录失败隔离。
- `test/dispatch-observation.test.js`（22 项）：计划与实际分离、适配器默认不猜测、高水位序号去重、变化基线永不清空（A→B→B→B 与 A→B→B→A）、继承前缀边界、投影初始化与视图稳定性。
- `test/visibility-api.test.js`（27 项）：操作者认证、编号精确绑定、载荷不含任务/回答/凭证、pending 流忽略无关更新、已结算记录首帧后关闭、订阅与流在结束、失配、卸载时释放。
- `test/query-compaction.test.js`（27 项）：资格门槛（含无结果关联阻塞）、官方替换对、失败与恢复、不重复扣减、不压缩工作结果。
- `test/query-compaction-host.test.js`（15 项）：默认关闭、按会话对象一次性追赶折叠、`agent/pre-step` 原样返回 `next()`、异常不外抛、disposer 释放两个监听。
- `test/history.test.js`（19 项）与 `test/history-store.test.js`（17 项）：字段白名单与内部行访问器、订阅广播、持久化往返与旧记录兼容。

**该模拟器不等价于浏览器**：它无法建立布局、焦点、对比度或指针行为，因此不能作为视觉与交互验收证据。

真实集成已验证：七个角色无加载异常、模型策略迁移逐项一致、临时预设创建/更新 v2/原生列表可见/删除。v0.5.0 另经实机确认：真实目录含 14 个模型 / 4 个提供方，其中授权池仅 2 个，`preset_list` 的 `unauthorizedModels` 如实列出其余 12 个，`explicitSelectionAvailable` 同时反映 Host 与插件两个开关；`/api/preset-dispatch/agent-save` 已在运行实例注册（未认证 400 + 业务 JSON），未知同级路径仍为 401；缓存清理后的工具输出为无损 JSON。

视觉截图、点击交互和完整 Host 重启验收需单独记录，不能用状态 API 通过替代。

已知独立环境警告：dsh-completion-guard 的 hostLockPackages/hostLockPlatform/hostLockProfile 注入错误不属于本插件，未修复。