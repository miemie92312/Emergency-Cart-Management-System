const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function scan(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (forbidden.has(key)) throw new Error(`备份含不允许的字段：${key}`);
    scan(value[key]);
  }
}
export function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
function validKey(key) {
  return (typeof key === 'string' && key.length > 0 && key.length <= 200 && !/[<>"'\u0000-\u001f]/.test(key)) || (typeof key === 'number' && Number.isFinite(key));
}
export function validateLegacy(input, { allowMonth = false } = {}) {
  scan(input);
  if (!plain(input)) throw new Error('备份应为 JSON 对象。');
  if (input.version !== undefined && input.version !== '1.0') throw new Error('不支持这个旧备份版本。');
  const data = input.data ?? input;
  if (!plain(data) || !Array.isArray(data.drugs) || !Array.isArray(data.checks)) throw new Error('旧备份需要 drugs 和 checks 数组。');
  for (const [store, rows] of [['drugs', data.drugs], ['checks', data.checks]]) {
    const ids = new Set();
    rows.forEach((row, i) => {
      const label = `${store} 第 ${i + 1} 条`;
      if (!plain(row) || !validKey(row.id)) throw new Error(`${label} 的 ID 缺失或不安全。`);
      const key = `${typeof row.id}:${row.id}`;
      if (ids.has(key)) throw new Error(`${label} 的 ID 重复。`);
      ids.add(key);
      if (store === 'drugs') {
        if (typeof row.name !== 'string' || !row.name.trim()) throw new Error(`${label} 缺少名称。`);
        for (const prop of ['quantity', 'minimumQuantity']) {
          if (prop === 'minimumQuantity' && row[prop] === undefined) continue;
          if (!Number.isSafeInteger(row[prop]) || row[prop] < 0) throw new Error(`${label} 的 ${prop} 必须是非负整数。`);
        }
        if (row.expiryDate && !validDay(row.expiryDate) && !(allowMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(row.expiryDate))) throw new Error(`${label} 的有效期不能安全解释，请检查日期原值。`);
      } else {
        if (!validKey(row.drugId)) throw new Error(`${label} 缺少原物品引用。`);
        if (row.checkedAt && (typeof row.checkedAt !== 'string' || !Number.isFinite(Date.parse(row.checkedAt)))) throw new Error(`${label} 的检查时间无效。`);
      }
      for (const prop of ['name', 'specification', 'batchNumber', 'location', 'remark', 'checker']) if (row[prop] !== undefined && (typeof row[prop] !== 'string' || row[prop].length > 10000)) throw new Error(`${label} 的 ${prop} 格式不正确。`);
    });
  }
  const settings = data.settings ?? {};
  if (!plain(settings)) throw new Error('settings 应为对象。');
  if (settings.warningDays !== undefined && (!Number.isSafeInteger(settings.warningDays) || settings.warningDays < 0 || settings.warningDays > 3650)) throw new Error('预警天数必须为 0 至 3650 的整数。');
  if (settings.lastChecker !== undefined && typeof settings.lastChecker !== 'string') throw new Error('检查人设置格式不正确。');
  return structuredClone({ drugs: data.drugs, checks: data.checks, settings });
}
export function requestStore(database, storeName, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('事务已中止，数据未保存。'));
    tx.onerror = () => {};
    try {
      const request = action(tx.objectStore(storeName), tx);
      request.onsuccess = () => { result = request.result; };
    } catch (err) { tx.abort(); reject(err); }
  });
}
export function readLegacySnapshot(database) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(['drugs', 'checks', 'settings'], 'readonly');
    const snapshot = { drugs: [], checks: [], settings: Object.create(null) };
    for (const name of ['drugs', 'checks', 'settings']) {
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => {
        if (name === 'settings') req.result.forEach(({ key, value }) => { if (!forbidden.has(key)) snapshot.settings[key] = value; });
        else snapshot[name] = req.result;
      };
    }
    tx.oncomplete = () => resolve(snapshot);
    tx.onabort = () => reject(tx.error || new Error('读取备份失败。'));
    tx.onerror = () => {};
  });
}
export function restoreLegacy(database, validated) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(['drugs', 'checks', 'settings'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('恢复事务失败，原数据未改变。'));
    tx.onerror = () => {};
    try {
      for (const name of ['drugs', 'checks', 'settings']) tx.objectStore(name).clear();
      validated.drugs.forEach(row => tx.objectStore('drugs').add(row));
      validated.checks.forEach(row => tx.objectStore('checks').add(row));
      Object.entries(validated.settings).forEach(([key, value]) => tx.objectStore('settings').add({ key, value }));
    } catch (err) { tx.abort(); reject(err); }
  });
}
