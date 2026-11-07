import { Repository, readExistingLegacy } from './repository.js';
import { emptyData, today, plusDays, uid as uniqueId, expiryStatus, dayNumber } from './domain.js';
import { hydrate, dehydrate, demoCartData, createStockChange } from './view-model.js';
import { downloadJson, exportExcel } from './export.js';
import { registerSW } from 'virtual:pwa-register';
(() => {
  'use strict';

  const TYPES = { medicine: '药品', consumable: '医用耗材', equipment: '器械设备', custom: '其他物品' };
  const DEPARTMENTS = ['普通病区', '急诊', 'ICU', '儿科', '手术室 / 麻醉恢复室', '妇产科', '自定义'];
  const FINDINGS = { short: '数量不足', expired: '已过期', packaging: '包装异常', missing: '物品缺失', equipment: '设备异常', other: '其他异常' };
  const $ = (s, root = document) => root.querySelector(s);
  const e = (v = '') => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = uniqueId;
  const repository = new Repository();
  let state = hydrate({data:emptyData(),generation:0});
  let ready=false, saving=false, pending=null, pendingRestore=null, installPrompt=null, offlineReady=false;
  let toastTimer;
  const activeCarts = () => state.carts.filter(c=>!c.archivedAt);
  const activeItems = () => state.items.filter(it=>!it.archivedAt&&activeCarts().some(c=>c.id===it.cartId));
  const cart = () => activeCarts().find(x => x.id === state.cartId) || activeCarts()[0] || {name:'尚未创建抢救车',id:null};
  const item = id => state.items.find(x => x.id === (id || state.itemId));
  const cartItems = () => activeItems().filter(x => x.cartId === state.cartId);
  const actual = it => Array.isArray(it.batches) ? (it.batches.length ? it.batches.reduce((a, b) => a + b.quantity, 0) : (it.quantityEntered ? 0 : null)) : it.actual;
  const countText = n => n === null || n === undefined ? '未录入' : String(n);
  function expiry(b) { return expiryStatus({expiryDate:b.expiry,expiryPrecision:b.precision},state.warningDays); }
  const low = it => it.required !== null && it.required !== undefined && actual(it) !== null && actual(it) < it.required;
  const legacyLow = it => it.legacyMinimumQuantity !== undefined && actual(it) !== null && actual(it) < it.legacyMinimumQuantity;
  const hasExpiry = (it, key) => (it.batches || []).some(b => b.quantity > 0 && expiry(b).key === key);
  const flag = (text, tone = '') => `<span class="status-label ${tone}">${e(text)}</span>`;
  function badges(it) {
    const tags = [];
    if (hasExpiry(it, 'expired')) tags.push(flag('有过期批次', 'danger'));
    if (hasExpiry(it, 'warning')) tags.push(flag('有近效期批次', 'warning'));
    if(legacyLow(it))tags.push(flag(`低于旧最低库存提醒 ${it.legacyMinimumQuantity}`,'warning'));
    if (low(it)) tags.push(flag(`数量不足 ${it.required - actual(it)}`, 'warning'));
    if (hasExpiry(it, 'pending')) tags.push(flag('日期规则待确认'));
    if (it.required === null) tags.push(flag('应有数量待确认'));
    if (actual(it) === null) tags.push(flag('实际数量未录入'));
    if (it.pendingRecheck) tags.push(flag('数量更新后待复核', 'warning'));
    if (!tags.length) tags.push(flag(it.type === 'equipment' ? '查看设备检查项目' : '当前账面无提醒'));
    return tags.join('');
  }
  function visibleItems() {
    return cartItems().filter(it => {
      const q = state.query.toLowerCase();
      const text = [it.name, it.specification, it.location, ...(it.batches || []).map(b => b.number)].join(' ').toLowerCase();
      return (!q || text.includes(q)) && (state.type === 'all' || it.type === state.type) && (state.filter === 'all' || (state.filter === 'low' ? low(it) : state.filter === 'legacy-low' ? legacyLow(it) : state.filter === 'recheck' ? it.pendingRecheck : hasExpiry(it, state.filter)));
    });
  }
  function notify(text) {
    if (pending) { pending.toast=text; return; }
    $('#toast').textContent = text; $('#toast').classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3400);
  }
  function showSheet(title, html) {
    if(pending){pending.sheet={title,html};return;}
    $('#sheet-title').textContent = title; $('#sheet-content').innerHTML = html;
    if (!$('#sheet').open) $('#sheet').showModal();
  }
  function closeSheet() { if(pending){pending.close=true;return;} if ($('#sheet').open) $('#sheet').close(); }
  function go(page, options = {}) {
    closeSheet(); Object.assign(state, options); state.page = page;
    if (page === 'detail' && (!item() || item().cartId !== state.cartId)) { const first = cartItems()[0]; if (!first) return go('list'); state.itemId = first.id; }
    if (page === 'check' && (!state.session || state.session.cartId !== state.cartId)) return startCheck(cartItems().map(x => x.id));
    if(pending){pending.render=true;return;}
    render(); $('#screen').scrollTop = 0; window.scrollTo({ top: 0, behavior: 'instant' }); $('#screen').focus({ preventScroll: true });
  }
  function header(title, subtitle, action = '', back = false) {
    $('#app-header').innerHTML = `<div class="header-title">${back ? '<button class="back" data-action="back" aria-label="返回物品清单">‹</button>' : ''}<div><h1>${e(title)}</h1><p class="header-subtitle">${e(subtitle)}</p></div></div>${action}`;
    $('#page-caption').textContent = ({ home: '个人工作台', list: '抢救车物品清单', detail: '物品详情', check: '逐项检查', settings: '配置中心' })[state.page];
  }
  const button = (text, action, cls = '', attrs = '') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${text}</button>`;
  function recordLabel(r) { return r.legacy ? '旧版 · 结果未记录' : r.result === 'normal' ? '人工确认正常' : '已记录异常'; }
  const timeText = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录';
  function historyRows(records) {
    if (!records.length) return '<p class="subtle">暂无记录。单项确认后会出现在这里。</p>';
    return records.slice(0, 4).map(r => `<div class="history-row"><div><p class="history-title">${e(r.name)}</p><p class="subtle">${e(recordLabel(r))}${state.carts.find(c=>c.id===r.cartId)?.dataPurpose==='demo'?' · 演示记录':''}</p><p class="fine">${e(timeText(r.checkedAt))}</p></div>${button('查看', 'record', 'link-button', `data-id="${e(r.id)}"`)}</div>`).join('');
  }
  function homeView() {
    header('我的工作台', '先处理异常，再进入清单', button('新建抢救车', 'create-cart', 'header-action'));
    const alerts = [ ['expired', '过期物品', 'danger'], ['warning', '近效期物品', 'warning'], ['low', '数量不足', 'warning'], ['pending', '日期规则待确认', ''] ];
    if(activeItems().some(it=>it.legacyMinimumQuantity!==undefined))alerts.push(['legacy-low','旧最低库存提醒','warning']);
    const alertRows = alerts.map(([key, label, tone]) => {
      const items = activeItems().filter(it => key === 'low' ? low(it) : key === 'legacy-low' ? legacyLow(it) : hasExpiry(it, key));
      return `<button class="alert-row" data-action="alert" data-filter="${key}"><span class="alert-text"><i class="marker ${tone}"></i>${label}</span><span class="count">${items.length} <span class="small">项 ›</span></span></button>`;
    }).join('');
    return `${!activeCarts().length?'<div class="empty"><h2>先建立你的第一台抢救车</h2><p>从空白清单开始，不预填临床物品。也可以先体验独立演示车。</p>'+button('新建抢救车','create-cart','primary')+' '+button('体验演示数据','seed-demo')+'</div>':''}<section class="section"><div class="section-title"><h2>需要关注</h2><span class="fine">本地日期 ${today()}</span></div><div class="alert-list">${alertRows}</div><p class="fine" style="margin-top:7px">同一物品可同时有多种提醒；这是账面提示，不代表实物结论。</p></section>
    <section class="section"><div class="section-title"><h2>我的抢救车</h2><span class="subtle">${activeCarts().length} 台</span></div>${activeCarts().map(c => {
      const its = activeItems().filter(x => x.cartId === c.id);
      const anomalies = its.filter(x => low(x) || hasExpiry(x, 'expired') || hasExpiry(x, 'warning')).length;
      return `<div class="cart-row"><div class="cart-row-head"><button class="cart-name" data-action="open-cart" data-id="${e(c.id)}">${e(c.name)}</button>${flag(c.dataPurpose==='demo'?'演示数据':c.dataPurpose==='legacy_unclassified'?'迁入待确认':'个人配置')}</div><p class="cart-meta">${e(c.department || '科室未设置')} · ${e(c.location || '位置未设置')}</p><div class="cart-row-footer"><span class="subtle">${its.length} 项物品${anomalies ? ` · ${anomalies} 项有提醒` : ''}</span><div>${button('查看清单', 'open-cart', 'link-button', `data-id="${e(c.id)}"`)} ${button('复制配置', 'copy-cart', 'link-button', `data-id="${e(c.id)}"`)}</div></div></div>`;
    }).join('')}</section><section class="section"><div class="section-title"><h2>待处理事项</h2></div><p class="subtle">${activeItems().filter(x => x.pendingRecheck).length ? `有 ${activeItems().filter(x => x.pendingRecheck).length} 项数量变更待复核。进入物品详情后可检查本项。` : '暂无补充后待复核事项。未设置每班检查规则，不推断逾期。'}</p></section><section class="section"><div class="section-title"><h2>最近检查记录</h2>${button('全部记录','view-history','link-button')}</div>${historyRows(state.records)}</section>`;
  }
  function cartSelector() {
    return `<label for="cart-select" class="visually-hidden">选择抢救车</label><select id="cart-select" class="cart-select">${activeCarts().map(c => `<option value="${e(c.id)}" ${c.id === state.cartId ? 'selected' : ''}>${e(c.name)}</option>`).join('')}</select>`;
  }
  function itemRows(list) {
    if (!list.length) return `<div class="empty"><h3>${cartItems().length ? '没有符合条件的物品' : '这台车还没有物品'}</h3><p>${cartItems().length ? '试试更换筛选条件或清空搜索。' : '先添加一种物品。应有数量需要自行确认，不从模板猜测。'}</p>${button(cartItems().length ? '清空筛选' : '添加第一种物品', cartItems().length ? 'clear-filters' : 'add-item')}</div>`;
    return list.map(it => `<article class="item-row"><div class="item-row-main"><div><button class="item-open" data-action="item" data-id="${e(it.id)}">${e(it.name)}</button><p class="subtle">${e(TYPES[it.type])} · ${e(it.specification || '规格未填')}</p></div><div class="item-quantity"><strong>${e(countText(actual(it)))}</strong><span class="subtle"> / ${it.required === null ? '应有待确认' : e(it.required)}</span><p class="fine">${e(it.unit || '单位未设置')}</p></div></div><div class="tag-row">${badges(it)}</div><p class="item-location">${e(it.location || '位置未设置')} · ${it.batches ? `${it.batches.length} 个批次` : '数量汇总'}</p></article>`).join('');
  }
  function listView() {
    header('物品清单', '选择一项查看批次或开始检查', button('添加物品', 'add-item', 'header-action'));
    const list = visibleItems();
    return `${cartSelector()}<div class="search-row"><label class="visually-hidden" for="search">搜索物品</label><input id="search" type="search" value="${e(state.query)}" placeholder="搜索名称、批号或位置" autocomplete="off"></div><div class="chips" aria-label="物品类型">${[['all', '全部'], ...Object.entries(TYPES)].map(([value, text]) => button(e(text), 'type', value === state.type ? 'active' : '', `data-value="${value}"`)).join('')}</div><div class="filter-row"><span class="subtle" id="list-count">${list.length} 项物品</span><label><span class="visually-hidden">异常筛选</span><select id="filter">${[['all', '全部状态'], ['warning', '近效期'], ['expired', '已过期'], ['low', '数量不足'], ['pending', '日期规则待确认'], ['legacy-low', '旧最低库存提醒'], ['recheck', '更新后待复核']].map(([v, t]) => `<option value="${v}" ${state.filter === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div><div id="item-rows">${itemRows(list)}</div><div class="sticky-action">${button(`逐项检查当前清单（${list.length} 项）`, 'check-list', 'primary full', list.length ? '' : 'disabled')}<p class="fine" style="margin-top:7px">只选择待检查范围，不会把任何项目自动标为正常。</p></div>`;
  }
  function detailView() {
    const it = item();
    header('物品详情', cart().name, button('编辑', 'edit-item', 'header-action'), true);
    const batches = it.batches ? it.batches.map(b => { const ex = expiry(b); return `<div class="batch"><div class="batch-top"><strong class="small">${e(b.number || '批号未填写')}</strong>${flag(ex.label, ex.tone)}</div><p class="batch-detail">数量 ${e(b.quantity)} ${e(it.unit || '')} · 有效期 ${e(b.expiry || '未设置')}${b.precision === 'month' ? '（仅年月）' : ''}</p>${b.precision === 'month' ? '<p class="fine">未补为月底，不计算剩余天数。</p>' : ''}${button('编辑批次','edit-batch','link-button',`data-id="${e(b.id)}"`)}</div>`; }).join('') : '<p class="subtle">本项不跟踪批次；设备维护周期不按药品效期处理。</p>';
    const changes = state.changes.filter(x => x.itemId === it.id);
    return `<section class="detail-heading"><h2>${e(it.name)}</h2><p class="subtle">${e(TYPES[it.type])} · ${e(it.specification || '规格未填')}</p><div class="tag-row">${badges(it)}</div></section><div class="detail-grid"><div class="detail-cell"><span>应有数量</span><strong>${it.required === null ? '待确认' : e(it.required)}</strong></div><div class="detail-cell"><span>实际数量${it.batches ? '（批次汇总）' : ''}</span><strong>${e(countText(actual(it)))}</strong></div></div><dl class="key-values"><dt>存放位置</dt><dd>${e(it.location || '未设置')}</dd><dt>计数单位</dt><dd>${e(it.unit || '未设置')} · 仅整数计数</dd>${it.legacyMinimumQuantity!==undefined?`<dt>旧最低库存</dt><dd>${it.legacyMinimumQuantity}（原软件提醒，不是应有数量）</dd>`:''}${it.remark ? `<dt>备注</dt><dd>${e(it.remark)}</dd>` : ''}</dl><div class="actions">${button('检查本项', 'check-item', 'primary')}${button('使用 / 补充', 'stock')}</div>${it.pendingRecheck ? '<div class="notice warn">数量已经更新，仍需人工复核；尚未自动生成检查记录。</div>' : ''}<section class="section" style="margin-top:24px"><div class="section-title"><h2>批次与效期</h2>${it.batches ? button('添加批次', 'add-batch', 'link-button') : ''}</div>${batches || '<p class="subtle">还未录入批次，实际数量未知。</p>'}</section>${it.type === 'equipment' ? `<section class="section"><div class="section-title"><h2>设备必检项目</h2>${button('修改项目', 'equipment-fields', 'link-button')}</div>${(it.checklist || []).map(x => `<p class="subtle">□ ${e(x)}</p>`).join('') || '<p class="subtle">尚未配置必检项目，不能确认设备整体正常。</p>'}<p class="fine" style="margin-top:7px">检查项目由使用者维护，不能冒充医院统一标准。</p></section>` : ''}<section class="section"><div class="section-title"><h2>检查记录</h2>${button('全部历史','view-history','link-button')}</div>${historyRows(state.records.filter(x => x.itemId === it.id))}</section><section class="section"><div class="section-title"><h2>数量变化</h2></div>${changes.length ? changes.map(c => `<div class="history-row"><div><p class="history-title">${e(c.label)} · ${e(countText(c.before))} → ${e(countText(c.after))}</p><p class="subtle">${e(c.reason || '未填备注')}</p><p class="fine">${e(timeText(c.at))} · 数量变更</p></div></div>`).join('') : '<p class="subtle">尚无变化。使用或补充后保留前后数量。</p>'}</section>`;
  }
  function startCheck(ids) {
    if (!ids.length) return notify('这台车还没有可检查的物品，请先添加。');
    state.session = { cartId: state.cartId, ids: [...ids], index: 0, checked: {}, finished: false };
    go('check');
  }
  function checkView() {
    const s = state.session;
    header('逐项检查', cart().name, button('本次记录', 'session-records', 'header-action'), true);
    const done = Object.keys(s.checked).length;
    if (s.finished) return `<div class="summary-box"><h2>${done === s.ids.length ? '本次范围已逐项登记' : '本次仍有未检查项目'}</h2><p class="summary-number">${done} / ${s.ids.length}</p><p>只有明确确认的项目才留下记录。这是人工自报记录，不证明实物安全，也不替代正式检查记录。</p></div>${done < s.ids.length ? `<div class="notice warn">还有 ${s.ids.length - done} 项未确认，没有自动标记为正常。</div>${button('继续未检查项目', 'continue-check', 'primary full')}` : ''}<div class="actions">${button('查看本次检查结果', 'session-records')}${button('返回清单', 'nav', '', 'data-page="list"')}</div>`;
    const it = item(s.ids[s.index]);
    const saved = s.checked[it.id];
    return `<div class="progress-line"><span>当前第 ${s.index + 1} / ${s.ids.length} 项</span><span>已明确确认 ${done} 项</span></div><div class="progress-track"><div style="width:${100 * done / s.ids.length}%"></div></div><div class="check-item-header"><h2>${e(it.name)}</h2><p class="subtle">${e(it.location || '位置未设置')} · 实际 ${e(countText(actual(it)))} / 应有 ${it.required === null ? '待确认' : e(it.required)}</p><div class="tag-row">${badges(it)}</div></div>${saved ? `<div class="notice">本项本次已登记。不会因再次切换页面而重复生成。</div>${button('查看记录', 'record', 'full', `data-id="${e(saved)}"`)}<div class="actions">${button('下一项 / 查看结果', 'next-check', 'primary')}</div>` : `<form data-form="check"><div class="field"><label for="checker">检查人</label><input id="checker" name="checker" required value="${e(state.lastChecker||'')}" placeholder="填写检查人姓名" autocomplete="off"><p class="subtle">检查人为自报姓名，不代表身份认证。</p></div><fieldset class="field" style="border:0;padding:0"><legend>本项检查结果 <span class="required">请明确选择</span></legend><div class="choice-row"><label><input type="radio" name="result" value="normal">正常</label><label><input type="radio" name="result" value="abnormal">异常</label></div></fieldset><div id="findings" hidden><p class="subtle">选择所有发现的异常</p><div class="check-options">${Object.entries(FINDINGS).map(([v, t]) => `<label><input type="checkbox" name="finding" value="${v}">${t}</label>`).join('')}</div></div>${it.type === 'equipment' ? `<div class="field"><label>设备必检项目</label><div class="checklist">${(it.checklist || []).map((x, i) => `<label><input type="checkbox" name="equipment" value="${i}">${e(x)}：已核对且正常</label>`).join('')}</div><p class="subtle">所有必检项均确认正常，才能记录设备整体正常。留空不能通过。</p></div>` : ''}<div class="field"><label for="check-remark">备注 <span class="required">异常或账面差异时填写</span></label><textarea id="check-remark" name="remark" placeholder="描述本项需要处理的情况"></textarea></div><p class="fine">时间由设备在确认时生成，不可手改。一次只记录当前这一项。</p><div class="error" role="alert" id="check-error"></div><button class="primary full" type="submit">确认并保存本项</button></form><div class="actions">${button('稍后检查本项', 'skip-check')}</div>`}`;
  }
  function settingsView() { return ''; }
  function render() {
    if(pending){pending.render=true;return;}
    const notice=$('.simulation-notice'); const purpose=cart().dataPurpose;
    notice.classList.toggle('demo',purpose==='demo'); notice.textContent=purpose==='demo'?'演示数据，不是医院配置；演示车与个人车分开保存。':purpose==='legacy_unclassified'?'迁入数据用途及配置待确认；历史结果未知。':'数据仅保存在当前浏览器，请定期导出 JSON 备份。';
    const views = { home: homeView, list: listView, detail: detailView, check: checkView, settings: settingsView };
    $('#screen').innerHTML = views[state.page]();
    document.title = `${$('#page-caption').textContent} · 抢救车管理助手`;
    document.querySelectorAll('.bottom-nav button,.page-map button').forEach(b => b.classList.toggle('active', b.dataset.page === state.page || (b.dataset.page === 'list' && ['detail', 'check'].includes(state.page) && b.closest('.bottom-nav'))));
  }
  const field = (label, name, options = {}) => `<div class="field ${options.wide ? 'wide' : ''}"><label for="f-${name}">${label}${options.required ? '<span class="required">必填</span>' : ''}</label><input id="f-${name}" name="${name}" type="${options.type || 'text'}" ${options.required ? 'required' : ''} ${options.type === 'number' ? 'min="0" step="1" inputmode="numeric"' : ''} value="${e(options.value ?? '')}" placeholder="${e(options.placeholder || '')}"></div>`;
  function customField(f, value) {
    const id = `custom-${f.id}`, label = `${e(f.name)}（扩展字段）`;
    const control = f.kind === 'remark' ? `<textarea id="${id}" name="${id}">${e(value || '')}</textarea>` : `<input id="${id}" name="${id}" type="${f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : 'text'}" ${f.kind === 'number' ? 'step="any" inputmode="decimal"' : ''} value="${e(value ?? '')}">`;
    return `<div class="field"><label for="${id}">${label}</label>${control}</div>`;
  }
  function createCart(department = '') {
    showSheet('新建抢救车', `<p class="notice">只创建空车，不预填临床配置；保存成功后可在本浏览器持续使用。</p><form data-form="cart">${field('抢救车名称', 'name', { required: true, placeholder: '填写这台车的名称' })}<div class="field"><label for="f-department">科室</label><select id="f-department" name="department"><option value="">暂不设置</option>${DEPARTMENTS.map(d => `<option ${d === department ? 'selected' : ''}>${e(d)}</option>`).join('')}</select></div>${field('存放位置', 'location', { placeholder: '可稍后补充' })}<div class="error" role="alert"></div><button type="submit" class="primary full">创建空车</button></form>`);
  }
  function itemForm(edit = false) {
    const it = edit ? item() : null;
    showSheet(edit ? '编辑物品配置' : '添加物品', `<p class="subtle" style="margin-bottom:15px">先填必要信息，其余可以稍后补充。不得以演示数值作为真实配置。</p><form data-form="item" data-edit="${it ? e(it.id) : ''}"><div class="field"><label for="f-type">物品类型</label><select id="f-type" name="type" ${edit ? 'disabled' : ''}>${Object.entries(TYPES).map(([v, t]) => `<option value="${v}" ${it?.type === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>${field('物品名称', 'name', { required: true, value: it?.name, placeholder: '按已确认清单填写物品名称' })}<div class="form-grid">${field('应有数量', 'required', { type: 'number', value: it?.required, placeholder: '未确认可留空' })}${!edit ? field('实际数量', 'actual', { type: 'number', placeholder: '未盘点可留空' }) : '<p class="subtle" style="padding-top:28px">实际数量通过批次或使用 / 补充修改。</p>'}</div><details class="optional-fields"><summary>补充规格、位置等信息（可选）</summary>${field('规格 / 型号', 'specification', { value: it?.specification })}${field('计数单位', 'unit', { value: it?.unit, placeholder: '支、瓶、件等，仅整数计数' })}${field('存放位置', 'location', { value: it?.location })}<div id="new-expiry" ${edit || it?.type === 'equipment' ? 'hidden' : ''}>${expiryForm()}</div><div class="field"><label for="f-remark">备注</label><textarea name="remark" id="f-remark">${e(it?.remark || '')}</textarea></div>${state.fields.filter(f=>!f.archivedAt).map(f => customField(f, it?.customValues?.[f.id])).join('')}</details><div id="equipment-config" class="field" ${it?.type !== 'equipment' ? 'hidden' : ''}><label for="f-checklist">设备必检项目</label><textarea id="f-checklist" name="checklist" placeholder="每行一个已经确认的项目">${e((it?.checklist || []).join('\n'))}</textarea><p class="subtle">未配置时不能确认设备整体正常；不提供临床默认项目。</p></div><div class="error" role="alert"></div><button type="submit" class="primary full">${edit ? '保存配置' : '添加到当前车'}</button></form>`);
  }
  function expiryForm() {
    return `<div class="field"><label for="f-precision">有效期标注方式</label><select id="f-precision" name="precision"><option value="none">暂未填写</option><option value="day">完整日期（年-月-日）</option><option value="month">只有年月</option></select></div><div class="field" id="expiry-input-wrap" hidden><label for="f-expiry">有效期原值</label><input id="f-expiry" name="expiry" type="text" placeholder="YYYY-MM-DD 或 YYYY-MM"><p id="expiry-tip" class="subtle">年月精度不补月底，不计算倒计时。</p></div>`;
  }
  function validateExpiry(fd) {
    const precision = fd.get('precision') || 'none', value = String(fd.get('expiry') || '').trim();
    if (precision === 'none') return { expiry: '', precision: '' };
    if (precision === 'day' && dayNumber(value) === null) throw Error('请输入真实存在的完整日期，例如 2027-06-15。');
    if (precision === 'month' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw Error('只有年月时请填写 YYYY-MM，不要补写日期。');
    return { expiry: value, precision };
  }
  function count(value, nullable = true) {
    if (value === '' || value === null) { if (nullable) return null; throw Error('请填写数量。'); }
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw Error('数量仅接受有限非负整数，不支持小数或自动取整。');
    return Number(value);
  }
  function saveItem(form, fd) {
    const existing = form.dataset.edit ? item(form.dataset.edit) : null;
    const type = existing?.type || fd.get('type');
    const name = String(fd.get('name') || '').trim(); if (!name) throw Error('请填写物品名称。');
    const required = count(fd.get('required'));
    const isBatch = ['medicine', 'consumable'].includes(type);
    const values = {};
    state.fields.filter(f=>!f.archivedAt).forEach(f => { const v = String(fd.get(`custom-${f.id}`) || '').trim(); if (f.kind === 'number' && v && !Number.isFinite(Number(v))) throw Error(`“${f.name}”需要有效数字。`); if (f.kind === 'date' && v && dayNumber(v) === null) throw Error(`“${f.name}”需要真实存在的日期。`); values[f.id] = !v ? null : f.kind === 'number' ? Number(v) : v; });
    const target = existing || { id: uid('item'), cartId: state.cartId, type, pendingRecheck: false };
    let initialBatch, initialActual;
    if (!existing) {
      initialActual = count(fd.get('actual'));
      const ex = isBatch ? validateExpiry(fd) : {};
      if (isBatch && ex.expiry && initialActual === null) throw Error('已填写效期，请同时填写该初始批次的实际数量；未盘点可先不填写效期。');
      initialBatch = initialActual === null ? [] : [{ id: uid('batch'), number: '', quantity: initialActual, ...ex }];
    }
    Object.assign(target, { name, required, specification: String(fd.get('specification') || '').trim(), unit: String(fd.get('unit') || '').trim(), location: String(fd.get('location') || '').trim(), remark: String(fd.get('remark') || '').trim(), customValues: {...(existing?.customValues||{}),...values} });
    if (type === 'equipment') target.checklist = String(fd.get('checklist') || '').split('\n').map(x => x.trim()).filter(Boolean);
    if (!existing) { if (isBatch) { target.batches = initialBatch; target.quantityEntered = initialActual !== null; } else target.actual = initialActual; state.items.push(target); }
    go('detail', { itemId: target.id }); notify(existing ? '已在本机修改配置。' : '物品已保存到本机。');
  }
  function batchForm() {
    showSheet('添加批次', `<p class="subtle" style="margin-bottom:13px">${e(item().name)} · 数量会计入物品总数。</p><form data-form="batch">${field('生产批号', 'number', { placeholder: '未知可留空，不生成临床批号' })}${field('本批次数量', 'quantity', { type: 'number', required: true })}${expiryForm()}<div class="error" role="alert"></div><button type="submit" class="primary full">保存批次</button></form>`);
  }
  function stockForm() {
    const it = item();
    if (it.batches && !it.batches.length) return notify('尚无批次，请先添加批次并录入数量。');
    showSheet('使用 / 补充记录', `<p class="notice">更新账面数量和变化记录；不会自动生成正常检查记录。</p><form data-form="stock">${it.batches ? `<div class="field"><label for="stock-batch">选择批次</label><select name="batch" id="stock-batch">${it.batches.map(b => `<option value="${e(b.id)}">${e(b.number || '未填批号')} · 当前 ${b.quantity} · ${e(b.expiry || '效期未填')}</option>`).join('')}</select></div>` : ''}<div class="field"><label for="stock-operation">操作</label><select name="operation" id="stock-operation"><option value="use">使用：扣减数量</option><option value="replenish">补充：增加数量</option><option value="adjust">盘点更正：输入当前数量</option></select></div>${field('操作数量', 'quantity', { type: 'number', required: true })}${field('原因 / 备注', 'reason', { placeholder: '描述本次变化' })}<p class="fine">新批号或新效期请返回详情“添加批次”，不要覆盖旧批次。</p><div class="error" role="alert"></div><button type="submit" class="primary full">记录变化</button></form>`);
  }
  function saveCheck(form, fd) {
    const s = state.session, it = item(s.ids[s.index]);
    const checker = String(fd.get('checker') || '').trim(), result = fd.get('result'), findings = fd.getAll('finding'), remark = String(fd.get('remark') || '').trim();
    if (!checker) throw Error('请填写检查人姓名。');
    if (!result) throw Error('请明确选择当前这一项正常或异常。');
    if (result === 'abnormal' && !findings.length) throw Error('请选择至少一种异常。');
    if (result === 'abnormal' && !remark) throw Error('请写下本项异常说明，便于后续处理。');
    if (result === 'normal' && it.type === 'equipment' && (!(it.checklist || []).length || fd.getAll('equipment').length !== it.checklist.length)) throw Error('所有设备必检项目都明确核对且正常，才能记录整体正常。');
    if (result === 'normal' && (low(it) || legacyLow(it) || it.required===null || actual(it)===null || hasExpiry(it, 'expired') || hasExpiry(it, 'pending')) && !remark) throw Error('当前账面有异常或待确认日期。请先处理账面，或填写正常结果与账面的差异说明。');
    const now = new Date().toISOString();
    const r = { id: uid('check'), cartId: it.cartId, itemId: it.id, name: it.name, checker, result, findings: result === 'abnormal' ? findings : [], remark, checkedAt: now, recordedAt: now, timeSource: 'device', source:it.pendingRecheck?'recheck':'manual_item', snapshot: JSON.parse(JSON.stringify(it)), equipmentConfirmed: fd.getAll('equipment') };
    state.lastChecker=checker;
    state.records.unshift(r); s.checked[it.id] = r.id;
    if (result === 'normal') it.pendingRecheck = false;
    if (s.index < s.ids.length - 1) s.index++; else s.finished = true;
    render(); $('#screen').scrollTop = 0; window.scrollTo({ top: 0, behavior: 'instant' }); notify('已保存当前 1 项检查，其余项目未自动确认。');
  }
  function showRecord(id) {
    const r = state.records.find(x => x.id === id); if (!r) return;
    showSheet('检查记录详情', `<h3>${e(r.name)}</h3><div class="tag-row">${flag(recordLabel(r), r.result === 'abnormal' ? 'warning' : '')}</div><dl class="key-values"><dt>检查人</dt><dd>${e(r.checker)}</dd><dt>检查时间</dt><dd>${e(timeText(r.checkedAt))}</dd><dt>时间来源</dt><dd>${r.legacy ? '未知（旧记录）' : '设备生成，不可手工改时'}</dd><dt>记录时间</dt><dd>${r.legacy ? '旧版未记录，不用迁移时间补写' : e(timeText(r.recordedAt))}</dd><dt>异常</dt><dd>${r.legacy ? '旧版未记录' : e(r.findings.map(x => FINDINGS[x]).join('、') || '无')}</dd><dt>备注</dt><dd>${e(r.remark || '未填写')}</dd></dl><div class="notice">${r.legacy ? '不能据此认定已经逐项检查或检查正常。' : state.carts.find(c=>c.id===r.cartId)?.dataPurpose==='demo' ? '这是演示车的模拟记录，不是实际巡检或正式检查记录。' : '这是人工自报辅助记录，不替代正式记录，也不能证明实物安全。'}</div>${r.snapshot ? `<p class="subtle">保存时快照：${e(r.snapshot.name)} · 实际 ${e(countText(actual(r.snapshot)))} / 应有 ${r.snapshot.required === null ? '待确认' : e(r.snapshot.required)}</p>` : ''}`);
  }
  function showSessionRecords() {
    const s = state.session; if (!s) return notify('还没有开始本次检查。');
    const records = Object.values(s.checked).map(id => state.records.find(x => x.id === id));
    showSheet('本次检查结果', `<p class="notice">已确认 ${records.length} / ${s.ids.length} 项；未确认项目没有记录为正常。</p>${records.length ? records.map(r => `<div class="result-row"><h3>${e(r.name)}</h3><p class="subtle">${e(recordLabel(r))} · ${e(r.checker)}</p>${button('查看记录详情', 'record', 'link-button', `data-id="${e(r.id)}"`)}</div>`).join('') : '<p class="subtle">尚未确认任何项目。选择范围不等于完成检查。</p>'}`);
  }
  function showFlow() {
    showSheet('五页完整交互流程', `<p class="subtle" style="margin-bottom:15px">主要路径从上至下；弹窗承载建车、录入、批次等次级操作。点击节点可以体验。</p><div class="flow-diagram">${button('个人工作台：看异常 / 选择车', 'nav', '', 'data-page="home"')}<div class="flow-branch"><p class="fine">新建车弹窗 → 空清单 → 添加物品弹窗</p><p class="fine">异常入口 → 已筛选的物品清单</p></div><div class="flow-arrow">↓ 进入一台车</div>${button('抢救车物品清单：搜索 / 分类 / 筛选', 'nav', '', 'data-page="list"')}<div class="flow-arrow">↓ 选择一项</div>${button('物品详情：批次 / 数量 / 历史', 'nav', '', 'data-page="detail"')}<div class="flow-branch"><p class="fine">批次弹窗 → 添加分组 → 更新总量</p><p class="fine">使用 / 补充弹窗 → 数量变化 → 待复核</p></div><div class="flow-arrow">↓ 检查本项，或从清单逐项检查</div>${button('检查页面：逐项确认 → 本次结果 → 记录详情', 'nav', '', 'data-page="check"')}<div class="flow-arrow">↕ 底部导航随时可达</div>${button('配置中心：空模板 / 提醒 / 导出备份流程', 'nav', '', 'data-page="settings"')}<div class="flow-branch"><p class="fine">空模板 → 建车弹窗（不预填临床清单）</p><p class="fine">基础字段 → 四类扩展字段（可选）</p><p class="fine">备份恢复 → 预览 → 确认 / 校验失败</p></div></div><div class="notice">操作保存到本浏览器。导出和恢复会处理真实文件；请先备份，不以演示数据替代正式检查。</div>`);
  }
  const actions = {
    nav: b => go(b.dataset.page), back: () => go('list'), 'close-sheet': closeSheet,
    'create-cart': () => createCart(), 'add-item': () => itemForm(), 'edit-item': () => itemForm(true),
    'open-cart': b => go('list', { cartId: b.dataset.id, query: '', type: 'all', filter: 'all' }),
    item: b => go('detail', { itemId: b.dataset.id }), type: b => { state.type = b.dataset.value; render(); },
    'clear-filters': () => { state.query = ''; state.type = 'all'; state.filter = 'all'; render(); },
    alert: b => {
      const key = b.dataset.filter;
      const matches = activeItems().filter(it => key === 'low' ? low(it) : key === 'legacy-low' ? legacyLow(it) : hasExpiry(it, key));
      const carts = state.carts.filter(c => matches.some(it => it.cartId === c.id));
      if (carts.length > 1) return showSheet('选择要查看的抢救车', `<p class="subtle" style="margin-bottom:12px">工作台显示全部车的异常，清单按车查看。</p><div class="template-list">${carts.map(c => button(`${e(c.name)} · ${matches.filter(it => it.cartId === c.id).length} 项`, 'open-alert-cart', '', `data-id="${e(c.id)}" data-filter="${e(key)}"`)).join('')}</div>`);
      go('list', { cartId: carts[0]?.id || state.cartId, query: '', type: 'all', filter: key });
    },
    'open-alert-cart': b => go('list', { cartId: b.dataset.id, query: '', type: 'all', filter: b.dataset.filter }),
    'copy-cart': b => {
      const source = state.carts.find(x => x.id === b.dataset.id); const newCart = { ...source, id: uid('cart'), name: `${source.name}（配置副本）` };
      state.carts.push(newCart);
      activeItems().filter(x => x.cartId === source.id).forEach(it => { const copy = JSON.parse(JSON.stringify(it)); copy.id = uid('item'); copy.cartId = newCart.id; copy.pendingRecheck = false; if (copy.batches) { copy.batches = []; copy.quantityEntered = false; } else copy.actual = null; state.items.push(copy); });
      go('list', { cartId: newCart.id, query: '', type: 'all', filter: 'all' }); notify('仅复制配置。实际数量待录入，检查记录没有复制。');
    },
    'add-batch': batchForm, stock: stockForm,
    'check-list': () => startCheck(visibleItems().map(x => x.id)), 'check-item': () => startCheck([state.itemId]),
    'skip-check': () => { const s = state.session; if (s.index < s.ids.length - 1) s.index++; else s.finished = true; render(); },
    'next-check': () => { const s = state.session; if (s.index < s.ids.length - 1) s.index++; else s.finished = true; render(); },
    'continue-check': () => { const s = state.session; startCheck(s.ids.filter(id => !s.checked[id])); },
    record: b => showRecord(b.dataset.id), 'session-records': showSessionRecords,
    'equipment-fields': () => showSheet('设备必检项目', `<form data-form="equipment"> <p class="notice">每行一项，按相关人员确认的检查要求填写。</p><div class="field"><label for="equipment-projects">必检项目</label><textarea id="equipment-projects" name="checklist">${e((item().checklist || []).join('\n'))}</textarea></div><button class="primary full" type="submit">保存检查项目</button></form>`),
    templates: () => showSheet('科室空白模板', `<p class="notice">目前各科室使用同一组基础分类和字段。科室差异需要访谈确认，模板不含药品、规格或数量。</p><div class="template-list">${DEPARTMENTS.map(d => button(`${e(d)}<span class="subtle">空白 ›</span>`, 'use-template', '', `data-department="${e(d)}"`)).join('')}</div>`),
    'use-template': b => createCart(b.dataset.department),
    'custom-fields': () => showSheet('基础扩展字段', `<p class="notice">可不配置；先验证基本字段是否已经够用。不做公式、字段联动或拖拽。</p>${state.fields.length ? state.fields.filter(f=>!f.archivedAt).map(f => `<p class="subtle">${e(f.name)} · ${e(({ text: '文本', number: '数字', date: '日期', remark: '备注' })[f.kind])}</p>`).join('') : '<p class="subtle">当前没有额外字段。</p>'}<form data-form="field" style="margin-top:17px">${field('字段名称', 'name', { required: true, placeholder: '填写需要的扩展字段名' })}<div class="field"><label for="field-kind">字段类型</label><select id="field-kind" name="kind"><option value="text">文本</option><option value="number">数字</option><option value="date">日期</option><option value="remark">备注</option></select></div><div class="error" role="alert"></div><button type="submit" class="primary full">添加扩展字段</button></form>`),
    rules: () => showSheet('效期提醒规则', `<form data-form="rules">${field('近效期提醒天数', 'days', { type: 'number', required: true, value: state.warningDays })}<div class="notice">这是软件提醒，不是医院标准。只有年月的效期始终显示“日期规则待确认”，不补到月底。</div><p class="fine">提醒按本地日历日期计算，今日 ${today()}。</p><div class="error" role="alert"></div><button type="submit" class="primary full">保存提醒规则</button></form>`),
    flow: showFlow,
  };
  const mutatingActions=new Set(['copy-cart','seed-demo','archive-item','archive-cart','unarchive']);
  async function mutate(callback){
    if(!ready)throw Error('本机数据尚未加载完成。');
    if(saving)throw Error('正在保存，请稍候。');
    const previous=state;let committed=false;state=structuredClone(state);pending={};saving=true;$('.app-frame').classList.add('busy');
    try{
      const result=callback();
      if(result===false){state=previous;pending=null;return;}
      const data=dehydrate(state), generation=await repository.save(data,previous.generation);committed=true;
      const queued=pending;state=hydrate({data,generation},state);pending=null;
      if(queued.close)closeSheet();render();
      if(queued.sheet)showSheet(queued.sheet.title,queued.sheet.html);
      if(previous.page!==state.page)$('#screen').scrollTop=0;
      notify(queued.toast||'已保存到本机。');
    }catch(err){if(!committed)state=previous;pending=null;if(committed)throw Error('数据已保存，但页面更新失败，请刷新查看。');throw err;}
    finally{pending=null;saving=false;$('.app-frame').classList.remove('busy');}
  }
  function settingRow(title,sub,action){return `<button class="setting-row" data-action="${action}"><div><h3>${title}</h3><p class="subtle">${sub}</p></div><span class="setting-arrow" aria-hidden="true">›</span></button>`;}
  // 替换原型中的导出、恢复与重置占位；这些入口连接真实数据库和文件能力。
  settingsView = function(){
    header('配置中心','个人配置、备份与本地状态');
    return `<section class="section"><div class="section-title"><h2>清单与提醒</h2></div><div class="settings-group">${settingRow('当前抢救车设置',e(cart().name),'cart-settings')}${settingRow('科室与配置模板','空科室入口，以及自己保存的配置','templates')}${settingRow('基础扩展字段','文本、数字、日期、备注，可不使用','custom-fields')}${settingRow('效期提醒规则',`当前 ${state.warningDays} 天；年月效期单独待确认`,'rules')}${settingRow('已归档内容','保留历史，可恢复到工作清单','archived')}</div></section><section class="section"><div class="section-title"><h2>导出与数据救援</h2></div><div class="settings-group">${settingRow('导出 Excel','四个 Sheet，用于阅读和整理','excel')}${settingRow('完整 JSON 备份与恢复','完整保存；恢复前预览并确认覆盖','backup')}${settingRow('查找本浏览器旧版数据','读取 RescueCartDB，不修改旧库','legacy-import')}${settingRow('恢复上次覆盖前数据','仅保留最近一次覆盖前的本地快照','recovery')}</div><p class="fine" style="margin-top:9px">最近备份文件生成：${state.lastExportGeneratedAt?e(timeText(state.lastExportGeneratedAt)):'尚无记录'}。文件已生成不代表已另存，请确认下载。</p></section><section class="section"><div class="section-title"><h2>本机与使用说明</h2></div><div class="settings-group">${settingRow('安装到手机桌面','Android 安装提示 / iOS 添加到主屏幕','install')}${settingRow('存储状态与持久化','查看容量估计，申请浏览器保留数据','storage')}${settingRow('体验演示数据','单独创建演示车，不覆盖你的配置','seed-demo')}${settingRow('操作流程','查看清单、检查、补充与备份路径','flow')}</div></section><div class="device-status"><p>数据仅在当前浏览器。不同浏览器、手机或安装入口可能有独立数据，不会自动同步。</p><p>本工具为个人辅助记录，不替代现行正式检查和交接记录。模拟数据仅用于流程验证，真实替代另行确认。</p><p>清理网站数据可能导致丢失，请保留独立 JSON 文件。<a href="./legacy/index.html" target="_blank" rel="noopener">旧版只读与备份</a></p><p id="cache-status">${offlineReady?'离线资源已就绪；仍需独立数据备份。':'离线资源尚未确认就绪；开发预览不启用离线缓存。'}</p></div>`;
  };
  function shortError(err){return err?.message||'操作失败，请重试。';}
  async function exportBackup(){
    const backup=await repository.backup();downloadJson(`抢救车完整备份_${today()}.json`,backup);
    await mutate(()=>{state.lastExportGeneratedAt=new Date().toISOString();notify('备份文件已生成，请确认已另存到安全位置。');});
    if(pendingRestore)pendingRestore.generation=state.generation;
  }
  async function previewRestore(input,source='JSON 文件'){
    const result=await repository.preview(input);pendingRestore={input,generation:state.generation};
    const data=result.data;
    showSheet('恢复前确认',`<div class="notice warn">此操作将完整替换本机数据，不自动合并。请先导出当前完整备份。旧物理数据库不变。</div><dl class="key-values"><dt>来源</dt><dd>${e(source)}</dd><dt>即将恢复</dt><dd>${data.carts.length} 台车、${data.items.length} 项物品、${data.checks.length} 条记录</dd><dt>当前数据</dt><dd>${state.carts.length} 台车、${state.items.length} 项物品、${state.records.length} 条记录</dd></dl>${result.legacy?'<p class="notice">旧数据迁为待确认的个人车；应有量未知，旧检查结果/方式未知。请关闭旧版其他窗口，避免两份数据继续分叉。</p>':''}<div class="actions">${button('先导出当前备份','export-backup')}</div><form data-form="restore-confirm"><div class="field" style="margin-top:15px"><label class="inline"><input type="checkbox" name="confirm" required>我已处理当前备份，确认完整覆盖</label></div><div class="error" role="alert"></div><button class="primary full" type="submit">确认恢复这份数据</button></form>`);
  }
  async function performRestore(fd){
    if(!fd.get('confirm')||!pendingRestore)throw Error('请先确认覆盖范围。');
    if(saving)throw Error('正在保存，请稍候。');saving=true;
    try{const restored=await repository.restore(pendingRestore.input,pendingRestore.generation);state=hydrate(restored,{page:'home'});pendingRestore=null;closeSheet();render();notify('完整恢复已提交成功；覆盖前数据保留在本地救援快照。');}
    finally{saving=false;}
  }
  Object.assign(actions,{
    'edit-batch':b=>{const batch=item().batches.find(x=>x.id===b.dataset.id);state.editingBatchId=batch.id;showSheet('编辑批次',`<p class="notice">修改数量或效期会留下更正记录，并要求重新复核。</p><form data-form="batch-edit">${field('批号','number',{value:batch.number||''})}${field('本批次数量','quantity',{type:'number',required:true,value:batch.quantity})}${expiryForm()}${field('更正原因','reason',{required:true})}<div class="error" role="alert"></div><button type="submit" class="primary full">保存批次更正</button></form>`);$('#f-precision').value=batch.precision||'none';$('#f-expiry').value=batch.expiry||'';$('#expiry-input-wrap').hidden=!batch.expiry;},
    'edit-item':()=>{itemForm(true);$('#sheet-content').insertAdjacentHTML('beforeend',button('归档本物品，保留历史','archive-item','archive-button full'));},
    'add-item':()=>state.cartId?itemForm():createCart(),
    'seed-demo':()=>{demoCartData(state,today(),plusDays);go('list',{query:'',type:'all',filter:'all'});notify('已添加独立演示车，不是医院配置。');},
    excel:async()=>{const data=(await repository.snapshot()).data;exportExcel(data);notify('XLSX 已生成，请在下载中打开并检查。');},
    'export-backup':exportBackup,
    backup:()=>showSheet('完整 JSON 备份与恢复',`<p class="notice">Excel 用于阅读，JSON 用于完整恢复。本浏览器不会自动上传数据。</p>${button('导出完整 JSON 备份','export-backup','primary full')}<div class="file-picker"><label for="backup-file">选择 JSON 备份文件</label><input type="file" id="backup-file" accept=".json,application/json"><p class="fine">先校验、预览，再由你确认覆盖。当前单文件上限 20MB。</p></div><p class="subtle">支持旧版外层/裸 JSON 与新版 schemaVersion 2。未知格式、非法数量或校验失败时不覆盖原数据。</p><div class="error" id="backup-error" role="alert"></div>`),
    'legacy-import':async()=>{const legacy=await readExistingLegacy();if(!legacy){showSheet('未找到本浏览器旧数据','<p>此浏览器、此网址下没有旧版数据库。</p><p class="subtle">如旧数据在另一网址或浏览器，请在原入口导出 JSON 后回这里恢复；不要因此新填一份临床配置。</p>');return;}await previewRestore(legacy,'当前浏览器 RescueCartDB v1');},
    recovery:async()=>{const snapshot=await repository.recovery();if(!snapshot)return notify('没有覆盖前的本地快照，请使用独立 JSON 备份。');showSheet('恢复覆盖前的本地快照',`<p class="notice warn">快照时间 ${e(timeText(snapshot.createdAt))}。恢复将覆盖当前数据；本地快照不能替代独立文件备份。</p>${button('先导出当前备份','export-backup','full')}<div class="actions">${button('确认恢复本地快照','confirm-recovery','primary')}</div>`);},
    'confirm-recovery':async()=>{if(saving)return;saving=true;try{state=hydrate(await repository.recover(state.generation),{page:'home'});closeSheet();render();notify('覆盖前快照已恢复。');}finally{saving=false;}},
    'archive-item':()=>{if(!confirm('归档当前物品？清单将隐藏，检查和数量历史保留，可在配置中恢复。'))return false;item().archivedAt=new Date().toISOString();go('list');notify('物品已归档，历史保留。');},
    'archive-cart':()=>{if(!confirm('归档当前车？车、物品和历史全部保留，可在配置中恢复。'))return false;cart().archivedAt=new Date().toISOString();state.cartId=activeCarts()[0]?.id||null;go('home');notify('抢救车已归档，数据未删除。');},
    archived:()=>showSheet('已归档内容',`${state.carts.filter(c=>c.archivedAt).map(c=>`<div class="result-row"><strong>${e(c.name)}</strong><p class="subtle">抢救车</p>${button('恢复到工作台','unarchive','link-button',`data-kind="cart" data-id="${e(c.id)}"`)}</div>`).join('')}${state.items.filter(it=>it.archivedAt).map(it=>`<div class="result-row"><strong>${e(it.name)}</strong><p class="subtle">物品 · ${e(state.carts.find(c=>c.id===it.cartId)?.name||'')}</p>${button('恢复到清单','unarchive','link-button',`data-kind="item" data-id="${e(it.id)}"`)}</div>`).join('')||'<p class="subtle">归档的物品可在这里恢复。</p>'}`),
    unarchive:b=>{const row=b.dataset.kind==='cart'?state.carts.find(c=>c.id===b.dataset.id):item(b.dataset.id);delete row.archivedAt;closeSheet();go('home');notify('已恢复，历史未改变。');},
    'cart-settings':()=>{if(!state.cartId)return createCart();const c=cart();showSheet('当前抢救车设置',`<form data-form="cart-edit">${field('名称','name',{required:true,value:c.name})}${field('科室','department',{value:c.department||''})}${field('位置','location',{value:c.location||''})}<div class="error" role="alert"></div><button class="primary full" type="submit">保存车配置</button></form>${button('归档这台车','archive-cart','archive-button full')}`);},
    templates:()=>showSheet('科室与配置模板',`<p class="notice">空科室入口不含临床清单。自定义模板只复制配置，不带实际数量和检查历史。</p><div class="template-list">${state.templates.filter(t=>!t.archivedAt).map(t=>button(`${e(t.name)}<span class="subtle">${t.items.length?'用户配置':'空白'} ›</span>`,t.items.length?'template-create':'use-template','',`data-id="${e(t.id)}" data-department="${e(t.department)}"`)).join('')}</div>${state.cartId?'<div class="actions">'+button('将当前车配置保存为模板','save-template')+'</div>':''}`),
    'save-template':()=>showSheet('保存配置模板',`<p class="notice">只保存当前车的物品配置；不包含批次数量、实际库存或检查。</p><form data-form="template-save">${field('模板名称','name',{required:true})}<div class="error" role="alert"></div><button type="submit" class="primary full">保存用户模板</button></form>`),
    'template-create':b=>{state.templateToApply=b.dataset.id;showSheet('从配置模板创建车',`<p class="notice">将复制你选择的用户配置，实际数量均为未知，检查记录为空。</p><form data-form="template-create">${field('新车名称','name',{required:true})}<div class="error" role="alert"></div><button class="primary full" type="submit">复制配置并创建车</button></form>`);},
    'view-history':()=>{const rows=state.page==='detail'?state.records.filter(r=>r.itemId===state.itemId):state.records;showSheet('检查历史',rows.length?`<p class="subtle">共 ${rows.length} 条，历史按保存时快照展示。</p><div class="record-list">${rows.map(r=>`<div class="history-row"><div><h3>${e(r.name)}</h3><p class="subtle">${e(recordLabel(r))} · ${e(timeText(r.checkedAt))}</p></div>${button('详情','record','link-button',`data-id="${e(r.id)}"`)}</div>`).join('')}</div>`:'<p>尚无检查记录。</p>');},
    install:async()=>{if(installPrompt){await installPrompt.prompt();installPrompt=null;notify('已显示系统安装提示，请按浏览器选择。');}else showSheet('添加到手机桌面','<p>Android：使用支持安装的浏览器菜单，选择“安装应用 / 添加到主屏幕”。</p><p>iPhone：在 Safari 中打开，使用“分享 → 添加到主屏幕”。</p><div class="notice">安装通常需要 HTTPS。不同入口是否共享数据应实测，切换入口前先导出 JSON。当前工具不宣称已通过你的手机兼容验证。</div>');},
    storage:async()=>{const estimate=await navigator.storage?.estimate?.(), persisted=await navigator.storage?.persisted?.();showSheet('本机存储状态',`<dl class="key-values"><dt>本地数据</dt><dd>${state.carts.length} 台车、${state.items.length} 项物品</dd><dt>网站占用估计</dt><dd>${estimate?Math.round((estimate.usage||0)/1024)+' KB':'此浏览器不提供'}</dd><dt>持久化</dt><dd>${persisted?'已获浏览器保留许可':'尚未获准 / 不支持'}</dd></dl><p class="notice">持久化不保证永不丢失。清理网站数据、换浏览器或换手机不会自动带走清单，仍要保留独立备份。</p>${button('申请浏览器保留本机数据','persist-storage','full')}`);},
    'persist-storage':async()=>{const result=await navigator.storage?.persist?.();notify(result?'浏览器已同意保留数据，仍请备份。':'浏览器未授予持久化或不支持，请继续保留备份。');}
  });
  async function boot(){
    try{
      state=hydrate(await repository.initialize(),{page:'home'});ready=true;render();
      window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;});
      const update=registerSW({immediate:true,onNeedRefresh(){const banner=$('#update-banner');banner.hidden=false;$('#apply-update').onclick=()=>{if(saving||$('#sheet').open||(state.page==='check'&&!state.session?.finished))return notify('请先保存或结束当前录入，再更新页面。');update(true);};},onOfflineReady(){offlineReady=true;notify('离线资源已就绪；业务数据仍只在本机，请定期备份。');},onRegisterError(err){console.warn('离线注册失败',err);}});
      if(import.meta.env.PROD)navigator.serviceWorker.ready.then(()=>{offlineReady=true;const el=$('#cache-status');if(el)el.textContent='离线资源已就绪；仍需独立数据备份。';});
      document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&!$('#sheet').open&&['home','list','detail'].includes(state.page))render();});
      window.addEventListener('online',()=>$('#connection').textContent='本机保存 · 在线');window.addEventListener('offline',()=>$('#connection').textContent='本机保存 · 离线');
      $('#connection').textContent=`本机保存 · ${navigator.onLine?'在线':'离线'}`;
    }catch(err){$('#screen').innerHTML=`<div class="error"><h2>本机数据未能打开</h2><p>${e(shortError(err))}</p><p>未执行清空或重建。请关闭其他版本窗口后刷新；不要清理网站数据。</p></div>`;console.error(err);}
  }
  document.addEventListener('click', async event => {
    const b = event.target.closest('button[data-action]'); if (!b || b.disabled) return;
    if(!ready)return notify('本机数据正在加载，请稍候。');
    try { if(mutatingActions.has(b.dataset.action)) await mutate(()=>actions[b.dataset.action]?.(b)); else await actions[b.dataset.action]?.(b); } catch (err) { console.error(err); notify(err.message||'操作未完成，请重试。'); }
  });
  document.addEventListener('change', event => {
    const el = event.target;
    if (el.id === 'cart-select') return go('list', { cartId: el.value, query: '', type: 'all', filter: 'all' });
    if (el.id === 'filter') { state.filter = el.value; render(); }
    if (el.name === 'result') $('#findings').hidden = el.value !== 'abnormal';
    if (el.id === 'f-precision') {
      $('#expiry-input-wrap').hidden = el.value === 'none';
      $('#f-expiry').placeholder = el.value === 'month' ? '2027-06（只填写年月）' : '2027-06-15（完整日期）';
    }
    if (el.id === 'f-type') { $('#equipment-config').hidden = el.value !== 'equipment'; $('#new-expiry').hidden = !['medicine', 'consumable'].includes(el.value); }
  });
  document.addEventListener('change',async event=>{
    if(event.target.id!=='backup-file')return;
    try{const file=event.target.files[0];if(!file)return;if(file.size>20*1024*1024)throw Error('文件超过当前 20MB 处理限制。');await previewRestore(JSON.parse(await file.text()),file.name);}
    catch(err){const box=$('#backup-error');if(box)box.textContent=shortError(err);else notify(shortError(err));}
  });
  document.addEventListener('input', event => {
    if (event.target.id !== 'search') return;
    state.query = event.target.value; const list = visibleItems(); $('#item-rows').innerHTML = itemRows(list); $('#list-count').textContent = `${list.length} 项物品`;
    const b = $('[data-action="check-list"]'); b.textContent = `逐项检查当前清单（${list.length} 项）`; b.disabled = !list.length;
  });
  document.addEventListener('submit', async event => {
    const form = event.target.closest('form[data-form]'); if (!form) return; event.preventDefault();
    const fd = new FormData(form); const error = $('.error', form); if (error) error.textContent = '';
    try {
      if(form.dataset.form==='restore-confirm'){await performRestore(fd);return;}
      await mutate(() => {
      switch (form.dataset.form) {
        case 'batch-edit': {const it=item(),batch=it.batches.find(b=>b.id===state.editingBatchId),quantity=count(fd.get('quantity'),false),dates=validateExpiry(fd),reason=String(fd.get('reason')||'').trim();if(!reason)throw Error('请填写批次更正原因。');const before=actual(it),oldBatch=structuredClone(batch);batch.number=String(fd.get('number')||'').trim();batch.quantity=quantity;batch.expiry=dates.expiry;batch.precision=dates.precision;it.pendingRecheck=true;state.changes.unshift(createStockChange(it,{batchId:batch.id,before,after:actual(it),label:'批次更正',reason,at:new Date().toISOString(),oldBatch,newBatch:structuredClone(batch)}));closeSheet();render();notify('批次更正已保存，仍待复核。');break;}
        case 'cart-edit': {const c=cart(),name=String(fd.get('name')||'').trim();if(!name)throw Error('请填写车名。');c.name=name;c.department=String(fd.get('department')||'');c.location=String(fd.get('location')||'');closeSheet();render();notify('车配置已保存。');break;}
        case 'template-save': {const name=String(fd.get('name')||'').trim();if(!name)throw Error('请填写模板名称。');const now=new Date().toISOString();const configs=cartItems().map(it=>({type:it.type,name:it.name,specification:it.specification||'',unit:it.unit||'',required:it.required,location:it.location||'',remark:it.remark||'',checklist:it.checklist||[],customValues:it.customValues||{},trackingBatches:!!it.batches}));state.templates.push({id:uid('template'),name,department:cart().department||'',items:configs,version:1,createdAt:now,updatedAt:now,dataPurpose:cart().dataPurpose});closeSheet();render();notify('用户模板已保存，不含实际库存或检查。');break;}
        case 'template-create': {const t=state.templates.find(t=>t.id===state.templateToApply),name=String(fd.get('name')||'').trim();if(!name||!t)throw Error('模板或车名不完整。');const c={id:uid('cart'),name,department:t.department,dataPurpose:t.dataPurpose==='demo'?'demo':'user_configured'};state.carts.push(c);t.items.forEach(config=>{const {trackingBatches,...definition}=config;state.items.push({...definition,id:uid('item'),cartId:c.id,...(trackingBatches?{batches:[],quantityEntered:false}:{actual:null})});});go('list',{cartId:c.id,query:'',type:'all',filter:'all'});notify('新车配置已复制，实际数量未知，检查为空。');break;}
        case 'cart': {
          const name = String(fd.get('name') || '').trim(); if (!name) throw Error('请填写抢救车名称。');
          const c = { id: uid('cart'), name, department: String(fd.get('department') || ''), location: String(fd.get('location') || ''), dataPurpose:'user_configured' }; state.carts.push(c);
          go('list', { cartId: c.id, query: '', type: 'all', filter: 'all' }); notify('抢救车已保存，没有预填临床物品。'); break;
        }
        case 'item': saveItem(form, fd); break;
        case 'batch': {
          const it = item(), quantity = count(fd.get('quantity'), false), ex = validateExpiry(fd), before = actual(it);
          it.batches.push({ id: uid('batch'), number: String(fd.get('number') || '').trim(), quantity, ...ex }); it.quantityEntered = true; it.pendingRecheck = true;
          state.changes.unshift(createStockChange(it,{ batchId:it.batches.at(-1).id, before, after: actual(it), label: '新增批次', reason: '新增批次录入' })); closeSheet(); render(); notify('批次已保存，数量更新后仍待复核。'); break;
        }
        case 'stock': {
          const it = item(), n = count(fd.get('quantity'), false), operation = fd.get('operation'), batch = it.batches?.find(b => b.id === fd.get('batch'));
          const original = batch ? batch.quantity : it.actual;
          if (original === null && operation !== 'adjust') throw Error('实际数量未知，请先选择盘点更正并录入数量。');
          const value = operation === 'use' ? original - n : operation === 'replenish' ? original + n : n;
          if (value < 0) throw Error('使用数量不能超过当前批次数量。');
          if (!Number.isSafeInteger(value)) throw Error('数量超出整数范围，请检查录入值。');
          const before = actual(it); if (batch) batch.quantity = value; else it.actual = value; it.pendingRecheck = true;
          state.changes.unshift(createStockChange(it,{ ...(batch?{batchId:batch.id}:{}), before, after: actual(it), label: ({ use: '使用', replenish: '补充', adjust: '盘点更正' })[operation], reason: String(fd.get('reason') || '').trim() })); closeSheet(); render(); notify('数量和变化记录已保存，尚未完成复核。'); break;
        }
        case 'check': saveCheck(form, fd); break;
        case 'equipment': item().checklist = String(fd.get('checklist') || '').split('\n').map(x => x.trim()).filter(Boolean); closeSheet(); render(); notify('已保存检查项目；项目内容须经过相应确认。'); break;
        case 'rules': { const n = count(fd.get('days'), false); if (n > 3650) throw Error('软件提醒范围为 0 至 3650 天，请缩小输入。'); state.warningDays = n; closeSheet(); render(); notify('提醒规则已保存到本机。'); break; }
        case 'field': { const name = String(fd.get('name') || '').trim(); if (!name) throw Error('请填写字段名称。'); if (state.fields.some(f => f.name === name)) throw Error('已有同名扩展字段。'); state.fields.push({ id: uid('field'), name, kind: fd.get('kind') }); actions['custom-fields'](); notify('已添加扩展字段，在添加或编辑物品的可选信息中填写。'); break; }
      }
      });
    } catch (err) { if (error) error.textContent = err.message; else notify(err.message); }
  });
  boot();
})();
