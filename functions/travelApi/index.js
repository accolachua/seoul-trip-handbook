const http = require('node:http');
const crypto = require('node:crypto');

const MEMBERS = ['熊', '熊大仙', 'Heidi', '陈汇聪', 'Ava'];
const TYPES = new Set(['todos', 'shopping', 'expenses', 'receipts']);
const ENV_ID = process.env.TCB_ENV || process.env.SCF_NAMESPACE || process.env.CLOUDBASE_ENV_ID || 'dev-d8gxdqvok64864d6d';
const DB_URL = `https://${ENV_ID}.api.tcloudbasegateway.com/v1/rdb/rest/travel_data`;
const FALLBACK_RATES = {
  CNY: 1,
  KRW: 0.0052,
  HKD: 0.92,
  USD: 7.1,
  EUR: 7.8,
  updatedAt: 0,
  source: '备用汇率，请手动核对',
};

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const text = (value, max = 200) => String(value ?? '').trim().slice(0, max);
const newId = () => crypto.randomUUID();
const authOk = input => input._editPassword === process.env.EDIT_PASSWORD;

async function dbRequest(path = '', options = {}) {
  const key = process.env.CLOUDBASE_API_KEY;
  if (!key) throw new Error('数据库服务未配置');
  const response = await fetch(DB_URL + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) {
    const message = data?.message || data?.error || `数据库请求失败（${response.status}）`;
    throw new Error(message);
  }
  return data;
}

async function readList(kind) {
  const query = `?kind=eq.${encodeURIComponent(kind)}&select=item_id,data,updated_at&order=updated_at.desc`;
  const rows = await dbRequest(query, { method: 'GET' });
  return (rows || []).map(row => ({ ...row.data, id: row.item_id }));
}

async function addItem(kind, item) {
  const id = item.id || newId();
  const data = { ...item };
  delete data.id;
  await dbRequest('', {
    method: 'POST',
    body: JSON.stringify({ kind, item_id: id, data }),
    prefer: 'return=representation',
  });
  return { ...data, id };
}

async function deleteItem(kind, id) {
  const path = `?kind=eq.${encodeURIComponent(kind)}&item_id=eq.${encodeURIComponent(id)}`;
  await dbRequest(path, { method: 'DELETE', prefer: 'return=minimal' });
}

async function updateTodo(id, completed) {
  const path = `?kind=eq.todos&item_id=eq.${encodeURIComponent(id)}&select=item_id,data`;
  const rows = await dbRequest(path, { method: 'GET' });
  const row = rows?.[0];
  if (!row) return null;
  const data = {
    ...row.data,
    completed: Boolean(completed),
    status: completed ? '已完成' : '待办',
    completedAt: completed ? Date.now() : null,
  };
  await dbRequest(`?kind=eq.todos&item_id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ data, updated_at: new Date().toISOString() }),
    prefer: 'return=representation',
  });
  return { ...data, id };
}

function normalizeExpense(expense) {
  const row = {
    ...expense,
    amount: Number(expense.amount),
    rate: Number(expense.rate),
    shares: (expense.shares || []).map(share => ({ ...share, amount: Number(share.amount) })),
  };
  const totalCents = Math.round(row.amount * row.rate * 100);
  const shareCents = row.shares.map(share => Math.round(share.amount * 100));
  let diff = totalCents - shareCents.reduce((sum, amount) => sum + amount, 0);
  const payerIndex = Math.max(0, row.shares.findIndex(share => share.member === row.payer));
  if (diff !== 0 && shareCents[payerIndex] + diff >= 0) shareCents[payerIndex] += diff;
  row.shares = row.shares.map((share, index) => ({ ...share, amount: shareCents[index] / 100 }));
  return row;
}

function validateExpense(input) {
  const amount = Number(input.amount);
  const rate = Number(input.rate);
  if (!Number.isFinite(amount) || amount <= 0) return '金额必须大于 0';
  if (!Number.isFinite(rate) || rate <= 0) return '汇率必须大于 0';
  if (text(input.currency, 6) === 'CNY' && Math.abs(rate - 1) > 0.000001) return '人民币账目的汇率必须为 1';
  if (!MEMBERS.includes(input.payer) || !Array.isArray(input.shares) || !input.shares.length) return '付款人或参与人无效';
  if (input.shares.some(share => !MEMBERS.includes(share.member) || Number(share.amount) < 0)) return '分摊成员或金额无效';
  const shareTotal = input.shares.reduce((sum, share) => sum + Math.round(Number(share.amount || 0) * 100), 0);
  if (shareTotal !== Math.round(amount * rate * 100)) return '分摊金额合计必须精确等于折算后的人民币金额';
  return '';
}

function outstanding(expenses, receipts) {
  const debts = Object.fromEntries(MEMBERS.map(from => [from, Object.fromEntries(MEMBERS.map(to => [to, 0]))]));
  expenses.map(normalizeExpense).forEach(expense => {
    expense.shares.forEach(share => {
      if (share.member !== expense.payer) debts[share.member][expense.payer] += Math.round(share.amount * 100);
    });
  });
  receipts.forEach(receipt => {
    if (debts[receipt.from]?.[receipt.to] !== undefined) debts[receipt.from][receipt.to] -= Math.round(Number(receipt.amount) * 100);
  });
  const transfers = [];
  for (let i = 0; i < MEMBERS.length; i += 1) {
    for (let j = i + 1; j < MEMBERS.length; j += 1) {
      const first = MEMBERS[i];
      const second = MEMBERS[j];
      const delta = debts[first][second] - debts[second][first];
      if (delta > 0) transfers.push({ from: first, to: second, amount: delta / 100 });
      if (delta < 0) transfers.push({ from: second, to: first, amount: -delta / 100 });
    }
  }
  return transfers;
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/^\/api(?=\/)/, '');
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let input = {};
  try { input = raw ? JSON.parse(raw) : {}; } catch { input = {}; }

  if (path === '/config') {
    if (req.method === 'GET') return send(res, 200, { ok: true, members: MEMBERS, baseCurrency: 'CNY' });
    if (req.method === 'POST') return send(res, authOk(input) ? 200 : 401, authOk(input) ? { ok: true } : { ok: false, error: '编辑密码错误' });
  }

  if (path === '/rates' && req.method === 'GET') {
    try {
      const response = await fetch('https://api.frankfurter.app/latest?from=CNY&to=KRW,HKD,USD,EUR');
      if (!response.ok) throw new Error('汇率服务异常');
      const data = await response.json();
      return send(res, 200, {
        ok: true,
        rates: {
          CNY: 1,
          KRW: 1 / Number(data.rates.KRW),
          HKD: 1 / Number(data.rates.HKD),
          USD: 1 / Number(data.rates.USD),
          EUR: 1 / Number(data.rates.EUR),
          updatedAt: Date.now(),
          source: 'Frankfurter / ECB reference rates',
        },
      });
    } catch {
      return send(res, 200, { ok: true, rates: FALLBACK_RATES });
    }
  }

  const match = path.match(/^\/(todos|shopping|expenses|receipts)(?:\/([^/]+))?$/);
  if (!match || !TYPES.has(match[1])) return send(res, 404, { ok: false, error: 'Not found' });
  const [, type, id] = match;

  if (req.method === 'GET' && !id) return send(res, 200, { ok: true, items: await readList(type) });
  if (!authOk(input)) return send(res, 401, { ok: false, error: '编辑密码错误' });

  if (id && type === 'todos' && req.method === 'POST' && input._action === 'toggle') {
    if (typeof input.completed !== 'boolean') return send(res, 400, { ok: false, error: '待办完成状态无效' });
    const item = await updateTodo(id, input.completed);
    if (!item) return send(res, 404, { ok: false, error: '待办事项不存在' });
    return send(res, 200, { ok: true, item });
  }

  if (id && req.method === 'POST' && input._action === 'delete') {
    await deleteItem(type, id);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && !id) {
    const { _editPassword, _action, ...payload } = input;
    let item;
    if (type === 'todos') {
      if (!text(payload.text)) return send(res, 400, { ok: false, error: '待办内容不能为空' });
      item = { text: text(payload.text), note: text(payload.note), status: '待办', completed: false, completedAt: null, createdAt: Date.now() };
    } else if (type === 'shopping') {
      if (!text(payload.product)) return send(res, 400, { ok: false, error: '商品名称不能为空' });
      item = { brand: text(payload.brand, 80), product: text(payload.product), purpose: text(payload.purpose), price: text(payload.price, 80), channel: text(payload.channel), createdAt: Date.now() };
    } else if (type === 'expenses') {
      const error = validateExpense(payload);
      if (error) return send(res, 400, { ok: false, error });
      item = {
        date: text(payload.date, 20),
        category: text(payload.category, 60),
        description: text(payload.description),
        amount: Number(payload.amount),
        currency: text(payload.currency, 6),
        rate: Number(payload.rate),
        payer: payload.payer,
        shares: payload.shares.map(share => ({ member: share.member, amount: Number(share.amount) })),
        createdAt: Date.now(),
      };
    } else {
      const amount = Number(payload.amount);
      const current = outstanding(await readList('expenses'), await readList('receipts'))
        .find(transfer => transfer.from === payload.from && transfer.to === payload.to);
      if (!MEMBERS.includes(payload.from) || !MEMBERS.includes(payload.to) || payload.from === payload.to || !Number.isFinite(amount) || amount <= 0 || !current || Math.abs(current.amount - amount) > 0.009) {
        return send(res, 409, { ok: false, error: '该笔待收金额已变化，请刷新后重试' });
      }
      item = { from: payload.from, to: payload.to, amount: Math.round(amount * 100) / 100, receivedAt: Date.now() };
    }
    return send(res, 201, { ok: true, item: await addItem(type, item) });
  }

  return send(res, 405, { ok: false, error: 'Method not allowed' });
}

const server = http.createServer((req, res) => handle(req, res).catch(error => {
  console.error(error);
  send(res, 500, { ok: false, error: error.message || '服务异常' });
}));
server.listen(process.env.PORT || 9000, '0.0.0.0');
