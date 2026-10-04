import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePolicies, applyPresetPolicy, assertPresetRoute, assertPolicyContext, normalizePolicies } from '../policy.js';
import { gate } from '../settings-api.js';
const route={provider:'p',model:'m'};
const make=patch=>validatePolicies([{preset:'standard',enabled:true,defaultModel:route,allowedModels:[route],lockModel:true,defaultEffort:'low',allowedEfforts:['low'],...patch}])[0];
test('preset defaults applied without mutating request',()=>{const req={};assert.deepEqual(applyPresetPolicy(make(),req),{...route,reasoningEffort:'low'});assert.deepEqual(req,{});});
test('locked route rejects parent override',()=>assert.throws(()=>applyPresetPolicy(make(),{provider:'p',model:'other'}),/locked/));
test('effective route and effort must satisfy user policy',()=>{const p=make();assertPresetRoute(p,{...route,reasoningEffort:'low'});assert.throws(()=>assertPresetRoute(p,{provider:'p',model:'other',reasoningEffort:'low'}),/model/);assert.throws(()=>assertPresetRoute(p,{...route,reasoningEffort:'high'}),/effort/);});
test('locked inheritance and invalid default disallowed',()=>{assert.throws(()=>make({defaultModel:null}),/requires/);assert.throws(()=>make({defaultModel:{provider:'p',model:'other'}}),/outside/);});
test('duplicate preset and invalid efforts rejected',()=>{assert.throws(()=>validatePolicies([{preset:'x'},{preset:'x'}]),/duplicate/);assert.throws(()=>make({allowedEfforts:[1]}),/efforts/);});
const request=patch=>({method:'POST',socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:3080',origin:'http://127.0.0.1:3080','content-type':'application/json'},...patch});
test('same origin loopback JSON accepted',()=>gate(request(),'POST',{requestRejection:()=>undefined}));
test('cross site and no origin writes rejected',()=>{assert.throws(()=>gate(request({headers:{host:'127.0.0.1:3080',origin:'https://evil.test','content-type':'application/json'}}),'POST',{requestRejection:()=>undefined}),/origin/);assert.throws(()=>gate(request({headers:{host:'127.0.0.1:3080','content-type':'application/json'}}),'POST',{requestRejection:()=>undefined}),/origin/);});
test('non loopback and forged Host rejected',()=>{assert.throws(()=>gate(request({socket:{remoteAddress:'192.168.1.5'}}),'POST',{requestRejection:()=>undefined}),/Loopback/);assert.throws(()=>gate(request({headers:{host:'evil.test'}}),'POST',{requestRejection:()=>undefined}),/Host/);});
// assertPolicyContext is the save-time gate that needs the live Host pool and model
// capabilities; it is deliberately separate from validatePolicies so that loading an
// existing config can never fail because a model was withdrawn later.
const key=route=>`${route.provider}\u0000${route.model}`;
const rows=patch=>validatePolicies([{preset:'planner',modelScope:'selected',defaultModel:route,allowedModels:[route],...patch}]);
test('a preset may not select a model outside the enabled Host pool',()=>{
  const pool={enabled:true,allowedModels:[route]};
  assertPolicyContext(rows(),{hostPool:pool});
  assert.throws(()=>assertPolicyContext(rows({allowedModels:[route,{provider:'p',model:'other'}],defaultModel:route,lockModel:false}),{hostPool:pool}),/尚未在 DSH 子代理授权中启用/);
});
test('a withdrawn pool no longer constrains reading, only saving',()=>{
  assertPolicyContext(rows({allowedModels:[route,{provider:'p',model:'other'}],defaultModel:route}),{hostPool:{enabled:false,allowedModels:[]}});
});
test('the default model must stay inside what the preset can actually use',()=>{
  assert.throws(()=>assertPolicyContext(rows({modelScope:'host',allowedModels:[],defaultModel:{provider:'p',model:'other'}}),{hostPool:{enabled:true,allowedModels:[route]}}),/默认模型必须在/);
});
test('effort ids must be advertised by the chosen model',()=>{
  const capabilities=new Map([[key(route),['low','high']]]);
  assertPolicyContext(rows({defaultEffort:'high'}),{capabilities});
  assert.throws(()=>assertPolicyContext(rows({defaultEffort:'xhigh'}),{capabilities}),/不支持思考强度 xhigh/);
  assert.throws(()=>assertPolicyContext(rows({allowedEfforts:['low','ultra'],defaultEffort:'low'}),{capabilities}),/不支持思考强度 ultra/);
  // An unknown model has no capability data, so nothing is invented or rejected.
  assertPolicyContext(rows({defaultModel:{provider:'p',model:'ghost'},allowedModels:[{provider:'p',model:'ghost'}]}),{capabilities});
});
// Rows written before a field existed must read back with the value dispatch actually
// uses; otherwise the editor would display one scope and save another.
test('normalizePolicies fills the effective scope without throwing on stored rows',()=>{
  const stored=[{preset:'planner',enabled:true,defaultModel:{provider:'p',model:'m'},allowedModels:[{provider:'p',model:'m'}]}];
  assert.equal(normalizePolicies(stored)[0].modelScope,'selected','allowed models imply selected scope');
  assert.equal(normalizePolicies([{preset:'x'}])[0].modelScope,'host','a row without models follows the pool');
  assert.deepEqual(normalizePolicies([{preset:'x'}])[0],{preset:'x',enabled:false,defaultModel:null,allowedModels:[],modelScope:'host',lockModel:false,defaultEffort:null,allowedEfforts:[]});
  assert.deepEqual(normalizePolicies(null),[]);
  assert.equal(normalizePolicies([null,{noPreset:true},'junk']).length,0,'junk rows are dropped instead of throwing');
  // The normalized output must be accepted by the strict validator used on save.
  assert.deepEqual(validatePolicies(normalizePolicies(stored))[0].modelScope,'selected');
});
