const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cors());

// ══════════════════════════════════════
// КОНФИГУРАЦИЯ ЯЩИКОВ
// Пароли берутся из переменных окружения Railway
// ══════════════════════════════════════
const ACCOUNTS = [
  {
    id: 'erofeev',
    user: 'erofeev@aisya.online',
    name: 'Данил Андреевич',
    host: 'smtp.yandex.ru',
    port: 465,
    secure: true,
    passEnv: 'PASS_EROFEEV',
    dailyLimit: 80,
  },
  {
    id: 'aiprod',
    user: 'AI-prod@aisya.online',
    name: 'AISYA',
    host: 'smtp.yandex.ru',
    port: 465,
    secure: true,
    passEnv: 'PASS_AIPROD',
    dailyLimit: 80,
  },
  {
    id: 'mailru',
    user: process.env.MAILRU_ADDRESS || '',
    name: 'Данил Ерофеев',
    host: 'smtp.mail.ru',
    port: 465,
    secure: true,
    passEnv: 'PASS_MAILRU',
    dailyLimit: 80,
  },
];

// ══════════════════════════════════════
// ОЧЕРЕДЬ И СОСТОЯНИЕ
// ══════════════════════════════════════
const queue = [];           // { id, to, subject, html, addedAt, status, sentAt, error, accountId }
const sentToday = {};       // { accountId: count }
const lastSentTime = {};    // { accountId: timestamp }
let isProcessing = false;

// Сброс счётчиков в полночь
function resetDailyCounters() {
  const now = new Date();
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;
  setTimeout(() => {
    for (const acc of ACCOUNTS) sentToday[acc.id] = 0;
    console.log('Daily counters reset');
    resetDailyCounters();
  }, msUntilMidnight);
}
resetDailyCounters();
for (const acc of ACCOUNTS) sentToday[acc.id] = 0;

// ══════════════════════════════════════
// ВЫБОР СЛЕДУЮЩЕГО АККАУНТА (ротация)
// ══════════════════════════════════════
function pickAccount() {
  // Фильтруем аккаунты у которых есть пароль и не превышен лимит
  const available = ACCOUNTS.filter(acc => {
    const pass = process.env[acc.passEnv];
    if (!pass) return false;
    if (!acc.user) return false;
    if ((sentToday[acc.id] || 0) >= acc.dailyLimit) return false;
    return true;
  });
  if (!available.length) return null;

  // Выбираем тот у кого дольше всего не было отправки
  available.sort((a, b) => (lastSentTime[a.id] || 0) - (lastSentTime[b.id] || 0));
  return available[0];
}

// ══════════════════════════════════════
// ОТПРАВКА ОДНОГО ПИСЬМА
// ══════════════════════════════════════
async function sendEmail(item) {
  const acc = pickAccount();
  if (!acc) {
    item.status = 'error';
    item.error = 'Нет доступных аккаунтов (лимит или нет пароля)';
    return;
  }

  const transporter = nodemailer.createTransport({
    host: acc.host,
    port: acc.port,
    secure: acc.secure,
    auth: { user: acc.user, pass: process.env[acc.passEnv] },
    tls: { rejectUnauthorized: false },
  });

  try {
    await transporter.sendMail({
      from: `"${acc.name}" <${acc.user}>`,
      to: item.to,
      subject: item.subject,
      html: item.html,
      headers: {
        'X-Mailer': 'AISYA CRM',
        'X-Priority': '3',
      },
    });

    item.status = 'sent';
    item.sentAt = new Date().toISOString();
    item.accountId = acc.id;
    item.sentFrom = acc.user;
    sentToday[acc.id] = (sentToday[acc.id] || 0) + 1;
    lastSentTime[acc.id] = Date.now();
    console.log(`✓ Sent to ${item.to} via ${acc.user}`);
  } catch (err) {
    item.status = 'error';
    item.error = err.message;
    console.error(`✗ Failed to ${item.to}:`, err.message);
  }
}

// ══════════════════════════════════════
// ОБРАБОТЧИК ОЧЕРЕДИ
// ══════════════════════════════════════
async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  while (true) {
    const pending = queue.filter(i => i.status === 'pending');
    if (!pending.length) break;

    const item = pending[0];
    item.status = 'sending';

    await sendEmail(item);

    // Пауза между письмами: 3-7 минут (случайно)
    if (pending.length > 1) {
      const pause = (3 + Math.random() * 4) * 60 * 1000; // 3-7 мин
      console.log(`Waiting ${Math.round(pause/60000)} min before next...`);
      await new Promise(r => setTimeout(r, pause));
    }
  }

  isProcessing = false;
}

// ══════════════════════════════════════
// API ENDPOINTS
// ══════════════════════════════════════

// Добавить письма в очередь
// POST /send
// Body: { emails: [{to, subject, html}], apiKey: "..." }
app.post('/send', (req, res) => {
  const { emails, apiKey } = req.body;

  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  if (!emails || !Array.isArray(emails) || !emails.length) {
    return res.status(400).json({ error: 'emails array required' });
  }

  const added = [];
  for (const e of emails) {
    if (!e.to || !e.subject || !e.html) continue;
    const item = {
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      to: e.to,
      subject: e.subject,
      html: e.html,
      status: 'pending',
      addedAt: new Date().toISOString(),
      sentAt: null,
      sentFrom: null,
      error: null,
    };
    queue.push(item);
    added.push(item.id);
  }

  // Запускаем обработку в фоне
  processQueue().catch(console.error);

  res.json({ ok: true, added: added.length, ids: added });
});

// Статус очереди
// GET /status?apiKey=...
app.get('/status', (req, res) => {
  if (req.query.apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const stats = {
    total: queue.length,
    pending: queue.filter(i => i.status === 'pending').length,
    sending: queue.filter(i => i.status === 'sending').length,
    sent: queue.filter(i => i.status === 'sent').length,
    error: queue.filter(i => i.status === 'error').length,
    sentToday,
    dailyLimits: Object.fromEntries(ACCOUNTS.map(a => [a.id, a.dailyLimit])),
    accounts: ACCOUNTS.map(a => ({
      id: a.id,
      user: a.user,
      hasPassword: !!process.env[a.passEnv],
      sentToday: sentToday[a.id] || 0,
      limit: a.dailyLimit,
    })),
    queue: queue.slice(-50).map(i => ({
      id: i.id,
      to: i.to,
      status: i.status,
      sentFrom: i.sentFrom,
      addedAt: i.addedAt,
      sentAt: i.sentAt,
      error: i.error,
    })),
  };

  res.json(stats);
});

// Очистить очередь (только pending)
// POST /clear?apiKey=...
app.post('/clear', (req, res) => {
  if (req.query.apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  const before = queue.length;
  const toRemove = queue.filter(i => i.status === 'pending').length;
  queue.splice(0, queue.length, ...queue.filter(i => i.status !== 'pending'));
  res.json({ ok: true, removed: toRemove });
});

// Health check
app.get('/', (req, res) => res.json({ status: 'AISYA Mailer OK', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AISYA Mailer running on port ${PORT}`));
