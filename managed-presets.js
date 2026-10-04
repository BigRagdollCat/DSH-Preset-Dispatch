import { createHash } from 'node:crypto';
import { ROLES, commonPrompt, roleTools } from './roles.js';
export const GROUP_ID='agent-managed-presets';
export const TEMPLATES={readonly:'只读',researcher:'研究检索',implementer:'实现开发','test-author':'测试编写',verifier:'测试验证'};
export const templateRole=t=>t==='readonly'?'planner':t;
export const revisionOf=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
export function validateDefinition(input) {
  if (!input || typeof input!=='object' || Array.isArray(input) || Object.getPrototypeOf(input)!==Object.prototype) throw new Error('Invalid preset definition');
  const {id,name,description,prompt,template}=input;
  if (typeof id!=='string'||!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)||id.length>64) throw new Error('Invalid preset id');
  if (typeof template!=='string'||!Object.hasOwn(TEMPLATES,template)) throw new Error('Invalid permission template');
  for(const [key,value,max] of [['name',name,120],['description',description,1000],['prompt',prompt,24000]]) if(typeof value!=='string'||(key==='name'&&!value.trim())||value.length>max) throw new Error('Invalid '+key);
  // `order` is the native roster position, so it is part of the definition the page edits
  // and part of the row this plugin writes back.
  const order=input.order===undefined?20:input.order;
  if(!Number.isSafeInteger(order)||order<0||order>9999) throw new Error('Invalid order');
  return {id,name:name.trim(),description,prompt,template,order,version:Number.isSafeInteger(input.version)&&input.version>0?input.version:1};
}
/** Roster position of one stored row. The registry sorts rows as
 *  `(a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id)`, so a row
 *  written before the field existed is LAST there — and must be last here too. */
export const orderOf = row => (Number.isSafeInteger(row?.config?.order) ? row.config.order : Infinity);
/** Highest concrete position in use, ignoring rows that have none. */
export const lastOrder = rows => rows.reduce((max, row) => { const order = orderOf(row); return Number.isFinite(order) ? Math.max(max, order) : max; }, 0);
export function definitionRow(input, roleEntry) {
  const d=validateDefinition(input), role=templateRole(d.template);
  const plugins=[
    {id:'tool-presentation',name:'@deepseek-ai/dsh-agent-tool-presentation',config:{mode:'native'}},
    {id:'persona',name:'@deepseek-ai/dsh-persona',config:{prefix:'你是按职责划分的子代理。模型和思考强度由主代理按用户授权选择，不能扩大你的工具权限。'}},
    {id:'agent-instructions',name:'@deepseek-ai/dsh-agent-instructions',config:{maxBytes:65536}},
    {id:'tool-fs',name:'@deepseek-ai/dsh-tool-fs'},
    {id:'tool-fs-search',name:'@deepseek-ai/dsh-tool-fs-search',config:{sampleOverCapGlobResults:false}},
    {id:'skill-filesystem',name:'@deepseek-ai/dsh-skill-filesystem'},
    {id:'tool-skill',name:'@deepseek-ai/dsh-tool-skill'},
  ];
  if(roleTools(role).has('pwsh')) plugins.push({id:'tool-pwsh',name:'@deepseek-ai/dsh-tool-pwsh'},{id:'tool-jobs',name:'@deepseek-ai/dsh-tool-jobs'});
  if(role==='researcher') plugins.push({id:'tool-web',name:'@deepseek-ai/dsh-tool-web',config:{fetch:true,searchTimeoutMs:60000}});
  plugins.push({id:'role-policy',name:roleEntry,config:{role,definition:d}});
  return {id:'preset-'+d.id,name:'@deepseek-ai/dsh-agent-preset',config:{id:d.id,name:d.name,description:d.description,order:d.order,plugins}};
}
export function definitionsFrom(rows) {
  if(!Array.isArray(rows)) throw new Error('Managed preset group unavailable');
  return rows.map(row=>{
    const role=row.config?.plugins?.find(p=>p.id==='role-policy');
    if(row.name!=='@deepseek-ai/dsh-agent-preset'||!role?.config?.definition) throw new Error('Unmanaged row in preset group');
    const d=validateDefinition(role.config.definition);
    if(row.id!=='preset-'+d.id||row.config.id!==d.id) throw new Error('Preset identity mismatch');
    // The roster position lives on the row config. A row written before the field existed
    // has none: reporting one here would make the page place it where the registry does not.
    return Number.isSafeInteger(row.config.order)?{...d,order:row.config.order}:{...d,order:undefined};
  });
}
export function initialDefinitions() {return Object.entries(ROLES).map(([id,r])=>({id,name:r.name,description:r.description,prompt:r.prompt,template:['planner','investigator','reviewer'].includes(id)?'readonly':id,version:1}));}
export function previewDefinition(d) {return {prompt:commonPrompt+'\n\n职责：'+d.name+'\n'+d.prompt,tools:[...roleTools(templateRole(d.template))]};}
export function mutateDefinitions(rows, input, {roleEntry,roster,usage=[]}) {
  const current=definitionsFrom(rows);
  if(input.revision!==revisionOf(rows)) throw new Error('Preset configuration changed since it was read; reload');
  const index=current.findIndex(d=>d.id===input.id);
  if(input.action==='delete') {
    if(index<0) throw new Error('Preset is not owned by this plugin');
    if(roster.find(r=>r.id===input.id)?.isDefault) throw new Error('Cannot delete default preset');
    if(usage.includes(input.id)) throw new Error('Preset has active sessions; close them before deleting');
    // Removing a row leaves the other positions alone: renumbering here would silently
    // move the remaining presets relative to presets this plugin does not own.
    return rows.filter((_,i)=>i!==index);
  }
  // Moving swaps the two neighbours' roster positions instead of rewriting every row, so
  // the relative position against presets outside this group is preserved. Positions that
  // are still tied (rows written before order existed) are spread out first, because a
  // swap between equal values would be invisible.
  if(input.action==='move') {
    if(index<0) throw new Error('Preset is not owned by this plugin');
    if(!['up','down'].includes(input.direction)) throw new Error('Invalid move direction');
    const visible=rows.map((row,at)=>({row,at})).sort((a,b)=>(orderOf(a.row)-orderOf(b.row))||(a.at-b.at)).map(entry=>entry.row);
    const from=visible.findIndex(row=>row.config?.id===input.id);
    const to=from+(input.direction==='up'?-1:1);
    if(to<0||to>=visible.length) return rows;
    [visible[from],visible[to]]=[visible[to],visible[from]];
    const values=visible.map(orderOf).sort((a,b)=>a-b);
    // Positions that are tied or missing (legacy rows) cannot be swapped meaningfully, so
    // they are spread out once; afterwards a move only permutes the existing values.
    const spread=values.some(value=>!Number.isFinite(value))||new Set(values).size!==values.length;
    const placed=visible.map((row,at)=>({row,order:spread?(at+1)*10:values[at]}));
    const next=placed.map(({row,order})=>orderOf(row)===order?row:{...row,config:{...row.config,order}});
    // Array order is kept equal to roster order, so the page and the native list agree.
    return next.sort((a,b)=>(orderOf(a)-orderOf(b))||String(a.config?.id).localeCompare(String(b.config?.id)));
  }
  if(!['create','update','copy'].includes(input.action)) throw new Error('Invalid action');
  let candidate=input.definition;
  if(input.action==='copy') {
    if(index<0) throw new Error('Preset is not owned by this plugin');
    candidate={...current[index],...input.definition,version:1};
  }
  const d=validateDefinition(candidate);
  if(input.action==='update') {
    if(index<0||d.id!==input.id) throw new Error('Preset id is immutable');
    d.version=current[index].version+1;
    // A row that had no position keeps its place at the end, now written explicitly.
    const keep=Number.isFinite(orderOf(rows[index]))?orderOf(rows[index]):lastOrder(rows)+10;
    return rows.map((r,i)=>i===index?definitionRow({...d,order:keep},roleEntry):r);
  }
  if(current.length>=100) throw new Error('Preset capacity exceeded');
  if(roster.some(r=>r.id===d.id)||current.some(r=>r.id===d.id)) throw new Error('Preset id already exists');
  // A created or copied preset always starts at version 1: the caller's version number
  // describes the row it came from, not the new one.
  d.version=1;
  // A new preset goes last among the owned ones: the only position that cannot displace an
  // existing choice. It can be moved afterwards.
  return [...rows,definitionRow({...d,order:lastOrder(rows)+10},roleEntry)];
}
