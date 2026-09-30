const MEMBERS = ['熊', '熊大仙', 'Heidi', '陈汇聪', 'Ava'];
const ALLOWED_TYPES = new Set(['todos', 'shopping', 'expenses']);
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function readList(env, type) {
  return (await env.SHARED_DATA.get(type, 'json')) || [];
}

async function requireAuth(request, env) {
  const password = request.headers.get('x-edit-password') || '';
  if (!env.EDIT_PASSWORD || password !== env.EDIT_PASSWORD) {
    return response({ ok: false, error: '编辑密码错误' }, 401);
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
  if (!MEMBERS.includes(input.payer)) return '付款人无效';
  if (!Array.isArray(input.shares) || !input.shares.length) return '至少选择一位参与人';
  const totalShares = input.shares.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const cny = amount * rate;
  if (Math.abs(totalShares - cny) > 0.02) return '分摊金额合计必须等于折算后的人民币金额';
  if (input.shares.some(row => !MEMBERS.includes(row.member) || Number(row.amount) < 0)) return '参与人或分摊金额无效';
  return '';
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
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (url.pathname === '/api/config' && request.method === 'GET') {
      return response({ ok: true, members: MEMBERS, baseCurrency: 'CNY' });
    }
    if (url.pathname === '/api/rates' && request.method === 'GET') {
      return response({ ok: true, rates: await exchangeRates(env) });
    }
    const match = url.pathname.match(/^\/api\/(todos|shopping|expenses)(?:\/([^/]+))?$/);
    if (!match || !ALLOWED_TYPES.has(match[1])) return response({ ok: false, error: 'Not found' }, 404);
    const type = match[1];
    const id = match[2];
    if (request.method === 'GET' && !id) return response({ ok: true, items: await readList(env, type) });

    const authError = await requireAuth(request, env);
    if (authError) return authError;
    const list = await readList(env, type);

    if (request.method === 'POST' && !id) {
      const input = await request.json();
      let item;
      if (type === 'todos') {
        const text = safeText(input.text);
        if (!text) return response({ ok: false, error: '请输入待办内容' }, 400);
        item = { id: crypto.randomUUID(), text, note: safeText(input.note), status: '待办', createdAt: Date.now() };
      } else if (type === 'shopping') {
        const product = safeText(input.product);
        if (!product) return response({ ok: false, error: '请输入商品名称' }, 400);
        item = { id: crypto.randomUUID(), brand: safeText(input.brand, 80), product, purpose: safeText(input.purpose), price: safeText(input.price, 80), channel: safeText(input.channel), createdAt: Date.now() };
      } else {
        const error = validateExpense(input);
        if (error) return response({ ok: false, error }, 400);
        item = { id: crypto.randomUUID(), date: safeText(input.date, 20), category: safeText(input.category, 60), description: safeText(input.description), amount: Number(input.amount), currency: safeText(input.currency, 6), rate: Number(input.rate), payer: input.payer, shares: input.shares.map(row => ({ member: row.member, amount: Number(row.amount) })), createdAt: Date.now() };
      }
      list.unshift(item);
      await env.SHARED_DATA.put(type, JSON.stringify(list));
      return response({ ok: true, item }, 201);
    }

    if (request.method === 'DELETE' && id) {
      const next = list.filter(item => item.id !== id);
      if (next.length === list.length) return response({ ok: false, error: '记录不存在' }, 404);
      await env.SHARED_DATA.put(type, JSON.stringify(next));
      return response({ ok: true });
    }
    return response({ ok: false, error: 'Method not allowed' }, 405);
  }
};
