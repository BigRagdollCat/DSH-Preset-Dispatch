import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ROLES, commonPrompt, roleTools, roleDenial } from './roles.js?roles-v6';
const requireHost = createRequire(pathToFileURL(process.argv[1]));
const { default: z } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/schemastery')).href);
export const name = 'dispatch-role-policy';
export const inject = ['tools','systemPrompt'];
export const Config = z.object({ role: z.string().required() });
export function apply(ctx, config) {
  const role = ROLES[config.role];
  if (!role) throw new Error('Unknown dispatch role');
  ctx.systemPrompt.section({ name:'dispatch-role', order:110, text:commonPrompt+'\n\n职责：'+role.name+'\n'+role.prompt });
  const allow = roleTools(config.role);
  const globals = ctx.tools.schemas().map(t => t.name).filter(name => allow.has(name));
  if (globals.length) ctx.tools.restrict({ allow:globals });
  const owned = new Set();
  ctx.on('agent/created', ({agent}) => {
    const dispose = agent.ctx.effect(() => agent.ctx.tools.guard(exec => roleDenial(config.role, exec)), '角色执行边界');
    owned.add(dispose);
  });
  ctx.effect(() => () => { for (const dispose of owned) dispose(); owned.clear(); }, '角色守卫清理');
}
