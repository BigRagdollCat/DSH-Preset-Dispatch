// The resident prompt keeps only the dispatch entry point and the boundary that must hold in
// every turn. Role descriptions, the authorized model pool, the fixed model recommendation, the
// handoff details and the per-preset policies moved into preset_list, which returns them on
// demand. host.js still passes the selection, the owned roles and the preset policies it
// resolved; this text no longer embeds them, so an ordinary conversation carries no routing table.
export function routingText(selection) {
  // Only the Host switch is visible here. The plugin switch is reported by the query result, so
  // this line states nothing more than the selection state it actually received.
  const modelBoundary = selection?.enabled === true
    ? ''
    : '\n当前 Host 未启用子代理模型选择授权：派遣只能继承父代理模型。';
  return `需要分工时，先调用 preset_list 查询可派遣角色及规则，再使用 preset_dispatch。主代理负责最终验收，不得绕过授权或拒绝。${modelBoundary}`;
}
