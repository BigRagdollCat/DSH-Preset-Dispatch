window.__ModuleLoader__.load({
  id: '@local/dsh-preset-dispatch',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // This plugin deliberately displays Chinese without changing the app locale.
    const dict = {
      title: 'Agent 管理', intro: '管理 Agent 预设的身份、权限与派遣范围；同一批预设也会出现在 DSH 原生 Agent 预设列表中。',
      loading: '正在读取配置…', retryRead: '重试读取', reload: '重新读取', saving: '正在保存…', save: '保存', cancel: '取消',
      globalOpen: '全局设置', historyOpen: '调用记录', create: '＋ 新建预设',
      ownedGroup: '本插件管理', externalGroup: '其他预设（只读）', search: '搜索名称、ID 或说明',
      noMatch: '没有匹配的预设', empty: '暂无可用预设', failed: '读取失败。请点「重试读取」再试。',
      roleSection: '预设设置', dispatchSection: '子代理派遣设置',
      name: '名称', id: '稳定 ID（创建后不可修改）', description: '简短职责说明', prompt: '详细角色提示词', template: '工具权限模板', tools: '生效的工具边界',
      allow: '允许作为子代理派遣', allowHint: '仅允许父代理调用已开启的预设。',
      scope: '模型范围', scopeHost: '跟随 Host 授权池', scopeSelected: '仅允许所选模型',
      scopeHint: '所选模型模式下，默认模型与派遣请求都必须落在勾选的模型内。',
      models: '允许使用的模型', modelSearch: '搜索模型或提供方', noModels: '模型目录为空',
      needAuth: '需授权', modelSearchEmpty: '没有匹配的模型',
      catalogFailed: '部分模型提供方读取失败：',
      defaultModel: '默认模型', inherit: '继承父代理', defaultEffort: '默认思考强度', effortAuto: '使用模型默认',
      allowedEfforts: '允许的思考强度', effortHint: '留空表示不额外限制；填写多个用逗号分隔。',
      lock: '锁定默认模型', lockHint: '开启后，父代理不能改用其他模型。',
      authorize: '同时启用 DSH 全局模型授权', authorizeHint: '所勾选的模型不在当前 DSH 子代理授权范围内。勾选后保存会扩展全局授权，可能影响其他使用子代理模型选择的入口。',
      authorizeOff: 'DSH 全局模型授权当前未启用。启用后本预设的默认模型与勾选模型才会生效。',
      poolTitle: 'DSH 子代理模型授权', poolOn: '已启用', poolOff: '未启用', poolWritable: '可在此页面修改', poolReadonly: '此 profile 中不可修改',
      poolHint: '这是整个 Harness 的子代理模型授权池。此处勾选的模型会同时影响其他使用子代理模型的入口。',
      depth: '最大派遣深度', depthHint: '默认 1 层。实际深度同时受 DSH 全局限制约束，0 表示禁止派遣。',
      orphan: '发现失效策略行', orphanHint: '这些预设已不在 DSH 预设列表中，对应策略行仍被保留。清理后不可恢复。', orphanClean: '清理失效策略',
      historyTitle: '调用记录', historyHint: '仅保留最近 50 条元数据（角色、模型、强度、时间、状态），不保存任务、回答或推理内容。记录写入本地存储，重启后仍在；中断的派遣会标记为已中断。', historyRefresh: '刷新记录', historyEmpty: '暂无调用记录',
      dispatchTitle: '派遣子代理', dispatchPreparing: '准备中', dispatchStarted: '已派遣，等待子会话', dispatchResult: '派遣结果',
      planLabel: '计划配置', actualLabel: '实际请求', planPending: '计划配置，尚未观察到实际请求', restoredUnknown: '历史配置，未核实实际请求',
      verifiedActual: '实际请求（已核实）', unknownValue: '未知', adapterDefault: '模型默认（具体值未披露）', notStarted: '未确认启动',
      childSession: '子会话', callRef: '调用', presetSnapshot: '预设快照', noArgs: '（参数未记录）',
      badgeTitle: '本插件派遣的子代理', badgeCollapsed: '展开详情', badgeUnknown: '实际配置未核实',
      dirty: '有未保存的更改', clean: '已同步', saved: '已保存并生效', savedPartial: '部分已保存', deleteTitle: '删除预设', deleteHint: '删除后关联派遣策略会保留但不能调用。默认预设、仍有活跃会话的预设会被拒绝。',
      confirmDiscard: '放弃当前未保存的更改？', confirmReload: '放弃未保存的更改并重新读取？',
      copy: '复制', remove: '删除', version: '版本', brokenPreset: '预设加载异常：', missingPreset: '该预设已不在 DSH 预设列表中（可能已被删除）。',
      source: { 'parent-explicit': '主代理指定', 'preset-default': '预设默认', 'parent-inherited': '父代理继承' },
      part: { hostPool: '全局模型授权', definition: '预设定义', policy: '派遣策略', settings: '全局设置' },
      savedParts: '已保存：', failedParts: '未保存：',
    };
    const builtins = {
      standard: ['标准代理', '通用任务预设，适合代码开发、审查与日常协作。'],
      ptc: ['程序化工具代理', '适合通过程序化工具调用组织复杂任务。'],
      minimal: ['精简代理', '轻量预设，适合职责清晰、上下文较少的独立任务。'],
      cordis: ['Cordis 插件代理', '面向 DSH 插件与 Cordis 扩展开发的预设。'],
    };
    // Visual grammar mirrors the native Agent preset section: 720px column, uppercase group heads,
    // responsive 268px card grid, card head/desc/foot, dashed creator button and a 720px dialog.
    // Internal tokens come with fallbacks so the page still renders if a token is absent.
    const css = `
.pdispatch{max-width:720px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6;padding-bottom:16px}
.pdispatch *{box-sizing:border-box}.pdispatch h2,.pdispatch h3,.pdispatch h4,.pdispatch p{margin:0}
.pdispatch .pd-title{font-size:18px;font-weight:600;margin:0}
.pdispatch .pd-intro{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:13px}
.pdispatch .pd-muted{color:var(--dsw-alias-label-secondary);font-size:12px}
.pdispatch .pd-group{display:flex;flex-direction:column;gap:10px}
.pdispatch .pd-group+.pd-group{margin-top:20px}
.pdispatch .pd-group-head{letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;font-weight:600;margin:0}
.pdispatch .pd-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:12px;margin:0;padding:0;list-style:none}
.pdispatch .pd-card{border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-xl,14px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));display:flex;flex-direction:column;transition:border-color .16s,background .16s;overflow:visible}
.pdispatch .pd-card:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.pdispatch .pd-card-broken,.pdispatch .pd-card-broken:hover{border-color:var(--dsw-alias-state-error-primary)}
.pdispatch .pd-card-main{appearance:none;font:inherit;color:inherit;text-align:left;cursor:pointer;border-radius:var(--dsw-radius-xl,14px) var(--dsw-radius-xl,14px) 0 0;background:0 0;border:0;flex:1;display:flex;flex-direction:column;gap:12px;padding:14px 16px 12px}
.pdispatch .pd-card-main:disabled{cursor:default}
.pdispatch .pd-card-main:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}
.pdispatch .pd-card-head{display:flex;align-items:flex-start;gap:12px;position:relative}
.pdispatch .pd-card-identity{flex:1;display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.pdispatch .pd-card-name{font-size:15px;font-weight:600;line-height:1.4;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pdispatch .pd-card-id{max-width:35%;flex-shrink:0;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:21px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pdispatch .pd-card-desc{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.55;margin-block:auto;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.pdispatch .pd-card-foot{border-top:.5px solid var(--dsw-alias-border-l2);display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:2px;padding:6px 10px}
.pdispatch .pd-card-help{margin-right:auto;display:flex;align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pdispatch .pd-pill{font-size:11px;line-height:18px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.pdispatch .pd-pill-on{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.pdispatch .pd-pill-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.pdispatch .pd-pill-warn{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-error-primary));border-color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-error-primary))}
.pdispatch .pd-creator{display:flex;justify-content:center;align-items:center;gap:6px;height:44px;border:1px dashed var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg,12px);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;cursor:pointer}
.pdispatch .pd-creator:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.pdispatch .pd-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pdispatch .pd-toolbar input{flex:1;min-width:160px}
.pdispatch input:not([type=checkbox]),.pdispatch select,.pdispatch textarea{width:100%;min-height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);padding:6px 10px;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.pdispatch textarea{min-height:auto;resize:vertical;line-height:1.55}
.pdispatch input::placeholder,.pdispatch textarea::placeholder{color:var(--dsw-alias-label-secondary)}
.pdispatch input:focus-visible,.pdispatch select:focus-visible,.pdispatch textarea:focus-visible,.pdispatch button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.pdispatch .pd-grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:14px}
.pdispatch .pd-field{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--dsw-alias-label-primary)}
.pdispatch .pd-field>span.pd-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.pdispatch .pd-row{display:flex;justify-content:space-between;align-items:center;gap:20px}
.pdispatch .pd-row p{font-size:12px;margin-top:3px;color:var(--dsw-alias-label-secondary)}
.pdispatch .pd-divider{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:14px;display:flex;flex-direction:column;gap:12px}
.pdispatch .pd-btn{height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.pdispatch .pd-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.pdispatch .pd-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}
.pdispatch .pd-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.pdispatch button:disabled{opacity:.45;cursor:default}
.pdispatch .pd-icon-btn{appearance:none;border:0;background:0 0;border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer;padding:5px 6px;font:inherit;font-size:12px;position:relative;display:inline-flex;align-items:center}
.pdispatch .pd-icon-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.pdispatch .pd-icon-btn:hover:after{content:attr(data-tip);position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-overlay));border-radius:var(--dsw-radius-sm,8px);padding:3px 8px;font-size:11px;line-height:17px;white-space:nowrap;pointer-events:none;opacity:1}
.pdispatch .pd-switch{position:relative;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l2);flex:0 0 auto;cursor:pointer}
.pdispatch .pd-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.pdispatch .pd-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform 120ms}
.pdispatch .pd-switch[aria-checked=true] .pd-thumb{transform:translateX(16px)}
.pdispatch .pd-models{max-height:240px;overflow:auto;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px)}
.pdispatch .pd-check{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);cursor:pointer;font-size:12px}
.pdispatch .pd-check:last-child{border-bottom:0}
.pdispatch .pd-check:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.pdispatch .pd-check input{accent-color:var(--dsw-alias-brand-primary);width:15px;height:15px;flex-shrink:0}
.pdispatch .pd-check input:disabled{cursor:default}
.pdispatch .pd-model-info{min-width:0;flex:1}
.pdispatch .pd-model-info strong{display:block;font-size:13px;font-weight:500;overflow-wrap:anywhere}
.pdispatch .pd-model-group-head{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:6px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.pdispatch .pd-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);border:.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px)}
.pdispatch .pd-error{color:var(--dsw-alias-state-error-primary)!important;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}
.pdispatch .pd-success{color:var(--dsw-alias-state-success-primary)!important;font-size:13px}
.pdispatch .pd-notice{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1)}
.pdispatch .pd-notice p{font-size:12px;color:var(--dsw-alias-label-secondary)}
.pdispatch .pd-notice-warn{border-color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-error-primary))}
.pdispatch .pd-overlay{position:fixed;inset:0;z-index:60;background:color-mix(in srgb,var(--dsw-alias-bg-base) 72%,transparent);display:flex;align-items:center;justify-content:center;padding:24px}
.pdispatch .pd-dialog{width:min(720px,100%);max-height:min(86vh,760px);display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl,14px);background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 48px rgb(0 0 0 / 28%)}
.pdispatch .pd-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:20px 20px 14px}
.pdispatch .pd-dialog-head h3{font-size:16px;font-weight:600}
.pdispatch .pd-dialog-body{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:18px;padding:0 20px 16px}
.pdispatch .pd-dialog-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:.5px solid var(--dsw-alias-border-l2)}
.pdispatch .pd-section{display:flex;flex-direction:column;gap:14px}
.pdispatch .pd-section-head{border-bottom:.5px solid var(--dsw-alias-border-l2);padding-bottom:6px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.pdispatch .pd-code{border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2);max-height:min(52vh,460px);overflow:auto;margin:0;padding:12px;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.pdispatch .pd-list{display:flex;flex-direction:column;gap:10px;margin:0;padding:0;list-style:none}
@media(max-width:640px){.pdispatch .pd-grid{grid-template-columns:1fr}.pdispatch .pd-card-id{max-width:45%}}
@media(prefers-reduced-motion:reduce){.pdispatch *{transition:none!important;animation:none!important}}
`;
    // Styles for the two surfaces that render OUTSIDE the settings page (the dispatch card in
    // the chat transcript and the read-only badge in a child session). They are injected by the
    // plugin itself rather than relying on the settings page having been opened, and they use a
    // separate `pdv-` prefix so the page stylesheet and this one cannot fight over a class.
    const viewCss = `
.pdv-card,.pdv-badge{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;box-sizing:border-box}
.pdv-card *,.pdv-badge *{box-sizing:border-box}
.pdv-card{display:flex;flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1);padding:10px 12px;margin:2px 0}
.pdv-head{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.pdv-name{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.pdv-muted{color:var(--dsw-alias-label-secondary);font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pdv-pill{font-size:11px;line-height:18px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.pdv-pill-plan{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-error-primary));border-color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-error-primary))}
.pdv-pill-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.pdv-route{display:flex;align-items:baseline;gap:8px;min-width:0}
.pdv-route-key{color:var(--dsw-alias-label-secondary);font-size:12px;flex:0 0 auto}
.pdv-route-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}
.pdv-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pdv-btn{appearance:none;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.pdv-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.pdv-details{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:6px;display:flex;flex-direction:column;gap:4px}
.pdv-detail-row{display:flex;gap:8px;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.pdv-detail-row code{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);overflow-wrap:anywhere}
.pdv-error{color:var(--dsw-alias-state-error-primary);font-size:12px;overflow-wrap:anywhere}
.pdv-pre{margin:0;max-height:220px;overflow:auto;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2);padding:8px;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.pdv-badge-wrap{display:inline-flex;flex-direction:column;gap:4px;min-width:0;max-width:100%}
.pdv-badge{display:inline-flex;align-items:center;gap:6px;max-width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:0 0;padding:0 8px;height:24px;font-size:12px;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.pdv-badge:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.pdv-badge-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pdv-badge-unknown{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-error-primary))}
@media(max-width:640px){.pdv-card{padding:8px 10px}.pdv-route-value{font-size:11px}}
`;
    const routeKey = route => JSON.stringify([route.provider, route.model]);
    return { inject: ['slots', 'locale'], apply(ctx) {
      // Chinese dictionaries for every registered language keep the page Chinese.
      for (const language of ctx.locale.getLocale().locales) ctx.effect(() => ctx.locale.register('agent-manager-zh-v3', language.id, dict), 'Agent 管理中文文案');
      const t = ctx.locale.bind('agent-manager-zh-v3');
      const source = code => dict.source[code] || code || '未知';
      const partName = code => dict.part[code] || code;
      function localError(message) {
        if (/Authenticated operator|Loopback access|Same-origin/i.test(message)) return '当前浏览器会话未通过 DSH 身份校验，请刷新页面后重试。';
        if (/changed since|revision|已在其他页面更新/i.test(message)) return '配置已在其他页面更新。请重新读取后再保存。';
        if (/Default model is outside|默认模型必须在该预设当前可用的模型范围内/i.test(message)) return '默认模型必须在允许模型名单内。';
        if (/Lock model requires/i.test(message)) return '锁定默认模型前请先选择默认模型。';
        if (/Default effort is outside|不支持思考强度/i.test(message)) return message;
        if (/尚未在 DSH 子代理授权中启用/i.test(message)) return '该模型尚未在 DSH 子代理授权中启用；请勾选「同时启用 DSH 全局模型授权」后再保存。';
        if (/至少需要勾选一个模型|Select at least one/i.test(message)) return '启用模型授权时至少要勾选一个模型。';
        if (/active sessions/i.test(message)) return '该预设仍有活跃会话，关闭相关会话后再删除。';
        if (/Cannot delete default/i.test(message)) return '默认预设不能删除。';
        if (/already exists/i.test(message)) return '该预设 ID 已存在，请换一个。';
        if (/not owned by this plugin/i.test(message)) return '该预设不由本插件管理。';
        if (/Failed to fetch|fetch failed|NetworkError/i.test(message)) return '无法连接 DSH，请检查连接后重新尝试。';
        return '操作失败：' + message;
      }
      // Drafts that outlive a failed save. Scope and privacy are deliberately narrow:
      // per browser tab (sessionStorage, gone when the tab closes), never sent to the
      // server, and never including `authorize` — a restored draft must re-confirm any
      // widening of the global model authorization instead of inheriting it.
      const DRAFT_STORE = 'preset-dispatch:drafts';
      const draftKey = (mode, source, id) => (mode === 'create' ? 'create' : mode + ':' + (source || id));
      const readDrafts = () => { try { const raw = globalThis.sessionStorage?.getItem(DRAFT_STORE); const held = raw ? JSON.parse(raw) : {}; return held && typeof held === 'object' ? held : {}; } catch { return {}; } };
      const writeDrafts = held => { try { globalThis.sessionStorage?.setItem(DRAFT_STORE, JSON.stringify(held)); } catch { /* storage unavailable: recovery simply degrades to this session */ } };
      const keepDraft = entry => { const held = readDrafts(); held[entry.key] = { ...entry, savedAt: new Date().toISOString() }; writeDrafts(held); };
      const dropDraft = key => { const held = readDrafts(); if (key in held) { delete held[key]; writeDrafts(held); } };
      const heldDraft = key => readDrafts()[key] ?? null;
      async function request(path, body) {
        const res = await fetch('/api/preset-dispatch/' + path, body === undefined ? {credentials:'same-origin'} : {method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
        const value = await res.json();
        if (!res.ok) throw new Error(value.error || res.statusText);
        return value;
      }
      // A save must tell apart "the server rejected this" (nothing was written) from
      // "the outcome is unknown" (transport or body failure): the second case still
      // requires a reload before any retry, because the write may have landed.
      async function post(path, body) {
        const res = await fetch('/api/preset-dispatch/' + path, {method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
        let value = null;
        try { value = await res.json(); } catch { value = null; }
        return { ok: res.ok, status: res.status, statusText: res.statusText, value };
      }
      const field = (label,control) => h('label',{className:'pd-field'},h('span',{className:'pd-label'},label),control);
      const sw = (label,value,change,disabled=false) => h('button',{type:'button',className:'pd-switch',role:'switch','aria-label':label,'aria-checked':value,disabled,onClick:() => change(!value)},h('span',{className:'pd-thumb'}));
      const cardId = id => h('code',{className:'pd-card-id',title:id},id);
      const uniqueRoutes = routes => {const seen=new Set();return routes.filter(route => route && !seen.has(routeKey(route)) && seen.add(routeKey(route)));};
      const presetPolicyOf = (data,id) => (data.config.presetPolicies || []).find(row => row.preset === id) || null;

      /** Which catalog model entries a checkbox list should offer, grouped and filtered. */
      const modelGroups = (data,query) => {
        const needle = query.trim().toLowerCase();
        return data.catalog.groups.map(group => ({...group,models:group.models.filter(model => !needle || (model.name + ' ' + model.model + ' ' + group.provider + ' ' + (model.description||'')).toLowerCase().includes(needle))})).filter(group => group.models.length);
      };
      const modelPicker = (data,selected,inPool,disabled,onToggle,query,setQuery) => h(React.Fragment,null,
        h('input',{value:query,'aria-label':t('modelSearch'),placeholder:t('modelSearch'),disabled:disabled||!data.catalog.groups.length,onChange:e => setQuery(e.target.value)}),
        h('div',{className:'pd-models'},(() => {
          const groups = modelGroups(data,query);
          if (!groups.length) return h('div',{className:'pd-empty'},data.catalog.groups.length ? t('modelSearchEmpty') : t('noModels'));
          return groups.map(group => h('div',{key:group.provider},
            h('div',{className:'pd-model-group-head'},group.name),
            group.models.map(model => {
              const checked = selected.some(route => routeKey(route) === routeKey(model));
              const authorized = inPool(model);
              return h('label',{className:'pd-check',key:routeKey(model)},
                h('input',{type:'checkbox',checked,disabled,onChange:() => onToggle(model,checked)}),
                h('span',{className:'pd-model-info'},h('strong',null,model.name||model.model),h('span',{className:'pd-muted'},group.provider+' / '+model.model+(model.efforts?.length?' · '+model.efforts.map(effort => effort.id).join(' / '):''))),
                !authorized && h('span',{className:'pd-pill pd-pill-warn',title:t('authorizeHint')},t('needAuth')));
            })));
        })()),
        data.catalog.failures.length ? h('p',{className:'pd-error'},t('catalogFailed')+data.catalog.failures.map(failure => failure.name+': '+failure.message).join('；')) : null);

      function Page(){
        const [data,setData]=React.useState(null),[edit,setEdit]=React.useState(null),[busy,setBusy]=React.useState(false);
        const [error,setError]=React.useState(''),[message,setMessage]=React.useState(''),[query,setQuery]=React.useState(''),[modelQuery,setModelQuery]=React.useState('');
        const [unknown,setUnknown]=React.useState(false);
        const [runs,setRuns]=React.useState(null),[runError,setRunError]=React.useState('');
        const dirty=!!(edit&&edit.dirty);
        React.useEffect(()=>{const fn=e=>{if(dirty){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',fn);return()=>window.removeEventListener('beforeunload',fn);},[dirty]);
        const openSeq=React.useRef(0),busyRef=React.useRef(false),dialogRef=React.useRef(null),restoreRef=React.useRef(null),closeRef=React.useRef(null),hadDialog=React.useRef(false),sectionRef=React.useRef(null);
        React.useEffect(()=>{busyRef.current=busy;},[busy]);
        const load=async()=>{setBusy(true);try{setData(await request('state'));setError('');setUnknown(false);}catch(e){setError(localError(e.message));}finally{setBusy(false);}};
        React.useEffect(()=>{load();},[]);
        const discard=()=>{if(edit&&edit.kind==='agent')dropDraft(draftKey(edit.mode,edit.source,edit.draft.id));};
        const close=()=>{if(busyRef.current)return;if(edit&&edit.dirty&&!window.confirm(t('confirmDiscard')))return;discard();setEdit(null);};
        closeRef.current=close;
        const reload=()=>{if(busy)return;if(dirty&&!window.confirm(t('confirmReload')))return;discard();setEdit(null);load();};
        const open=next=>{if(dirty&&!window.confirm(t('confirmDiscard')))return;setError('');setMessage('');setModelQuery('');setEdit({openId:++openSeq.current,...next});};
        const patch=p=>setEdit(e=>({...e,draft:{...e.draft,...p},dirty:true}));
        const patchPolicy=p=>setEdit(e=>({...e,draft:{...e.draft,policy:{...e.draft.policy,...p}},dirty:true}));
        const openAgent=(preset,mode)=>{
          if(!data)return;
          const policy=presetPolicyOf(data,preset?preset.id:'');
          const definition=preset?data.definitions.find(item => item.id===preset.id):null;
          // Only presets this plugin owns are editable; read-only roster cards never get here.
          if(preset&&!definition)return;
          const fresh={
            id:mode==='create'?'':(mode==='copy'?preset.id+'-copy':preset.id),
            name:mode==='copy'?preset.name+' 副本':(mode==='create'?'':preset.name),
            description:preset?(preset.description||''):'',prompt:definition?definition.prompt:'',template:definition?definition.template:'readonly',version:definition?definition.version:1,
            authorize:false,
            policy:{preset:preset?preset.id:'',enabled:policy?policy.enabled===true:false,defaultModel:policy?policy.defaultModel:null,allowedModels:policy?[...(policy.allowedModels||[])]:[],modelScope:policy?(policy.modelScope||'host'):'host',lockModel:policy?policy.lockModel===true:false,defaultEffort:policy?policy.defaultEffort:null,allowedEfforts:policy?[...(policy.allowedEfforts||[])]:[]},
          };
          // An unconfirmed save leaves a draft behind. Restore it together with the
          // versions it was bound to, and stay read-only until it is re-read or the user
          // explicitly continues: `authorize` is never restored, so a widening has to be
          // confirmed again rather than inherited from a stale draft.
          const held=heldDraft(draftKey(mode,preset?preset.id:'',fresh.id));
          open({kind:'agent',mode,source:preset?preset.id:'',dirty:mode!=='update'||!!held,
            baseDefinitionRevision:held?held.baseDefinitionRevision:data.definitionRevision,
            baseSettingsRevision:held?held.baseSettingsRevision:data.settingsRevision,
            basePoolRevision:held?held.basePoolRevision:data.hostPool.revision,
            draft:held?{...fresh,...held.draft,authorize:false}:fresh,
            restored:!!held,stale:!!held,outcome:held?(held.outcome??null):null,diffs:[],confirmed:false});
        };
        React.useEffect(()=>{
          if(!edit)return;
          if(restoreRef.current===null)restoreRef.current=document.activeElement;
          const focusables=()=>dialogRef.current?[...dialogRef.current.querySelectorAll('input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')]:[];
          const items=focusables();
          if(items.length)items[0].focus();else if(dialogRef.current)dialogRef.current.focus();
          const onKey=ev=>{
            if(ev.key==='Escape'){if(!busyRef.current)closeRef.current();return;}
            if(ev.key!=='Tab')return;
            const list=focusables();
            if(!list.length)return;
            const index=list.indexOf(document.activeElement);
            if(ev.shiftKey){if(index<=0){ev.preventDefault();list[list.length-1].focus();}}
            else if(index<0||index===list.length-1){ev.preventDefault();list[0].focus();}
          };
          document.addEventListener('keydown',onKey);
          return()=>{document.removeEventListener('keydown',onKey);};
        },[edit&&edit.openId]);
        React.useEffect(()=>{
          if(edit){hadDialog.current=true;return;}
          if(!hadDialog.current||busy)return;
          hadDialog.current=false;
          const el=restoreRef.current;restoreRef.current=null;
          const active=document.activeElement;
          if(active&&active!==document.body&&active!==document.documentElement)return;
          if(el&&typeof el.focus==='function'&&el.isConnected!==false)el.focus();
          else if(sectionRef.current){const target=sectionRef.current.querySelector('button:not([disabled]),input:not([disabled])');if(target)target.focus();}
        },[!!edit,busy]);

        const pool=data?data.hostPool:null;
        const inPool=model => !!(pool&&pool.allowedModels.some(route => routeKey(route)===routeKey(model)));
        const needsAuthorization=draft=>{
          if(!pool)return false;
          if(!pool.writable)return false;
          if(!pool.enabled)return true;
          return [...draft.policy.allowedModels,...(draft.policy.defaultModel?[draft.policy.defaultModel]:[])].some(route => !inPool(route));
        };
        const usableModels=draft=>draft.policy.modelScope==='selected'?draft.policy.allowedModels:(pool&&pool.enabled?pool.allowedModels:draft.policy.allowedModels);
        const findModel=route=>{if(!route)return null;for(const group of data.catalog.groups)for(const model of group.models)if(routeKey(model)===routeKey(route))return model;return null;};
        const effortIds=route=>{const model=findModel(route);return model?(model.efforts||[]).map(effort => effort.id):[];};
        const agentProblems=draft=>{
          const list=[];
          if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.id)) list.push('ID 只能使用小写字母、数字与连字符。');
          if(!String(draft.name||'').trim()) list.push('名称不能为空。');
          if(draft.policy.modelScope==='selected'&&!draft.policy.allowedModels.length) list.push('「仅允许所选模型」模式下至少要勾选一个模型。');
          if(draft.policy.lockModel&&!draft.policy.defaultModel) list.push('锁定默认模型前请先选择默认模型。');
          if(draft.policy.defaultModel&&!usableModels(draft).some(route => routeKey(route)===routeKey(draft.policy.defaultModel))) list.push('默认模型必须在该预设可用的模型范围内。');
          const efforts=effortIds(draft.policy.defaultModel);
          if(efforts.length&&draft.policy.defaultEffort&&!efforts.includes(draft.policy.defaultEffort)) list.push('默认思考强度不被该模型支持。');
          const outside=[...draft.policy.allowedModels,...(draft.policy.defaultModel?[draft.policy.defaultModel]:[])].filter(route => !inPool(route));
          if(outside.length&&pool&&!pool.writable) list.push('所选模型不在 DSH 授权范围内，且此 profile 无法由本页面修改全局授权。请在 DSH 子代理设置中授权。');
          if(needsAuthorization(draft)&&!draft.authorize) list.push(pool&&!pool.enabled?t('authorizeOff'):t('authorizeHint'));
          return list;
        };
        // One place decides how a save result is reported. The view is deliberately NOT
        // refreshed on a partial failure: adopting newer revisions while an unsaved draft is
        // open is exactly how a stale draft later gets committed over someone else's edit.
        // Persist an unfinished save so a refresh can still recover it. `authorize` is
        // deliberately dropped: a restored draft must re-confirm any widening.
        const draftIdOf=e=>draftKey(e.mode,e.source,e.draft.id);
        const remember=(body,outcome)=>{
          if(!edit||edit.kind!=='agent')return;
          keepDraft({key:draftIdOf(edit),mode:edit.mode,source:edit.source,draft:{...edit.draft,authorize:false},
            baseDefinitionRevision:edit.baseDefinitionRevision,baseSettingsRevision:edit.baseSettingsRevision,basePoolRevision:edit.basePoolRevision,
            outcome:outcome??null});
        };
        const forget=()=>{if(edit&&edit.kind==='agent')dropDraft(draftIdOf(edit));};
        const discardDraft=()=>{if(edit&&edit.kind==='agent')dropDraft(draftIdOf(edit));setEdit(null);setMessage('已丢弃未完成的草稿。');load();};
        // Part markers the server reports, so a retry can resume instead of starting over.
        const PART_FLAGS=[['hostPoolSaved','全局模型授权'],['definitionSaved','预设定义'],['policySaved','派遣策略'],['settingsSaved','全局设置']];
        const requestedParts=outcome=>PART_FLAGS.filter(([flag])=>outcome&&outcome.requested?outcome.requested[flag]!==false:true);
        // Consecutive partial failures must accumulate: a part that landed in an earlier
        // attempt stays landed, so the next retry never redoes it.
        const mergeOutcome=(previous,next)=>{
          if(!previous)return next;
          const merged={...next};
          for(const [flag] of PART_FLAGS)if(previous[flag]===true)merged[flag]=true;
          merged.requested={...previous.requested,...next.requested};
          merged.state=next.state||previous.state;
          merged.stateError=next.stateError||previous.stateError;
          return merged;
        };
        const buildAgentBody=(draft,mode,e,skip={})=>{
          const body={settingsRevision:e.baseSettingsRevision,operationId:newOperationId()};
          if(mode==='delete')body.definition={action:'delete',id:draft.id,revision:e.baseDefinitionRevision};
          else if(!skip.definition)body.definition={action:mode,id:e.source||draft.id,definition:{id:draft.id,name:draft.name,description:draft.description,prompt:draft.prompt,template:draft.template,version:draft.version},revision:e.baseDefinitionRevision};
          if(mode!=='delete'&&!skip.policy)body.policy={...draft.policy,preset:draft.id,enabled:draft.policy.enabled,allowedEfforts:draft.policy.allowedEfforts};
          if(mode!=='delete'&&!skip.hostPool&&draft.authorize&&needsAuthorization(draft))body.hostPool={enabled:true,allowedModels:uniqueRoutes([...pool.allowedModels,...draft.policy.allowedModels,...(draft.policy.defaultModel?[draft.policy.defaultModel]:[])]),revision:e.basePoolRevision};
          return body;
        };
        // Compare the server's current revisions with what the unfinished save was based
        // on, so a conflict is shown as an actual difference instead of a bare refusal.
        const short=value=>value===null||value===undefined?'无':String(value).slice(0,10);
        // R03 asks for the values, not just revision ids: compare what the server holds
        // now against what this draft proposes.
        const valueDiffs=fresh=>{
          const lines=[];
          if(edit.kind==='global'){
            if(fresh.config.maxDepth!==edit.draft.maxDepth)lines.push('派遣深度：服务器 '+fresh.config.maxDepth+'，草稿 '+edit.draft.maxDepth);
            const serverRows=(fresh.config.presetPolicies||[]).length,draftRows=edit.draft.policies.length;
            if(serverRows!==draftRows)lines.push('策略行数：服务器 '+serverRows+'，草稿 '+draftRows);
            return lines;
          }
          const draft=edit.draft;
          const server=(fresh.config.presetPolicies||[]).find(row=>row.preset===draft.id);
          if(server){
            if((server.enabled===true)!==(draft.policy.enabled===true))lines.push('派遣开关：服务器 '+(server.enabled?'已启用':'未启用')+'，草稿 '+(draft.policy.enabled?'已启用':'未启用'));
            if((server.allowedModels||[]).length!==draft.policy.allowedModels.length)lines.push('允许模型数：服务器 '+(server.allowedModels||[]).length+'，草稿 '+draft.policy.allowedModels.length);
            const serverDefault=(server.defaultModel&&server.defaultModel.model)||'继承';
            const draftDefault=(draft.policy.defaultModel&&draft.policy.defaultModel.model)||'继承';
            if(serverDefault!==draftDefault)lines.push('默认模型：服务器 '+serverDefault+'，草稿 '+draftDefault);
            if((server.modelScope||'host')!==draft.policy.modelScope)lines.push('模型范围：服务器 '+(server.modelScope||'host')+'，草稿 '+draft.policy.modelScope);
          }
          const definition=(fresh.definitions||[]).find(item=>item.id===draft.id);
          if(definition){
            if(definition.name!==draft.name)lines.push('名称：服务器「'+definition.name+'」，草稿「'+draft.name+'」');
            if((definition.template||'')!==draft.template)lines.push('工具模板：服务器 '+definition.template+'，草稿 '+draft.template);
          }
          return lines;
        };
        // Anything that changed since the draft was opened is a difference the user must
        // see. Changes this very save already made are excluded, so resuming does not ask
        // about its own writes — while a change made after them still does.
        const serverDiffs=fresh=>{
          const done=edit.outcome||{};
          const landed=done.state||null;
          const base={
            definitionRevision:done.definitionSaved===true&&landed?landed.definitionRevision:edit.baseDefinitionRevision,
            settingsRevision:(done.policySaved===true||done.settingsSaved===true)&&landed?landed.settingsRevision:edit.baseSettingsRevision,
            poolRevision:done.hostPoolSaved===true&&landed?(landed.hostPool?landed.hostPool.revision:edit.basePoolRevision):edit.basePoolRevision,
          };
          const list=[];
          if(String(base.definitionRevision)!==String(fresh.definitionRevision))list.push('预设定义已由其他编辑更新（'+short(base.definitionRevision)+' → '+short(fresh.definitionRevision)+'）');
          if(String(base.settingsRevision)!==String(fresh.settingsRevision))list.push('派遣策略或全局设置已更新（'+short(base.settingsRevision)+' → '+short(fresh.settingsRevision)+'）');
          if((base.poolRevision??null)!==(fresh.hostPool?fresh.hostPool.revision:null))list.push('模型授权已更新（'+short(base.poolRevision)+' → '+short(fresh.hostPool?fresh.hostPool.revision:null)+'）');
          if((done.definitionSaved===true||done.policySaved===true)&&!landed)list.push('这次保存已经写入了一部分，但界面状态未刷新，无法自动确认其后续变化。');
          return list.concat(valueDiffs(fresh));
        };
        // Resume an unfinished save: re-read first, compare, then submit only the parts
        // that did not land, fenced on the versions read now. Nothing is ever merged or
        // overwritten silently, and a widening the user did not re-confirm is not resent.
        const continueSave=async()=>{
          if(busy||!edit)return;
          setBusy(true);setError('');
          try{
            const fresh=await request('state');
            const diffs=serverDiffs(fresh);
            // The first click shows what changed; the same differences seen again are the
            // confirmation. A *new* difference changes the signature and is shown again,
            // so a change that appears after the confirmation is never silently accepted.
            const signature=diffs.join('|');
            if(diffs.length&&edit.confirmed!==signature){setEdit(e=>({...e,diffs,confirmed:signature}));setMessage('检测到其他修改：请先确认差异，再提交未完成的部分。');return;}
            const outcome=edit.outcome||{};
            const done={definition:outcome.definitionSaved===true,policy:outcome.policySaved===true,hostPool:outcome.hostPoolSaved===true};
            const body=edit.kind==='global'
              ? (()=>{const held={settingsRevision:fresh.settingsRevision,operationId:newOperationId(),maxDepth:edit.draft.maxDepth,presetPolicies:edit.draft.policies};if(edit.draft.poolDirty&&!done.hostPool)held.hostPool={enabled:edit.draft.poolEnabled,allowedModels:edit.draft.poolModels,revision:fresh.hostPool.revision};return held;})()
              : buildAgentBody(edit.draft,edit.mode,{...edit,baseSettingsRevision:fresh.settingsRevision,baseDefinitionRevision:fresh.definitionRevision,basePoolRevision:fresh.hostPool.revision},done);
            if(edit.kind==='agent'&&edit.mode==='delete'){/* a delete is resent whole: the derived policy part is idempotent */}
            if(!body.definition&&!body.policy&&!body.hostPool&&body.maxDepth===undefined&&body.presetPolicies===undefined){setEdit(null);forget();setMessage('没有剩余的步骤需要保存。');return;}
            const res=await post('agent-save',body);
            if(!res.ok){
              if(res.value&&res.value.error){setError(localError(res.value.error));return;}
              setUnknown(true);setEdit(x=>({...x,stale:true}));
              setError('服务端返回了无法解析的错误响应（结果未知）。请先「重新读取」确认状态。');
              return;
            }
            applyResult(res.value,body);
          }catch(e){
            setUnknown(true);setEdit(x=>({...x,stale:true}));
            setError(localError(e.message)+'（结果未知：请先「重新读取」确认服务端状态。');
          }finally{setBusy(false);}
        };
        // Per-part status, the recorded failures, and the differences found since — all
        // inside the dialog, with the actions that can move the save forward.
        const recoveryPanel=()=>{
          const outcome=edit.outcome,diffs=edit.diffs||[];
          return h('div',{className:'pd-notice pd-notice-warn',role:'alert'},
            h('h4',{className:'pd-card-name'},outcome?'上次保存未全部完成':'已恢复未完成的草稿'),
            outcome?h('ul',{className:'pd-list'},...requestedParts(outcome).map(([flag,label])=>h('li',{key:flag,className:outcome[flag]?'pd-muted':'pd-error'},label+'：'+(outcome[flag]?'已保存':'未保存')))):h('p',null,'这是一次未确认保存留下的草稿，绑定的是修改前的版本；请先继续保存或重新读取。'),
            outcome&&outcome.errors&&outcome.errors.length?h('ul',{className:'pd-list'},...outcome.errors.map((item,index)=>h('li',{className:'pd-error',key:index},partName(item.part)+'：'+localError(item.message)))):null,
            outcome&&outcome.stateError?h('p',{className:'pd-error'},'界面状态未刷新：'+outcome.stateError):null,
            diffs.length?h('div',null,h('p',{className:'pd-error'},'检测到其他修改：'),h('ul',{className:'pd-list'},...diffs.map((text,index)=>h('li',{className:'pd-error',key:index},text)))):null,
            h('p',{className:'pd-muted'},'「提交未完成部分」会先读取服务器当前状态，只提交未完成的部分，不会覆盖其他修改；「重新读取」会放弃这份草稿。'),
            h('div',null,
              h('button',{type:'button',className:'pd-btn',disabled:busy,onClick:reload},t('reload')),
              h('button',{type:'button',className:'pd-btn pd-primary',disabled:busy,onClick:continueSave},diffs.length?'确认差异并提交':'提交未完成部分'),
              h('button',{type:'button',className:'pd-btn',disabled:busy,onClick:discardDraft},'丢弃草稿')));
        };
        const applyResult=(result,body)=>{
          // A success response must carry the exact part contract. Anything else — an empty
          // object, an array, a bare error — is an unknown outcome, never a success.
          const flags=['hostPoolSaved','definitionSaved','policySaved','settingsSaved'];
          const known=result&&typeof result==='object'&&!Array.isArray(result)&&Array.isArray(result.errors)&&flags.every(flag=>typeof result[flag]==='boolean');
          if(!known){
            setUnknown(true);
            remember(body,null);
            setEdit(e=>e?{...e,stale:true}:e);
            setError('服务端返回了无法确认的响应（结果未知）。请先「重新读取」确认状态后再操作。');
            return;
          }
          const saved=[['hostPoolSaved','hostPool'],['definitionSaved','definition'],['policySaved','policy'],['settingsSaved','settings']].filter(([flag])=>result[flag]===true).map(([,name])=>partName(name));
          const failed=result.errors||[];
          if(!failed.length){
            forget();setEdit(null);setMessage(t('saved'));
            if(result.state)setData(result.state);else load();
            return;
          }
          const conflict=failed.some(item => item.code==='conflict'||/revision|changed since|已在其他页面更新/i.test(item.message));
          // Any incomplete save leaves the page unconfirmed: an earlier part may have
          // landed, so editing must pause until a successful read confirms the state.
          const merged=mergeOutcome(edit.outcome,result);
          setUnknown(true);
          remember(body,merged);
          setEdit(e=>e?{...e,conflict,stale:true,outcome:merged,diffs:e.diffs||[]}:e);
          const landed=PART_FLAGS.filter(([flag])=>merged[flag]===true).map(([,label])=>label);
          const head=landed.length?t('savedPartial')+'（已保存：'+landed.join('、')+'）':'未保存任何更改';
          setMessage(head+'；未保存：'+failed.map(item => partName(item.part)+'（'+localError(item.message)+'）').join('；')+(result.stateError?'（界面状态未能刷新：'+result.stateError+'）':''));
        };
        // One id per save attempt: a duplicated delivery of the same request is
        // replayed by the server instead of writing twice. It is deliberately NOT
        // reused across a retry after an unknown outcome — that retry happens only
        // after a fresh read, and must be a new operation.
        const newOperationId=()=>{const c=globalThis.crypto;return c&&typeof c.randomUUID==='function'?c.randomUUID():'op-'+Date.now().toString(16)+'-'+Math.random().toString(16).slice(2);};
        const saveAgent=async()=>{
          // A stale draft must never be retried from the still-open dialog: the result of
          // the previous attempt is unconfirmed, so the reload has to come first.
          if(edit.stale)return;
          const draft=edit.draft,mode=edit.mode;
          setBusy(true);setError('');setMessage('');
          try{
            const body=buildAgentBody(draft,mode,edit);
            const res=await post('agent-save',body);
            if(!res.ok){
              if(res.value&&res.value.error){setError(localError(res.value.error));return;}
              remember(body,null);
              setUnknown(true);setEdit(x=>({...x,stale:true}));
              setError('服务端返回了无法解析的错误响应（结果未知）。请先「重新读取」确认状态。');
              return;
            }
            applyResult(res.value,body);
          }catch(e){
            remember(buildAgentBody(draft,mode,edit),null);
            setUnknown(true);
            setEdit(x=>({...x,stale:true}));
            setError(localError(e.message)+'（结果未知：请先「重新读取」确认服务端状态，再决定是否重试。）');
          }finally{setBusy(false);}
        };
        const saveGlobal=async()=>{
          if(edit.stale)return;
          const draft=edit.draft;
          setBusy(true);setError('');setMessage('');
          try{
            const body={settingsRevision:edit.baseSettingsRevision,operationId:newOperationId()};
            if(draft.poolDirty) body.hostPool={enabled:draft.poolEnabled,allowedModels:draft.poolModels,revision:edit.basePoolRevision};
            body.maxDepth=draft.maxDepth;
            body.presetPolicies=draft.policies;
            const res=await post('agent-save',body);
            if(!res.ok){
              if(res.value&&res.value.error){setError(localError(res.value.error));return;}
              setUnknown(true);setEdit(x=>({...x,stale:true}));
              setError('服务端返回了无法解析的错误响应（结果未知）。请先「重新读取」确认状态。');
              return;
            }
            applyResult(res.value,body);
          }catch(e){
            setUnknown(true);
            setEdit(x=>({...x,stale:true}));
            setError(localError(e.message)+'（结果未知：请先「重新读取」确认服务端状态，再决定是否重试。）');
          }finally{setBusy(false);}
        };
        const openHistory=()=>{open({kind:'history'});setRuns(null);setRunError('');request('history').then(value=>setRuns(value.runs)).catch(e=>setRunError(localError(e.message)));};
        // Reordering is an immediate roster edit, not a dialog: it applies at once so the
        // list reflects the new position, and the outcome is reported on the page.
        const moveAgent=async(id,direction)=>{
          if(busy||unknown||!data)return;
          setBusy(true);setError('');setMessage('');
          try{
            const body={settingsRevision:data.settingsRevision,operationId:newOperationId(),definition:{action:'move',id,direction,revision:data.definitionRevision}};
            const res=await post('agent-save',body);
            if(!res.ok){
              if(res.value&&res.value.error){setError(localError(res.value.error));return;}
              setUnknown(true);
              setError('服务端返回了无法解析的错误响应（结果未知）。请先「重新读取」确认状态。');
              return;
            }
            applyResult(res.value,body);
          }catch(e){setUnknown(true);setError(localError(e.message)+'（结果未知：请先「重新读取」确认服务端状态。）');}
          finally{setBusy(false);}
        };
        const openGlobal=()=>open({kind:'global',dirty:false,baseSettingsRevision:data.settingsRevision,basePoolRevision:data.hostPool.revision,draft:{poolEnabled:pool.enabled,poolModels:pool.writable?[...pool.allowedModels]:[],poolDirty:false,maxDepth:data.config.maxDepth,policies:data.config.presetPolicies}});

        const title=()=>edit.kind==='history'?t('historyTitle'):edit.kind==='global'?t('globalOpen'):edit.mode==='create'?'新建 Agent 预设':edit.mode==='copy'?'复制 Agent 预设':edit.mode==='delete'?t('deleteTitle'):'编辑 Agent：'+(edit.draft.name||edit.draft.id);
        const hint=()=>edit.kind==='history'?t('historyHint'):edit.kind==='global'?'这里的改动作用于整个 Harness。':'ID 创建后不可修改；角色提示词与工具模板由用户授权；派遣设置只影响新会话，已有会话保持原版本。';

        const dialog=()=>{
          if(!edit||!data)return null;
          const body=[];let footer=null;
          if(edit.kind==='history'){
            // Each record distinguishes what was PLANNED from what a request actually observed.
            // A record without an observed request is labelled as unverified rather than being
            // shown as if the planned route had been the real one — including every record that
            // was restored from an older version, which never had the observed fields at all.
            const historyRow=(run,index)=>{
              const observed=run.observedRouting&&typeof run.observedRouting==='object'?run.observedRouting:null;
              const planned=run.plannedRouting&&typeof run.plannedRouting==='object'?run.plannedRouting:null;
              const legacy=!run.observationState&&!observed;
              const verified=!!observed;
              const route=verified?observed:(planned||run);
              const effortSource=verified?(observed.reasoningEffort?run.effortSource:'adapter-default'):run.modelSource;
              return h('li',{className:'pd-card',key:index},
                h('div',{className:'pd-card-main'},
                  h('span',{className:'pd-card-head'},h('span',{className:'pd-card-identity'},h('span',{className:'pd-card-name'},run.presetName||run.preset),h('span',{className:'pd-pill'+(verified?' pd-pill-on':''),title:verified?t('verifiedActual'):(legacy?t('restoredUnknown'):t('planPending'))},verified?t('actualLabel'):(legacy?'历史记录':t('planLabel'))),h('span',{className:'pd-pill'},String(run.status||''))),cardId(run.startedAt||'')),
                  h('span',{className:'pd-card-desc'},(route.provider||'?')+' / '+(route.model||'?')+' · '+(route.reasoningEffort||t('adapterDefault'))),
                  planned&&verified?h('span',{className:'pd-muted'},t('planLabel')+'：'+(planned.provider||'?')+' / '+(planned.model||'?')+' · '+(planned.reasoningEffort||t('unknownValue'))):null,
                  h('span',{className:'pd-muted'},(verified?t('actualLabel'):(legacy?'历史记录，未核实实际请求':t('planPending')))+'；模型：'+source(run.modelSource)+'；强度：'+source(effortSource)+(run.callId?'；调用：'+run.callId:'')+(run.childSessionId?'；子会话：'+run.childSessionId:''))));
            };
            const list=runs===null?h('div',{className:'pd-empty'},runError||t('loading')):(runs.length?h('ul',{className:'pd-list'},...runs.map(historyRow)):h('div',{className:'pd-empty'},t('historyEmpty')));
            body.push(h('div',{className:'pd-section'},h('div',{className:'pd-row'},h('span',{className:'pd-muted'},t('historyHint')),h('button',{type:'button',className:'pd-btn',disabled:busy,onClick:()=>{setRuns(null);request('history').then(value=>setRuns(value.runs)).catch(e=>setRunError(localError(e.message)));}},t('historyRefresh'))),list));
            footer=h('button',{type:'button',className:'pd-btn pd-primary',disabled:busy,onClick:close},'关闭');
          } else if(edit.kind==='global'){
            const draft=edit.draft;
            const orphans=draft.policies.filter(row => !data.presets.some(preset => preset.id===row.preset));
            const onPoolToggle = model => setEdit(e => {
              const list = e.draft.poolModels.some(route => routeKey(route) === routeKey(model)) ? e.draft.poolModels.filter(route => routeKey(route) !== routeKey(model)) : [...e.draft.poolModels, { provider: model.provider, model: model.model }];
              return { ...e, dirty: true, draft: { ...e.draft, poolDirty: true, poolModels: list } };
            });
            const onDepth = e => setEdit(x => ({ ...x, dirty: true, draft: { ...x.draft, maxDepth: Number(e.target.value) } }));
            const poolCard = h('div',{className:'pd-section'},
              h('div',{className:'pd-section-head'},t('poolTitle')),
              h('div',{className:'pd-row'},
                h('div',null,h('h4',{className:'pd-card-name'},t('poolTitle')),h('p',null,t('poolHint'))),
                sw(t('poolTitle'),draft.poolEnabled,v=>setEdit(e=>({...e,dirty:true,draft:{...e.draft,poolDirty:true,poolEnabled:v}})),busy||!pool.writable)),
              h('p',{className:'pd-muted'},(pool.enabled?t('poolOn'):t('poolOff'))+' · '+(pool.writable?t('poolWritable'):t('poolReadonly')+(pool.reason?'（'+pool.reason+'）':''))),
              modelPicker(data,draft.poolModels,()=>true,busy||!pool.writable,onPoolToggle,modelQuery,setModelQuery));
            const depthCard = h('div',{className:'pd-section'},
              h('div',{className:'pd-section-head'},t('depth')),
              h('div',{className:'pd-row'},
                h('div',null,h('h4',{className:'pd-card-name'},t('depth')),h('p',null,t('depthHint'))),
                h('div',{style:{width:88}},h('input',{type:'number',min:0,max:20,value:draft.maxDepth,'aria-label':t('depth'),disabled:busy,onChange:onDepth}))));
            body.push(poolCard,depthCard);
            if(orphans.length){
              const cleanOrphans = () => setEdit(e => ({ ...e, dirty: true, draft: { ...e.draft, policies: e.draft.policies.filter(row => !orphans.some(orphan => orphan.preset === row.preset)) } }));
              body.push(h('div',{className:'pd-notice pd-notice-warn'},
                h('h4',{className:'pd-card-name'},t('orphan')),
                h('p',null,t('orphanHint')),
                h('ul',{className:'pd-list'},...orphans.map(row=>h('li',{className:'pd-muted',key:row.preset},row.preset))),
                h('div',null,h('button',{type:'button',className:'pd-btn pd-danger',disabled:busy,onClick:cleanOrphans},t('orphanClean')))));
            }
            footer=h(React.Fragment,null,
              h('button',{type:'button',className:'pd-btn',disabled:busy,onClick:close},t('cancel')),
              edit.stale&&h('button',{type:'button',className:'pd-btn',disabled:busy,onClick:reload},t('reload')),
              h('button',{type:'button',className:'pd-btn pd-primary',disabled:busy||edit.stale||!edit.dirty,onClick:saveGlobal},t(busy?'saving':'save')));
          } else {
            const draft=edit.draft,mode=edit.mode;
            if(mode==='delete'){
              body.push(h('div',{className:'pd-notice'},h('p',null,t('deleteHint')),h('p',{className:'pd-error'},'确认删除预设 '+draft.id+'？')));
            } else {
              body.push(h('div',{className:'pd-section'},
                h('div',{className:'pd-section-head'},t('roleSection')),
                h('div',{className:'pd-grid'},
                  field(t('id'),h('input',{value:draft.id,disabled:busy||(mode!=='create'&&mode!=='copy'),onChange:e=>patch({id:e.target.value})})),
                  field(t('name'),h('input',{value:draft.name,maxLength:120,disabled:busy,onChange:e=>patch({name:e.target.value})}))),
                field(t('description'),h('textarea',{value:draft.description,maxLength:1000,rows:2,disabled:busy,onChange:e=>patch({description:e.target.value})})),
                field(t('prompt'),h('textarea',{value:draft.prompt,maxLength:24000,rows:8,disabled:busy,onChange:e=>patch({prompt:e.target.value})})),
                field(t('template'),h('select',{value:draft.template,disabled:busy,onChange:e=>patch({template:e.target.value})},...Object.entries(data.templates).map(([value,label])=>h('option',{key:value,value},label))))));
              body.push(h('div',{className:'pd-section'},
                h('div',{className:'pd-section-head'},t('dispatchSection')),
                h('div',{className:'pd-row'},h('div',null,h('h4',{className:'pd-card-name'},t('allow')),h('p',null,t('allowHint'))),sw(t('allow'),draft.policy.enabled,v=>patchPolicy({enabled:v}),busy)),
                field(t('scope'),h('select',{value:draft.policy.modelScope,disabled:busy,onChange:e=>patchPolicy({modelScope:e.target.value})},h('option',{value:'host'},t('scopeHost')),h('option',{value:'selected'},t('scopeSelected')))),
                h('p',{className:'pd-muted'},t('scopeHint')),
                h('div',null,h('span',{className:'pd-label'},t('models')),h('div',{style:{height:6}}),
                  modelPicker(data,draft.policy.allowedModels,inPool,busy,(model,checked)=>patchPolicy({modelScope:'selected',allowedModels:checked?draft.policy.allowedModels.filter(route=>routeKey(route)!==routeKey(model)):[...draft.policy.allowedModels,{provider:model.provider,model:model.model}]}),modelQuery,setModelQuery)),
                h('div',{className:'pd-grid'},
                  field(t('defaultModel'),h('select',{value:draft.policy.defaultModel?routeKey(draft.policy.defaultModel):'',disabled:busy,onChange:e=>{const match=usableModels(draft).find(route=>routeKey(route)===e.target.value);patchPolicy({defaultModel:match||null,lockModel:match?draft.policy.lockModel:false,defaultEffort:match?draft.policy.defaultEffort:null});}},h('option',{value:''},t('inherit')),...uniqueRoutes([...usableModels(draft),...(draft.policy.defaultModel?[draft.policy.defaultModel]:[])]).map(route=>h('option',{key:routeKey(route),value:routeKey(route)},(findModel(route)?.name||route.model)+' · '+route.provider)))),
                  field(t('defaultEffort'),h('select',{value:draft.policy.defaultEffort||'',disabled:busy||!draft.policy.defaultModel,onChange:e=>patchPolicy({defaultEffort:e.target.value||null})},h('option',{value:''},t('effortAuto')),...[...new Set([...effortIds(draft.policy.defaultModel),...(draft.policy.defaultEffort?[draft.policy.defaultEffort]:[])])].map(id=>h('option',{key:id,value:id},id))))),
                h('div',{className:'pd-row'},h('div',null,h('h4',{className:'pd-card-name'},t('lock')),h('p',null,t('lockHint'))),sw(t('lock'),draft.policy.lockModel,v=>patchPolicy({lockModel:v}),busy||!draft.policy.defaultModel)),
                field(t('allowedEfforts'),h('input',{value:draft.policy.allowedEfforts.join(', '),disabled:busy||!draft.policy.defaultModel,placeholder:'例如 low, medium, high',onChange:e=>patchPolicy({allowedEfforts:e.target.value.split(/[,，]/).map(v=>v.trim()).filter(Boolean)})})),
                h('p',{className:'pd-muted'},t('effortHint')),
                needsAuthorization(draft)?h('div',{className:'pd-notice pd-notice-warn'},
                  h('label',{className:'pd-check',style:{border:0,padding:0}},
                    h('input',{type:'checkbox',checked:draft.authorize,disabled:busy,onChange:e=>patch({authorize:e.target.checked})}),
                    h('span',{className:'pd-model-info'},h('strong',null,t('authorize')),h('span',{className:'pd-muted'},t('authorizeHint'))))):null,
                agentProblems(draft).length?h('ul',{className:'pd-list'},...agentProblems(draft).map((problem,index)=>h('li',{className:'pd-error',key:index},'· '+problem))):null));
            }
            footer=h(React.Fragment,null,
              h('button',{type:'button',className:'pd-btn',disabled:busy,onClick:close},t('cancel')),
              edit.stale&&h('button',{type:'button',className:'pd-btn',disabled:busy,onClick:reload},t('reload')),
              mode==='delete'
                ? h('button',{type:'button',className:'pd-btn pd-danger',disabled:busy||edit.stale,onClick:saveAgent},t(busy?'saving':'确认删除'))
                : h('button',{type:'button',className:'pd-btn pd-primary',disabled:busy||edit.stale||agentProblems(draft).length>0,onClick:saveAgent},t(busy?'saving':'save')));
          }
          // A refusal that never reached the save contract (a 400, a gate rejection) used to
          // be reported only on the page — behind the overlay, where the user cannot see it.
          // Whenever the dialog is open, the reason belongs inside it.
          if(error&&!edit.outcome) body.push(h('div',{className:'pd-notice pd-notice-warn',role:'alert'},h('p',{className:'pd-error'},error)));
          if(edit.outcome||edit.restored||edit.stale) body.push(recoveryPanel());
          return h('div',{className:'pd-overlay',onMouseDown:ev=>{if(ev.target===ev.currentTarget)close();}},
            h('div',{className:'pd-dialog',ref:dialogRef,tabIndex:-1,role:'dialog','aria-modal':'true','aria-label':title()},
              h('div',{className:'pd-dialog-head'},h('div',null,h('h3',null,title()),h('p',{className:'pd-muted'},hint())),h('button',{type:'button',className:'pd-icon-btn',disabled:busy,onClick:close,'aria-label':'关闭'},'✕')),
              h('div',{className:'pd-dialog-body'},...body),
              h('div',{className:'pd-dialog-foot'},footer)));
        };

        // Mirrors the registry exactly: `(a.order ?? Infinity) - (b.order ?? Infinity) ||
        // a.id.localeCompare(b.id)`, so a row without a position is last in both places.
        const byOrder=(a,b)=>(Number.isSafeInteger(a.order)?a.order:Infinity)-(Number.isSafeInteger(b.order)?b.order:Infinity)||String(a.id).localeCompare(String(b.id));
        const owned=data?data.definitions.filter(definition => (definition.id+definition.name+definition.description).toLowerCase().includes(query.toLowerCase())).sort(byOrder):[];
        const external=data?data.external.filter(preset => (preset.id+(preset.name||'')+(preset.description||'')).toLowerCase().includes(query.toLowerCase())):[];
        const summary=id=>{
          const policy=presetPolicyOf(data,id);
          if(!policy||!policy.enabled)return '派遣：未启用';
          const parts=[];
          if(policy.defaultModel)parts.push((findModel(policy.defaultModel)?.name||policy.defaultModel.model)+(policy.defaultEffort?' · '+policy.defaultEffort:''));
          parts.push(policy.modelScope==='selected'?(policy.allowedModels.length+' 个模型'):'跟随授权池');
          return '派遣：已启用 · '+parts.join(' · ');
        };
        const ownedCard=definition=>h('li',{className:'pd-card',key:definition.id},
          h('button',{type:'button',className:'pd-card-main',disabled:busy||unknown,onClick:()=>openAgent({id:definition.id,name:definition.name,description:definition.description},'update'),'aria-label':'编辑 Agent '+definition.name},
            h('span',{className:'pd-card-head'},h('span',{className:'pd-card-identity'},h('span',{className:'pd-card-name'},definition.name),data.templates[definition.template]!==definition.name?h('span',{className:'pd-pill'},data.templates[definition.template]):null),cardId(definition.id)),
            h('span',{className:'pd-card-desc'},definition.description||'（无说明）')),
          h('div',{className:'pd-card-foot'},h('span',{className:'pd-card-help'},'v'+definition.version+' · '+summary(definition.id)),
            h('button',{type:'button',className:'pd-icon-btn','data-tip':'上移','aria-label':'上移 '+definition.name,disabled:busy||unknown||definition.id===owned[0]?.id,onClick:()=>moveAgent(definition.id,'up')},'↑'),
            h('button',{type:'button',className:'pd-icon-btn','data-tip':'下移','aria-label':'下移 '+definition.name,disabled:busy||unknown||definition.id===owned[owned.length-1]?.id,onClick:()=>moveAgent(definition.id,'down')},'↓'),
            h('button',{type:'button',className:'pd-icon-btn','data-tip':t('copy'),disabled:busy||unknown,onClick:()=>openAgent({id:definition.id,name:definition.name,description:definition.description},'copy')},t('copy')),
            h('button',{type:'button',className:'pd-icon-btn','data-tip':t('remove'),disabled:busy||unknown,onClick:()=>openAgent({id:definition.id,name:definition.name,description:definition.description},'delete')},t('remove'))));
        // Presets this plugin does not own are read-only here: no click target, no editor.
        const externalCard=preset=>{const name=builtins[preset.id]?.[0]||preset.name||preset.id,description=builtins[preset.id]?.[1]||preset.description||'由 DSH 或其他插件管理，本页只读。';return h('li',{className:'pd-card'+(preset.broken?' pd-card-broken':''),key:preset.id},
          h('div',{className:'pd-card-main'},
            h('span',{className:'pd-card-head'},h('span',{className:'pd-card-identity'},h('span',{className:'pd-card-name'},name),preset.isDefault&&h('span',{className:'pd-pill pd-pill-on'},'默认'),preset.broken&&h('span',{className:'pd-pill pd-pill-error'},'加载异常')),cardId(preset.id)),
            h('span',{className:'pd-card-desc'},description)),
          h('div',{className:'pd-card-foot'},h('span',{className:'pd-card-help'},'只读')));};
        return h('section',{className:'pdispatch',ref:sectionRef},
          h('style',null,css),
          h('h2',{className:'pd-title'},t('title')),
          h('p',{className:'pd-intro'},t('intro')),
          error&&h('p',{className:'pd-error',role:'alert'},error),message&&h('p',{className:'pd-success',role:'status'},'✓ '+message),
          unknown&&h('div',{className:'pd-notice pd-notice-warn',role:'alert'},
            h('h4',{className:'pd-card-name'},'配置状态待确认'),
            h('p',null,'上次保存未全部完成，或请求未确认送达，服务端可能已经有部分写入。为避免在未确认的状态上继续编辑，请先「重新读取」成功后再操作。'),
            h('div',null,h('button',{type:'button',className:'pd-btn',disabled:busy,onClick:reload},t('reload')))),
          h('div',{className:'pd-toolbar'},
            h('input',{'aria-label':t('search'),placeholder:t('search'),value:query,disabled:busy||!data,onChange:e=>setQuery(e.target.value)}),
            h('button',{type:'button',className:'pd-btn',disabled:busy||!data||unknown,onClick:openGlobal},t('globalOpen')),
            h('button',{type:'button',className:'pd-btn',disabled:busy||!data,onClick:openHistory},t('historyOpen')),
            h('button',{type:'button',className:'pd-btn',disabled:busy,onClick:reload},data?t('reload'):t('retryRead'))),
          h('button',{type:'button',className:'pd-creator',disabled:busy||!data||unknown,onClick:()=>openAgent(null,'create')},t('create')),
          !data?h('div',{className:'pd-empty'},error?t('failed'):t('loading')):h(React.Fragment,null,
            h('section',{className:'pd-group'},h('h3',{className:'pd-group-head'},t('ownedGroup')+'（'+data.definitions.length+'）'),
              owned.length?h('ul',{className:'pd-cards'},...owned.map(ownedCard)):h('div',{className:'pd-empty'},t('noMatch'))),
            h('section',{className:'pd-group'},h('h3',{className:'pd-group-head'},t('externalGroup')),
              h('ul',{className:'pd-cards'},...external.map(externalCard)))),
          dialog());
      }
      // ---------------------------------------------------------------------------------------
      // Phase B: the dispatch card, the child-session badge and their shared data helpers.
      //
      // Everything below reads only public slot props and the plugin's own metadata route. It
      // imports no Harness Client package and never asks the model for anything: the card and
      // the badge show what the dispatch already recorded, and a live update arrives over the
      // visibility stream instead of a poll.
      // ---------------------------------------------------------------------------------------
      const parseArgsRaw = raw => { try { const value = JSON.parse(raw); return value && typeof value === 'object' ? value : null; } catch { return null; } };
      const sourceText = code => dict.source[code] || code || t('unknownValue');
      /** Route text for a narrow surface; never invents a value it was not given. */
      const routeLine = (route, source) => {
        if (!route || (!route.provider && !route.model)) return t('unknownValue');
        const head = route.provider && route.model ? route.provider + ' / ' + route.model : (route.model || route.provider);
        const effort = route.reasoningEffort || (source === 'adapter-default' ? t('adapterDefault') : t('unknownValue'));
        return head + ' · ' + effort + '（' + sourceText(source) + '）';
      };
      const statusText = status => ({ pending: '准备中', running: '运行中', completed: '已完成', failed: '失败', aborted: '已取消', interrupted: '已中断', killed: '已终止' })[status] || String(status ?? t('unknownValue'));
      /**
       * The read-only visibility request for one dispatch record.
       *
       * The endpoint binds a record to its parent session, so `parentSession` is sent whenever it
       * is known: without it a normal card is refused (403) rather than served. `bound` reports
       * whether it could be stated at all — a surface that cannot name the parent must say the
       * configuration is unverified instead of implying the lookup was complete.
       */
      const visibilityUrl = ids => {
        const query = [];
        for (const key of ['parentSession', 'callId', 'childSessionId']) if (ids && ids[key]) query.push(key + '=' + encodeURIComponent(ids[key]));
        return '/api/preset-dispatch/visibility?' + query.join('&');
      };
      /**
       * Follow one dispatch record over SSE. Returns a disposer; the stream is closed as soon as
       * a settled status arrives, so nothing keeps a socket open for a finished run.
       */
      const openVisibilityStream = (ids, onFrame, onGap) => {
        const stream = globalThis.EventSource;
        if (typeof stream !== 'function') { onGap?.('no-event-source'); return () => {}; }
        let source = null;
        try { source = new stream(visibilityUrl(ids)); } catch { onGap?.('open-failed'); return () => {}; }
        const settle = payload => {
          const status = payload?.status;
          if (status === 'completed' || status === 'failed' || status === 'aborted' || status === 'interrupted' || status === 'killed') {
            try { source.close(); } catch { /* already closed */ }
          }
        };
        source.addEventListener('snapshot', event => { try { const payload = JSON.parse(event.data); onFrame(payload); settle(payload); } catch { /* a malformed frame is ignored */ } });
        // `pending` means nothing is recorded yet; it is reported, never rendered as a fact.
        source.addEventListener('pending', () => onFrame(null));
        source.addEventListener('error', () => onGap?.('stream-error'));
        return () => { try { source.close(); } catch { /* already closed */ } };
      };
      /**
       * Follow one run while a component is mounted; a failed stream degrades to metadata only.
       *
       * The stream is only opened once the record is addressable and bound: without a call id or a
       * child session id the endpoint has nothing to look up, and without the parent session it
       * refuses the request outright, so a stream opened for either case could only be rejected.
       * `unbound` reports that the parent session could not be stated — a known gap the surface
       * discloses instead of hiding behind an apparently complete lookup.
       */
      const useVisibility = (ids, enabled) => {
        const [row, setRow] = React.useState(null);
        const [gap, setGap] = React.useState(false);
        const addressable = !!(ids && (ids.callId || ids.childSessionId));
        const unbound = addressable && !ids.parentSession;
        const key = [ids?.parentSession || '', ids?.callId || '', ids?.childSessionId || ''].join('|');
        React.useEffect(() => {
          setRow(null); setGap(false);
          // A dispatch record is bound to the session that dispatched it, so a request that cannot
          // state the parent session is refused rather than served. Such a frame never arrives, so
          // no stream is opened for it: the surface discloses the unverified value instead of
          // holding a socket that can only be rejected.
          if (!enabled || !addressable || unbound) return undefined;
          let disposed = false;
          const dispose = openVisibilityStream(ids, payload => { if (!disposed) setRow(payload); }, () => { if (!disposed) setGap(true); });
          return () => { disposed = true; dispose(); };
        }, [key, enabled]);
        return { row, gap, unbound };
      };
      const detailRow = (label, value, mono) => h('div',{className:'pdv-detail-row',key:label+String(value)},h('span',null,label),mono?h('code',null,String(value)):h('span',null,String(value)));
      const metaOf = block => (block && typeof block.meta === 'object' && block.meta !== null ? block.meta : null);
      const contentText = block => {
        const blocks = Array.isArray(block?.content) ? block.content : [];
        return blocks.map(item => (typeof item?.text === 'string' ? item.text : '')).join('\n').trim();
      };
      /**
       * Read one navigation service through the composition (`ctx.get`), never from a property on
       * the context: the services are optional composition members, so an absent one hides its
       * entry point instead of failing the card.
       */
      const navService = name => { try { return ctx.get(name) ?? null; } catch { return null; } };
      /**
       * The child session id this card may navigate to, or null when nothing is confirmed yet.
       *
       * Only a session that actually started is navigable: the recorded metadata confirms it with
       * `child.started === true`, and a running card takes the id from a visibility frame. A frame
       * is only proof once its `observationStatus` says the child was created, was observed
       * committing a request, or finished — the reserved id exists before the child does, so a
       * frame that still reports `pending` (or reports nothing at all) is not a start. A background
       * dispatch that reserved an id but reported `started: false`, a result envelope without
       * `child`, and the preparing phase all leave this null, so no entry point is offered for a
       * session that may never exist. A metadata id that is not confirmed is not used either — the
       * frame, which reports the session a run really started, is the authority then.
       */
      const confirmedChildSession = (meta, row) => {
        const recorded = meta?.child ?? null;
        if (recorded && recorded.started === true && typeof recorded.sessionId === 'string' && recorded.sessionId) return recorded.sessionId;
        const fromFrame = row?.childSessionId;
        if (typeof fromFrame !== 'string' || !fromFrame) return null;
        const state = row?.observationStatus;
        return state === 'created' || state === 'observed' || state === 'finished' ? fromFrame : null;
      };
      /**
       * The two navigation entry points for a confirmed child session.
       *
       * Both services are looked up during render (never from a stored reference), and rendering
       * itself navigates nowhere: each button only calls its own service when it is clicked. When a
       * service is missing only that button is hidden, so the other entry point stays usable.
       */
      const childNavActions = childSessionId => {
        if (!childSessionId) return null;
        const workspace = navService('uiWorkspace');
        const sidebar = navService('sidebarRight');
        const buttons = [];
        if (workspace && typeof workspace.openSession === 'function') {
          buttons.push(h('button',{type:'button',className:'pdv-btn',key:'enter-child',onClick:() => workspace.openSession(childSessionId)},'进入子会话'));
        }
        if (sidebar && typeof sidebar.openResource === 'function') {
          buttons.push(h('button',{type:'button',className:'pdv-btn',key:'open-sidebar',
            onClick:() => sidebar.openResource('dsh-resource://subagentchat/session/' + childSessionId, { kind: 'subagentchat', preferNewPane: true })},'在侧边栏打开'));
        }
        return buttons.length ? h('div',{className:'pdv-actions',key:'child-nav'},...buttons) : null;
      };

      /**
       * The `preset_dispatch` tool call row. Three phases are rendered from the phase props
       * alone: preparing has no arguments yet, start has the dispatched arguments, and result
       * adds the persisted presentation meta, the outcome and the inspection entry point.
       */
      function DispatchCard(props) {
        const { phase, block, useDisclosure, inspect } = props;
        const disclosure = typeof useDisclosure === 'function' ? useDisclosure() : { expanded: false, toggle() {} };
        const args = phase === 'preparing' ? null : parseArgsRaw(phase === 'start' ? block?.argsRaw : block?.call?.argsRaw);
        // The persisted dispatch envelope is read from the start phase on: a real start block often
        // carries none, so every read below falls back to the arguments and to the record row.
        const meta = phase === 'preparing' ? null : metaOf(block);
        const presetId = args?.preset ?? meta?.preset ?? null;
        const ids = {
          parentSession: meta?.parentSessionId ?? meta?.parentSession ?? props.parentSession ?? props.sessionId ?? null,
          callId: meta?.callId ?? meta?.call?.id ?? props.callId ?? null,
          childSessionId: meta?.childSessionId ?? meta?.child?.sessionId ?? null,
        };
        const { row, gap, unbound } = useVisibility(ids, phase !== 'preparing');
        /**
         * The identity THIS run recorded, frozen at the first value the record row stated.
         *
         * A name and a version belong to one dispatch: a later frame may carry a rename or a
         * re-defined preset, which describes a later preset definition rather than this dispatch.
         * The ref is keyed by the run's own identifiers, so a card surface that moves on to another
         * dispatch takes that run's record instead of keeping this one's frozen value.
         */
        const identity = React.useRef({ key: null, name: null, version: null });
        const identityKey = [ids.parentSession ?? '', ids.callId ?? '', ids.childSessionId ?? ''].join('|');
        if (identity.current.key !== identityKey) identity.current = { key: identityKey, name: null, version: null };
        if (identity.current.name === null && typeof row?.presetName === 'string' && row.presetName !== '') identity.current.name = row.presetName;
        if (identity.current.version === null && row?.presetVersion !== null && row?.presetVersion !== undefined) identity.current.version = row.presetVersion;
        // A result keeps the dispatch-time envelope and fills only a field the envelope does not
        // carry from the record row; a running card takes the record row first and falls back to the
        // envelope until the row states a value. Both then fall back to the dispatched preset id.
        const presetName = phase === 'result'
          ? (meta?.presetName ?? identity.current.name ?? presetId ?? t('dispatchTitle'))
          : (identity.current.name ?? meta?.presetName ?? presetId ?? t('dispatchTitle'));
        const presetVersion = phase === 'result'
          ? (meta?.presetVersion ?? identity.current.version ?? null)
          : (identity.current.version ?? meta?.presetVersion ?? null);
        // The stream payload names the planned routing `planned`; the persisted snapshot calls it
        // `plan`. A live row wins, because it is the record this run actually wrote.
        const planned = row?.planned ?? (meta?.plan ? { ...meta.plan } : null);
        const observed = row?.observed ?? meta?.observedRouting ?? null;
        const verified = observed !== null && observed !== undefined;
        // The record row is authoritative for the outcome whenever one exists: a start-phase card
        // whose run already failed, was cancelled or finished must show that, not the "dispatched,
        // waiting for the child" wording that only describes a run with nothing recorded yet.
        const status = phase === 'preparing'
          ? t('dispatchPreparing')
          : (row?.status !== null && row?.status !== undefined
            ? statusText(row.status)
            : (phase === 'start' ? t('dispatchStarted') : statusText(meta?.run?.status ?? meta?.status)));
        const failed = phase === 'result' && block?.isError === true;
        const errorReason = block?.error?.reason || block?.error?.code || null;
        // The actual-request row is rendered from the start phase on: a submitted task has not been
        // observed yet, so it says so instead of showing nothing, and a stream frame replaces it the
        // moment the child's own committed request is known.
        const actualRow = () => h('div',{className:'pdv-route',key:'actual'},
          h('span',{className:'pdv-route-key'},t('actualLabel')),
          h('span',{className:'pdv-route-value',title:verified?routeLine(observed,row?.observedEffortSource):t('planPending')},
            verified ? routeLine(observed,row?.observedEffortSource) : (row?.restored ? t('restoredUnknown') : t('planPending'))));
        const body = [];
        body.push(h('div',{className:'pdv-head',key:'head'},
          h('span',{className:'pdv-name',title:String(presetName)},String(presetName)),
          presetId && presetId !== presetName ? h('span',{className:'pdv-muted',title:String(presetId)},String(presetId)) : null,
          presetVersion !== null && presetVersion !== undefined ? h('span',{className:'pdv-pill'},t('version')+' '+String(presetVersion)) : null,
          h('span',{className:'pdv-pill'+(failed?' pdv-pill-error':phase==='result'?'':' pdv-pill-plan'),key:'status'},failed?'失败':status),
          phase==='start' ? h('span',{className:'pdv-muted'},t('planPending')) : null));
        if (phase !== 'preparing') {
          body.push(h('div',{className:'pdv-route',key:'plan'},
            h('span',{className:'pdv-route-key'},t('planLabel')),
            h('span',{className:'pdv-route-value',title:routeLine(planned, planned?.modelSource)},routeLine(planned, planned?.modelSource))));
          body.push(actualRow());
          // A lookup that cannot state the parent session is refused by the endpoint, so the
          // unverified actual value is disclosed as such instead of reading as a complete answer.
          if (unbound) body.push(h('p',{className:'pdv-muted',key:'unbound'},'未提供父会话，实时状态未核实：实际请求无法与本次派遣绑定。'));
          if (gap) body.push(h('p',{className:'pdv-muted',key:'gap'},'实时状态不可用，以下为已记录元数据。'));
        }
        if (phase === 'result') {
          const text = contentText(block);
          body.push(h('div',{className:'pdv-actions',key:'actions'},
            h('button',{type:'button',className:'pdv-btn',onClick:disclosure.toggle,'aria-expanded':disclosure.expanded===true},disclosure.expanded?'收起详情':'展开详情'),
            typeof inspect === 'function' ? h('button',{type:'button',className:'pdv-btn',onClick:inspect},'在轨迹中查看') : null,
            failed ? h('span',{className:'pdv-error'},'错误'+(errorReason?'：'+errorReason:'')) : null));
          if (disclosure.expanded) {
            const details = [];
            details.push(detailRow(t('callRef'), ids.callId ?? t('unknownValue'), true));
            details.push(detailRow(t('childSession'), ids.childSessionId ?? t('notStarted'), true));
            if (meta?.child?.jobId) details.push(detailRow('后台作业', meta.child.jobId, true));
            if (row?.verificationDetail) details.push(detailRow('核实', row.verificationDetail, false));
            body.push(h('div',{className:'pdv-details',key:'details'},
              ...details,
              text ? h('pre',{className:'pdv-pre',key:'content'},text) : h('p',{className:'pdv-muted',key:'nocontent'},'（无文本结果）')));
          }
        }
        if (phase === 'start') body.push(h('p',{className:'pdv-muted',key:'started'},'任务已提交；实际模型与思考强度以子会话的首个请求为准。'));
        // Navigation is offered from the start phase on, but only once a child session is really
        // confirmed: the preparing phase has no dispatch at all, and an unconfirmed child has no
        // session to enter.
        if (phase !== 'preparing') body.push(childNavActions(confirmedChildSession(meta,row)));
        return h('div',{className:'pdv-card'},h('style',null,viewCss),...body);
      }

      /**
       * The read-only badge appended to a child session's composer, or to its header when no
       * composer is rendered.
       *
       * It is shown only for a subagent session whose own projection exists AND whose dispatch
       * record this plugin actually holds: a session that merely has a preset id is not proof
       * that this plugin created it. A record without an observed request is labelled as such
       * rather than being presented as the real configuration.
       */
      function ChildBadge(props) {
        const { sessionId, useProjection } = props;
        let route = null;
        if (typeof useProjection === 'function') { try { route = useProjection('presetDispatchRoute'); } catch { route = null; } }
        const isChild = route !== null && route !== undefined && route.origin === 'subagent' && typeof route.agentPreset === 'string' && route.agentPreset !== '';
        // The parent session comes from the child's own projection header (or the slot props when
        // the surface is rendered inside the dispatching session). The endpoint binds a record to
        // its parent, so it is sent whenever it is known; `unbound` marks the case where it is not.
        const parentSession = props.parentSession ?? route?.parentSession ?? null;
        const { row, gap, unbound } = useVisibility({ childSessionId: sessionId, parentSession }, isChild);
        const [open, setOpen] = React.useState(false);
        if (!isChild) return null;
        // No record yet, or a stream that never answered: show nothing rather than a guess.
        if (!row || row.pending === true) return null;
        const observed = row.observed ?? null;
        const verified = observed !== null && observed !== undefined;
        const name = row.presetName || row.preset || route.agentPreset;
        const short = [name, observed?.model || row.planned?.model || null, observed?.reasoningEffort || null].filter(Boolean).join(' · ');
        const detail = [
          t('planLabel') + '：' + routeLine(row.planned, row.planned?.modelSource),
          t('actualLabel') + '：' + (verified ? routeLine(observed, row.observedEffortSource) : (row.restored ? t('restoredUnknown') : t('planPending'))),
          t('presetSnapshot') + '：' + String(row.preset ?? route.agentPreset) + (row.presetVersion === null || row.presetVersion === undefined ? '' : ' · v' + String(row.presetVersion)),
          t('childSession') + '：' + String(sessionId ?? ''),
          row.verification || '',
          unbound ? '未提供父会话，实际请求未核实。' : '',
        ].filter(Boolean);
        return h('span',{className:'pdv-badge-wrap'},
          h('style',null,viewCss),
          h('button',{type:'button',className:'pdv-badge','aria-expanded':open===true,title:short,onClick:()=>setOpen(value=>!value)},
            h('span',{className:'pdv-badge-text'},short),
            verified ? null : h('span',{className:'pdv-badge-unknown'},t('badgeUnknown'))),
          open ? h('span',{className:'pdv-details'},...detail.map((line,index)=>h('span',{className:'pdv-detail-row',key:index},line)),gap?h('span',{className:'pdv-detail-row'},'实时状态不可用'):null) : null);
      }

      ctx.slots.inject('settings.section', () => ctx.slots.register({name:'settings.section',id:'preset-dispatch',order:21,label:() => t('title')},Page));
      // Each chat surface is contributed to its own DECLARED slot: `slots.inject(key, ...)` only
      // runs its callback once a parent entry has declared that exact key, so an unknown key would
      // silently never register. Every target therefore gets its own inject/effect pair, and the
      // disposer the factory returns withdraws that one contribution when the plugin unloads.
      // The badge goes to BOTH additive slots, each under its own id. A one-shot read-only preview
      // replaces the whole composer, so `conversation.input.left` is not rendered there at all; the
      // header entry is what keeps the badge visible in that view. Neither slot can displace the
      // native model selector, permission control or submit action.
      const registerView = (options, component) => {
        try {
          return ctx.slots.register(options, component);
        } catch (error) { ctx.logger?.warn?.('preset-dispatch: 界面插槽不可用 ' + String(options.name) + '（' + String(error?.message ?? error) + '）'); return null; }
      };
      const chatViews = [
        ['tool.call.toolview', {name:'tool.call.toolview',key:'preset_dispatch'}, DispatchCard, '派遣卡片'],
        ['conversation.input.left', {name:'conversation.input.left',id:'preset-dispatch-child',order:12,label:() => t('badgeTitle')}, ChildBadge, '输入区徽标'],
        ['conversation.session.header.actions', {name:'conversation.session.header.actions',id:'preset-dispatch-child',order:12,label:() => t('badgeTitle')}, ChildBadge, '会话标题徽标'],
      ];
      // Independent per surface: only the failing one warns, the other two still register.
      for (const [slotName, options, component, label] of chatViews) {
        ctx.effect(() => ctx.slots.inject(slotName, () => registerView(options, component)), 'preset-dispatch: ' + label);
      }
    }};
  },
});
