import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadDotEnv();

const PORT = Number(process.env.PORT || 8787) || 8787;
const BOT_TOKEN = String(process.env.BOT_TOKEN || '').trim();
const CHAT_ID = String(process.env.CHAT_ID || '').trim();
const LEAD_LOG_FILE = String(process.env.LEAD_LOG_FILE || '').trim();

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  console.warn(
    '[lead-server] ALLOWED_ORIGINS пуст — CORS отклонит браузерные запросы с github.io. Задайте в .env.'
  );
}

const contactLabels = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  max: 'MAX',
  call: 'Звонок',
};

/** @type {Map<string, number[]>} */
const rateBuckets = new Map();
const RL_MAX = 12;
const RL_WINDOW_SEC = 300;

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return String(req.socket.remoteAddress || '0.0.0.0');
}

function rateLimitAllow(ip) {
  const now = Math.floor(Date.now() / 1000);
  let times = rateBuckets.get(ip) || [];
  times = times.filter((t) => t > now - RL_WINDOW_SEC);
  if (times.length >= RL_MAX) {
    rateBuckets.set(ip, times);
    return false;
  }
  times.push(now);
  rateBuckets.set(ip, times);
  if (rateBuckets.size > 5000) {
    for (const [k, arr] of rateBuckets) {
      if (arr.every((t) => t <= now - RL_WINDOW_SEC)) rateBuckets.delete(k);
    }
  }
  return true;
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  if (!origin) {
    return h;
  }
  if (allowedOrigins.includes(origin)) {
    return { ...h, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  return h;
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleLead(req, res) {
  const cors = corsHeaders(req);
  const origin = req.headers.origin;
  if (origin && !cors['Access-Control-Allow-Origin']) {
    sendJson(res, 403, { ok: false, error: 'cors_forbidden' }, cors);
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, cors);
    return;
  }

  let raw;
  try {
    raw = await readBody(req, 65536);
  } catch (e) {
    if (e && e.message === 'payload_too_large') {
      sendJson(res, 413, { ok: false, error: 'payload_too_large' }, cors);
      return;
    }
    sendJson(res, 400, { ok: false, error: 'invalid_json' }, cors);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw || 'null');
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid_json' }, cors);
    return;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    sendJson(res, 400, { ok: false, error: 'invalid_json' }, cors);
    return;
  }

  if (String(payload.website || '').trim() !== '') {
    sendJson(res, 200, { ok: true }, cors);
    return;
  }

  const ip = clientIp(req);
  if (!rateLimitAllow(ip)) {
    sendJson(res, 429, { ok: false, error: 'rate_limited' }, cors);
    return;
  }

  const name = String(payload.name || '').trim();
  const phone = String(payload.phone || '').trim();
  let comment = String(payload.comment || '').trim();
  let context = String(payload.context || '').trim();
  const contact = String(payload.contact || '').trim();

  if (phone.length > 40) {
    sendJson(res, 400, { ok: false, error: 'invalid_phone' }, cors);
    return;
  }
  if (name === '' || [...name].length > 120) {
    sendJson(res, 400, { ok: false, error: 'invalid_name' }, cors);
    return;
  }
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) {
    sendJson(res, 400, { ok: false, error: 'invalid_phone' }, cors);
    return;
  }
  if ([...comment].length > 2000) {
    sendJson(res, 400, { ok: false, error: 'invalid_comment' }, cors);
    return;
  }
  if ([...context].length > 500) {
    sendJson(res, 400, { ok: false, error: 'invalid_context' }, cors);
    return;
  }
  if ([...contact].length > 80) {
    sendJson(res, 400, { ok: false, error: 'invalid_contact' }, cors);
    return;
  }
  if (contact !== '' && !Object.prototype.hasOwnProperty.call(contactLabels, contact)) {
    sendJson(res, 400, { ok: false, error: 'invalid_contact' }, cors);
    return;
  }

  if (BOT_TOKEN === '' || CHAT_ID === '') {
    sendJson(res, 503, { ok: false, error: 'telegram_not_configured' }, cors);
    return;
  }

  const contactHuman = contact !== '' ? contactLabels[contact] : '';
  const lines = ['СтройФаст — заявка с сайта', `Имя: ${name}`, `Телефон: ${phone}`];
  if (context !== '') lines.push(`Тема: ${context}`);
  if (comment !== '') lines.push(`Комментарий: ${comment}`);
  if (contact !== '') lines.push(`Связь: ${contactHuman}`);
  let text = lines.join('\n');
  if ([...text].length > 4000) {
    text = [...text].slice(0, 3990).join('') + '…';
  }

  const tgUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = new URLSearchParams({
    chat_id: CHAT_ID,
    text,
    disable_web_page_preview: '1',
  });

  let tgRes;
  try {
    tgRes = await fetch(tgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    sendJson(res, 502, { ok: false, error: 'telegram_send_failed' }, cors);
    return;
  }

  let tgJson;
  try {
    tgJson = await tgRes.json();
  } catch {
    sendJson(res, 502, { ok: false, error: 'telegram_send_failed' }, cors);
    return;
  }
  if (!tgJson || !tgJson.ok) {
    sendJson(res, 502, { ok: false, error: 'telegram_send_failed' }, cors);
    return;
  }

  if (LEAD_LOG_FILE) {
    const logPath = path.isAbsolute(LEAD_LOG_FILE)
      ? LEAD_LOG_FILE
      : path.join(__dirname, LEAD_LOG_FILE);
    const logLine = JSON.stringify({
      t: new Date().toISOString(),
      ip,
      name,
      phone,
      context,
      contact,
      comment,
    });
    try {
      fs.appendFileSync(logPath, logLine + '\n', { flag: 'a' });
    } catch {
      // ignore
    }
  }

  sendJson(res, 200, { ok: true }, cors);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = u.pathname.replace(/\/+$/, '') || '/';
  if (pathname === '/lead' || pathname === '/telegram_notify.php') {
    handleLead(req, res).catch(() => {
      sendJson(res, 500, { ok: false, error: 'server_error' }, corsHeaders(req));
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(
    `[lead-server] http://127.0.0.1:${PORT}/lead (и /telegram_notify.php). CORS: ${allowedOrigins.length ? allowedOrigins.join(', ') : '(нет — задайте ALLOWED_ORIGINS)'}`
  );
});
