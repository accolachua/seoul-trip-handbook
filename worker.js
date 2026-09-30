const MEMBERS = ['熊', '熊大仙', 'Heidi', '陈汇聪', 'Ava'];
const ALLOWED_TYPES = new Set(['todos', 'shopping', 'expenses', 'receipts']);
const ALLOWED_ORIGINS = new Set([
  'https://bytedance.doubaoapps.com',
  'https://seoul-trip-handbook.604107556.workers.dev',
  'https://dev-d8gxdqvok64864d6d-1454994890.tcloudbaseapp.com'
]);

function corsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'Content-Type,X-Edit-Password',
    'access-control-max-age': '86400',
    'vary': 'Origin'
  };
  if (ALLOWED_ORIGINS.has(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
}

function response(data, status = 200, request) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders(request) });
}

function normalizeExpenseRecord(item) {
  const row = { ...item, shares: Array.isArray(item.shares) ? item.shares.map(s => ({ ...s, amount: Number(s.amount) })) : [] };
  let changed = false;
  if (row.currency === 'CNY' && Number(row.amount) === 1 && Number(row.rate) > 100) {
    row.amount = Number(row.rate);
    row.rate = 1;
    changed = true;
  }
  const totalCents = Math.round(Number(row.amount) * Number(row.rate) * 100);
  const sharesCents = row.shares.map(s => Math.round(Number(s.amount) * 100));
  let diff = totalCents - sharesCents.reduce((sum, cents) => sum + cents, 0);
  if (diff !== 0) changed = true;
  const preferred = Math.max(0, row.shares.findIndex(s => s.member === row.payer));
  if (diff !== 0 && sharesCents[preferred] + diff >= 0) {
    sharesCents[preferred] += diff;
    diff = 0;
  }
  row.shares = row.shares.map((s, i) => ({ ...s, amount: sharesCents[i] / 100 }));
  return { row, changed };
}

async function readList(env, type) {
  const list = (await env.SHARED_DATA.get(type, 'json')) || [];
  if (type !== 'expenses') return list;
  let changed = false;
  const normalized = list.map(item => {
    const result = normalizeExpenseRecord(item);
    changed ||= result.changed;
    return result.row;
  });
  if (changed) await env.SHARED_DATA.put(type, JSON.stringify(normalized));
  return normalized;
}

async function requireAuth(request, env) {
  const password = request.headers.get('x-edit-password') || '';
  if (!env.EDIT_PASSWORD || password !== env.EDIT_PASSWORD) {
    return response({ ok: false, error: '编辑密码错误' }, 401, request);
  }
  return null;
}

function safeText(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function validateExpense(input) {
  const amount = Number(input.amount);
  const rate = Number(input.rate);
  if (!Number.isFinite(amount) || amount <= 0) return '金额必须大于 0';
  if (!Number.isFinite(rate) || rate <= 0) return '汇率必须大于 0';
  if (safeText(input.currency, 6) === 'CNY' && Math.abs(rate - 1) > 0.000001) return '人民币账目的汇率必须为 1';
  if (!MEMBERS.includes(input.payer)) return '付款人无效';
  if (!Array.isArray(input.shares) || !input.shares.length) return '至少选择一位参与人';
  const totalSharesCents = input.shares.reduce((sum, row) => sum + Math.round(Number(row.amount || 0) * 100), 0);
  const cnyCents = Math.round(amount * rate * 100);
  if (totalSharesCents !== cnyCents) return '分摊金额合计必须精确等于折算后的人民币金额';
  if (input.shares.some(row => !MEMBERS.includes(row.member) || Number(row.amount) < 0)) return '参与人或分摊金额无效';
  return '';
}

function getOutstandingTransfers(expenses, receipts) {
  const debts = Object.fromEntries(MEMBERS.map(from => [from, Object.fromEntries(MEMBERS.map(to => [to, 0]))]));
  expenses.map(item => normalizeExpenseRecord(item).row).forEach(item => {
    item.shares.forEach(share => {
      if (share.member !== item.payer && MEMBERS.includes(share.member) && MEMBERS.includes(item.payer)) {
        debts[share.member][item.payer] += Math.round(Number(share.amount) * 100);
      }
    });
  });
  receipts.forEach(item => {
    if (MEMBERS.includes(item.from) && MEMBERS.includes(item.to)) {
      debts[item.from][item.to] -= Math.round(Number(item.amount) * 100);
    }
  });
  const transfers = [];
  for (let i = 0; i < MEMBERS.length; i++) {
    for (let j = i + 1; j < MEMBERS.length; j++) {
      const left = MEMBERS[i], right = MEMBERS[j];
      const delta = debts[left][right] - debts[right][left];
      if (delta > 0) transfers.push({ from: left, to: right, amount: delta / 100 });
      else if (delta < 0) transfers.push({ from: right, to: left, amount: -delta / 100 });
    }
  }
  return transfers;
}

async function exchangeRates(env) {
  const cached = await env.SHARED_DATA.get('rates', 'json');
  if (cached && Date.now() - cached.updatedAt < 6 * 3600 * 1000) return cached;
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=CNY&to=KRW,HKD,USD,EUR');
    if (!res.ok) throw new Error('rate');
    const data = await res.json();
    const rates = {
      CNY: 1,
      KRW: 1 / Number(data.rates.KRW),
      HKD: 1 / Number(data.rates.HKD),
      USD: 1 / Number(data.rates.USD),
      EUR: 1 / Number(data.rates.EUR),
      updatedAt: Date.now(),
      source: 'Frankfurter / ECB reference rates'
    };
    await env.SHARED_DATA.put('rates', JSON.stringify(rates), { expirationTtl: 86400 });
    return rates;
  } catch {
    return cached || { CNY: 1, KRW: 0.0052, HKD: 0.92, USD: 7.1, EUR: 7.8, updatedAt: 0, source: '备用汇率，请手动核对' };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    if (request.method === 'OPTIONS') {
      if (origin && !ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (url.pathname === '/api/auth' && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      return authError || response({ ok: true }, 200, request);
    }
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return response({ ok: true, members: MEMBERS, baseCurrency: 'CNY' }, 200, request);
    }
    if (url.pathname === '/api/rates' && request.method === 'GET') {
      return response({ ok: true, rates: await exchangeRates(env) }, 200, request);
    }
    const match = url.pathname.match(/^\/api\/(todos|shopping|expenses|receipts)(?:\/([^/]+))?$/);
    if (!match || !ALLOWED_TYPES.has(match[1])) return response({ ok: false, error: 'Not found' }, 404, request);
    const type = match[1];
    const id = match[2];
    if (request.method === 'GET' && !id) return response({ ok: true, items: await readList(env, type) }, 200, request);

    const authError = await requireAuth(request, env);
    if (authError) return authError;
    const list = await readList(env, type);

    if (request.method === 'POST' && !id) {
      const input = await request.json();
      let item;
      if (type === 'todos') {
        const text = safeText(input.text);
        if (!text) return response({ ok: false, error: '请输入待办内容' }, 400, request);
        item = { id: crypto.randomUUID(), text, note: safeText(input.note), status: '待办', createdAt: Date.now() };
      } else if (type === 'shopping') {
        const product = safeText(input.product);
        if (!product) return response({ ok: false, error: '请输入商品名称' }, 400, request);
        item = { id: crypto.randomUUID(), brand: safeText(input.brand, 80), product, purpose: safeText(input.purpose), price: safeText(input.price, 80), channel: safeText(input.channel), createdAt: Date.now() };
      } else if (type === 'receipts') {
        const from = safeText(input.from, 40), to = safeText(input.to, 40), amount = Number(input.amount);
        if (!MEMBERS.includes(from) || !MEMBERS.includes(to) || from === to || !Number.isFinite(amount) || amount <= 0) return response({ ok: false, error: '收款记录无效' }, 400, request);
        const outstanding = getOutstandingTransfers(await readList(env, 'expenses'), list).find(row => row.from === from && row.to === to);
        if (!outstanding || Math.abs(outstanding.amount - amount) > 0.009) return response({ ok: false, error: '该笔待收金额已变化，请刷新后重试' }, 409, request);
        item = { id: crypto.randomUUID(), from, to, amount: Math.round(amount * 100) / 100, receivedAt: Date.now() };
      } else {
        const error = validateExpense(input);
        if (error) return response({ ok: false, error }, 400, request);
        item = { id: crypto.randomUUID(), date: safeText(input.date, 20), category: safeText(input.category, 60), description: safeText(input.description), amount: Number(input.amount), currency: safeText(input.currency, 6), rate: Number(input.rate), payer: input.payer, shares: input.shares.map(row => ({ member: row.member, amount: Number(row.amount) })), createdAt: Date.now() };
      }
      list.unshift(item);
      await env.SHARED_DATA.put(type, JSON.stringify(list));
      return response({ ok: true, item }, 201, request);
    }

    if (request.method === 'DELETE' && id) {
      const next = list.filter(item => item.id !== id);
      if (next.length === list.length) return response({ ok: false, error: '记录不存在' }, 404, request);
      await env.SHARED_DATA.put(type, JSON.stringify(next));
      return response({ ok: true }, 200, request);
    }
    return response({ ok: false, error: 'Method not allowed' }, 405, request);
  }
};
