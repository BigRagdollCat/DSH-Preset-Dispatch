import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
export const ROLES = {
  planner: { name:'规划架构', description:'只读规划、架构边界、方案比较与迁移风险；不实现、不执行测试。', tools:[], prompt:'分析目标、约束、所有权、接口、兼容性、并发、迁移与回滚。给出最小可行方案、风险分类、实施范围和测试/审查交接。遇到证据不足返回检索请求，不凭空设计框架。' },
  researcher: { name:'研究检索', description:'只读定位文件、符号、依赖与官方版本资料；不作代码验收。', tools:['web_search','web_fetch'], prompt:'围绕明确问题从已知路径窄范围检索。核实定义、消费者、版本和官方来源，区分静态引用与实际运行证据。网络查询仅包含公开、脱敏问题；不要上传私有代码或日志。返回已查范围、证据和未解决问题，发现所需证据后停止。' },
  investigator: { name:'根因调查', description:'只读分析症状、触发条件、根因、生命周期与跨模块因果链。', tools:[], prompt:'提出竞争假设并寻找反证。跟踪入口、状态所有权、消费者、并发、资源生命周期和失败恢复。区分事实、推断、未知、症状与根因。返回 Hypothesis、Evidence、Reproduction、Root Cause、Affected Modules、Proposed Fix、Confidence；未证实的根因写未知。' },
  reviewer: { name:'代码审查', description:'对冻结候选进行独立只读审查，关注真实缺陷、授权与回归风险。', tools:[], prompt:'确认需求、基线/候选、完整变更列表、实际差异和独立测试证据。当前源码不证明完整变更覆盖；缺关键证据返回 BLOCKED。优先报告具体缺陷，附文件行号、触发条件、机制和影响，区分缺陷与风格偏好。阅读关键断言，不能用通过摘要替代证据。审查 PASS 不是产品验收。' },
  implementer: { name:'实现开发', description:'在明确授权范围内修改生产代码；单写者，不承担独立测试验收。', tools:['write','edit','pwsh','job_output','job_kill','job_list'], prompt:'确认目标、候选、允许路径、非目标、既有改动和唯一写者。使用实际可用的 edit/write，读取后再修改，保留无关变更。根因未知时请求调查，不扩大范围。遵循项目 TDD：高风险变更等待测试编写与有效 RED，再修改生产代码。提供精确测试命令，暂停写入后交给测试验证角色；不替代其独立执行，不提交、推送、部署或清理用户资源。' },
  'test-author': { name:'测试编写', description:'仅编写测试与夹具；不修改生产代码、不运行测试。', tools:['write','edit'], prompt:'确认需求、授权测试路径和测试契约。围绕用户可观察行为编写成功、失败与边界断言，避免套实现的断言。只改测试/夹具，不能修改生产、依赖、运行器或配置。报告需求到断言映射、预期 RED 和准确执行命令，交给测试验证执行。冻结测试修改需主代理重新授权，不削弱断言。' },
  verifier: { name:'测试验证', description:'执行 RED/GREEN、回归或剩余验收门禁；不手动修改源码与测试。', tools:['pwsh','job_output','job_kill','job_list'], prompt:'确认固定候选、阶段（RED/GREEN/回归/最终门禁）、准确命令、cwd、执行所有权与已有证据。暂停写入后执行，不安装依赖或手动修改源码/测试。测试脚本生成产物不授予源文件编辑权限。真实 RED 必须收集并执行到预期失败断言；环境错误、零测试、跳过、超时不算 RED。最终门禁只执行未覆盖项，复用同候选有效证据。每个命令使用有限合理超时，记录 exit、执行/通过/失败/跳过数和关键错误；不重叠或重复正在运行的进程。' },
};
const READ = ['read','read_image','glob','grep','lsp','skill'];
export function roleTools(id) { if (!ROLES[id]) throw new Error('Unknown role'); return new Set([...READ,...ROLES[id].tools]); }
export function roleDenial(id, exec) {
  const allowed = roleTools(id);
  if (!allowed.has(exec.name)) return '职责预设禁止此工具；请向主代理返回请求。';
  const args = exec.arguments ?? {};
  const value = args.file_path ?? args.path;
  if (typeof value === 'string') {
    const parts = value.replaceAll('\\','/').split('/');
    if (parts.some(p => (/^\.env(?:\.|$)/i.test(p) && p !== '.env.example') || /^(credentials|secrets)$/i.test(p)) || /(?:^|\/)\.git\/objects(?:\/|$)/i.test(value.replaceAll('\\','/'))) return '禁止读取或修改敏感文件。';
  }
  if (id === 'test-author' && ['write','edit'].includes(exec.name)) {
    const cwd = exec.agent?.session?.header?.cwd;
    if (!cwd || typeof value !== 'string') return '测试写入需要可核实的工作目录和文件路径。';
    const target=path.resolve(cwd,value);
    if (existsSync(cwd)) {
      const realRoot=realpathSync(cwd);
      let ancestor=target;
      while (!existsSync(ancestor) && path.dirname(ancestor)!==ancestor) ancestor=path.dirname(ancestor);
      const realTarget=path.resolve(realpathSync(ancestor),path.relative(ancestor,target));
      const actualRelative=path.relative(realRoot,realTarget);
      if (actualRelative.startsWith('..') || path.isAbsolute(actualRelative)) return '测试写入禁止通过链接逃逸工作区。';
      if (realTarget!==target) return '测试写入不允许符号链接或 junction 路径。';
    }
    const relative = path.relative(cwd, target).replaceAll('\\','/');
    if (relative.startsWith('../') || path.isAbsolute(relative)) return '测试写入必须位于当前工作区。';
    if (!/(?:^|\/)(?:test|tests|__tests__|fixtures|__fixtures__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(relative) || /(?:^|\/)(?:package(?:-lock)?\.json|(?:npm|pnpm|yarn|bun).*lock[^/]*|\.(?:npmrc|yarnrc)[^/]*|[^/]*(?:config|workspace)\.[^/]+)$/i.test(relative)) return '测试编写预设仅能修改测试与夹具路径，不能修改运行器/配置。';
  }
}
export const commonPrompt = '你是职责明确的叶子代理。遵循用户语言、工作区 AGENTS.md 与更严格的授权。只能处理主代理交付的有界任务，不派遣其他代理，不改变模型/权限或重置失败预算。证据缺失返回主代理，不通过终端、插件或其他会话绕过限制。不要检查凭据或秘密。只报告实际修改与执行；未执行写 NOT_RUN，未知计数写 unknown。返回 status（PASS/FAIL/BLOCKED/ESCALATE）、task_id、candidate_id、summary、evidence、changes、tests（command/cwd/exit_code/counts/execution_status/result）、risks、unresolved、recommended_next_agent、reason。PASS 仅表示角色完成，不代表产品验收。交接后停止。';
