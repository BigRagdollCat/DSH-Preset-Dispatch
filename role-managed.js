import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { commonPrompt, roleTools, roleDenial } from './roles.js';
import { validateDefinition } from './managed-presets.js';
const req=createRequire(pathToFileURL(process.argv[1]));
const {default:z}=await import(pathToFileURL(req.resolve('@deepseek-ai/schemastery')).href);
export const name='managed-role-policy';
export const inject=['tools','systemPrompt'];
export const Config=z.object({role:z.string().required(),definition:z.any().required()});
export function apply(ctx,config){
  const d=validateDefinition(config.definition);
  ctx.systemPrompt.section({name:'dispatch-role',order:110,text:commonPrompt+'\n\n职责：'+d.name+'\n'+d.prompt});
  const allow=roleTools(config.role), globals=ctx.tools.schemas().filter(t=>allow.has(t.name)).map(t=>t.name);
  if(globals.length)ctx.tools.restrict({allow:globals});
  const owned=new Map();
  ctx.on('agent/created',({agent})=>{const dispose=agent.ctx.effect(()=>agent.ctx.tools.guard(exec=>roleDenial(config.role,exec)),'managed role guard');owned.set(agent,dispose);});
  ctx.on('agent/disposed',({agent})=>{owned.get(agent)?.();owned.delete(agent);});
  ctx.effect(()=>()=>{for(const dispose of owned.values())dispose();owned.clear();},'managed role cleanup');
}
