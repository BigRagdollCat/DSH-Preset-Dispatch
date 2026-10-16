import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, roleTools, roleDenial } from '../roles.js';
import path from 'node:path';

// 使用真实工作目录调用生产守卫；仅判断权限，不写入被测目标或执行测试脚本。
const workspaceExec = (name, file) => ({ name, arguments: { file_path: file }, agent: { session: { header: { cwd: process.cwd() } } } });
test('test author accepts Go tests beside production for write and edit', () => {
  for (const name of ['write', 'edit']) {
    for (const file of ['internal/snapshotstore/data_control_readonly_test.go', 'src/widget_test.go', path.resolve('internal/snapshotstore/data_control_readonly_test.go')]) {
      assert.equal(roleDenial('test-author', workspaceExec(name, file)), undefined, `${name}: ${file}`);
    }
  }
});
test('test author accepts explicit PowerShell test scripts for write and edit', () => {
  for (const name of ['write', 'edit']) {
    for (const file of ['scripts/test-runtime-start.ps1', 'scripts/test-pg-bootstrap.ps1', path.resolve('scripts/test-runtime-start.ps1')]) {
      assert.equal(roleDenial('test-author', workspaceExec(name, file)), undefined, `${name}: ${file}`);
    }
  }
});
test('new test naming does not allow production, runners, config or escaping paths', () => {
  for (const name of ['write', 'edit']) {
    for (const file of [
      'internal/snapshotstore/data_postgres.go', 'scripts/start-test.ps1', 'scripts/stop-test.ps1', 'scripts/init-test.ps1',
      'scripts/test.mjs', 'src/test-worker.ps1', 'src/scripts/test-worker.ps1', 'scripts/test-.ps1', 'scripts/test-runtime-start.ps1.bak',
      'scripts/test-runtime-start.ps1/worker.go', 'src/widget_test.go.bak', 'tests/package.json',
      'scripts/test-runtime.config.ps1', 'scripts/test-runtime.workspace.ps1', '.env/sample_test.go', 'secrets/sample_test.go',
      '../outside/sample_test.go', path.resolve('..', 'outside', 'scripts', 'test-runtime-start.ps1'),
    ]) {
      assert.ok(roleDenial('test-author', workspaceExec(name, file)), `${name}: ${file}`);
    }
  }
});
test('test author still requires a verifiable workspace and path', () => {
  assert.ok(roleDenial('test-author', { name: 'write', arguments: { file_path: 'src/widget_test.go' } }));
  assert.ok(roleDenial('test-author', { name: 'edit', arguments: {}, agent: { session: { header: { cwd: process.cwd() } } } }));
});
const exec=(name,file)=>({name,arguments:{file_path:file},agent:{session:{header:{cwd:'C:\\work'}}}});
test('seven distinct roles and all leaves forbid dispatch',()=>{assert.equal(Object.keys(ROLES).length,7);for(const id of Object.keys(ROLES)){assert.equal(roleTools(id).has('preset_dispatch'),false);assert.match(roleDenial(id,exec('preset_dispatch')),/禁止/);assert.match(roleDenial(id,exec('plugin_manager')),/禁止/);}});
test('read-only roles deny writers and shell',()=>{for(const id of ['planner','researcher','investigator','reviewer']) {assert.equal(roleDenial(id,exec('read','src/a.js')),undefined);assert.match(roleDenial(id,exec('write','src/a.js')),/禁止/);assert.match(roleDenial(id,exec('pwsh')),/禁止/);}});
test('test author accepts tests but rejects production, config and escapes',()=>{assert.equal(roleDenial('test-author',exec('write','tests/a.test.js')),undefined);for(const file of ['src/a.js','tests/package.json','tests/vite.config.js','tests/package-lock.json','tests/.npmrc','tests/vitest.workspace.ts','..\\tests\\a.test.js']) assert.ok(roleDenial('test-author',exec('write',file)));assert.ok(roleDenial('test-author',exec('pwsh')));});
test('sensitive paths denied but example allowed',()=>{assert.ok(roleDenial('researcher',exec('read','.env')));assert.ok(roleDenial('researcher',exec('read','src/.env.local')));assert.equal(roleDenial('researcher',exec('read','.env.example')),undefined);});
test('verifier executes without direct writes; implementation can edit',()=>{assert.equal(roleDenial('verifier',exec('pwsh')),undefined);assert.ok(roleDenial('verifier',exec('edit','src/a.js')));assert.equal(roleDenial('implementer',exec('edit','src/a.js')),undefined);});
