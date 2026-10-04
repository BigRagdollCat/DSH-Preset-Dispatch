export function routingText(selection, roles, policies) {
  const eligible = Object.entries(roles).filter(([id]) => policies.find(p => p.preset === id)?.enabled !== false);
  return `子代理职责路由：\n${eligible.map(([id,r]) => id+'：'+r.description).join('\n')}\n主代理负责调度与最终验收；叶子不派遣。任务给出工作目录、范围/允许路径、候选版本、非目标、已知证据、剩余预算和验收条件。问题/只读任务不强行安排实现；实现采用单写者，测试与审查在候选冻结后进行。测试验证区分 RED/GREEN/回归/最终门禁，复用有效证据；禁止自动升级重试、改模型绕过失败或拒绝。\n模型选择：${selection?.enabled ? '从以下 Host 授权模型池中自主选择：'+selection.allowedModels.map(r=>r.provider+'/'+r.model).join('、') : '当前 Host 禁止显式模型选择，只能继承父模型。'}。先用 preset_list 查看每个预设当前策略及模型能力。一般有界实现/检索/测试优先 opencode-go/deepseek-v4.1-flash；架构/复杂根因/高风险审查可选 codex-chatgpt/gpt-6.1-sol。这不是质量或速度保证，也不是失败后的自动升级规则。档位根据风险和实际模型能力选择；不知道可用档位时省略 reasoning_effort，不猜测 max/xhigh。模型与工具权限彼此独立；选更强模型不会放宽权限。`;
}
