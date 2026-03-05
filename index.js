const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cors());

// ══════════════════════════════════════
// КОНФИГУРАЦИЯ ЯЩИКОВ
// RESEND_API_KEY_1 = aisya.online (erofeev + aiprod)
// RESEND_API_KEY_2 = aisya.ru (ceo)
// ══════════════════════════════════════
const SENDERS = [
  {
    id: 'erofeev',
    from: 'Данил Ерофеев <erofeev@aisya.online>',
    apiKeyEnv: 'RESEND_API_KEY_1',
    dailyLimit: 80,
  },
  {
    id: 'aiprod',
    from: 'AISYA <ai-prod@aisya.online>',
    apiKeyEnv: 'RESEND_API_KEY_1',
    dailyLimit: 80,
  },
  {
    id: 'ceo',
    from: 'Данил Ерофеев <ceo@aisya.ru>',
    apiKeyEnv: 'RESEND_API_KEY_2',
    dailyLimit: 80,
  },
];

// ══════════════════════════════════════
// ОЧЕРЕДЬ И СОСТОЯНИЕ
// ══════════════════════════════════════
const queue = [];
const sentToday = {};
const lastSentTime = {};
let isProcessing = false;

function resetDailyCounters() {
  const now = new Date();
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;
  setTimeout(() => {
    for (const s of SENDERS) sentToday[s.id] = 0;
    console.log('Daily counters reset');
    resetDailyCounters();
  }, msUntilMidnight);
}
resetDailyCounters();
for (const s of SENDERS) sentToday[s.id] = 0;

// ══════════════════════════════════════
// ВЫБОР ОТПРАВИТЕЛЯ (ротация)
// ══════════════════════════════════════
function pickSender() {
  const available = SENDERS.filter(s => {
    if (!process.env[s.apiKeyEnv]) return false;
    if ((sentToday[s.id] || 0) >= s.dailyLimit) return false;
    return true;
  });
  if (!available.length) return null;
  available.sort((a, b) => (lastSentTime[a.id] || 0) - (lastSentTime[b.id] || 0));
  return available[0];
}

// ══════════════════════════════════════
// ОТПРАВКА ЧЕРЕЗ RESEND API
// ══════════════════════════════════════
async function sendEmail(item) {
  const sender = pickSender();
  if (!sender) {
    item.status = 'error';
    item.error = 'Нет доступных отправителей (лимит или нет API ключа)';
    return;
  }

  const apiKey = process.env[sender.apiKeyEnv];

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: sender.from,
        to: [item.to],
        subject: item.subject,
        html: item.html,
      }),
    });

    const data = await res.json();

    if (res.ok && data.id) {
      item.status = 'sent';
      item.sentAt = new Date().toISOString();
      item.sentFrom = sender.from;
      item.accountId = sender.id;
      sentToday[sender.id] = (sentToday[sender.id] || 0) + 1;
      lastSentTime[sender.id] = Date.now();
      console.log(`✓ Sent to ${item.to} via ${sender.from}`);
    } else {
      item.status = 'error';
      item.error = JSON.stringify(data);
      console.error(`✗ Failed to ${item.to}:`, data);
    }
  } catch (err) {
    item.status = 'error';
    item.error = err.message;
    console.error(`✗ Error:`, err.message);
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

    if (queue.filter(i => i.status === 'pending').length > 0) {
      const pause = (3 + Math.random() * 4) * 60 * 1000;
      console.log(`Waiting ${Math.round(pause / 60000)} min before next...`);
      await new Promise(r => setTimeout(r, pause));
    }
  }

  isProcessing = false;
}

// ══════════════════════════════════════
// API ENDPOINTS
// ══════════════════════════════════════

app.post('/send', (req, res) => {
  const { emails, apiKey } = req.body;
  if (apiKey !== process.env.API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  if (!emails || !Array.isArray(emails) || !emails.length) return res.status(400).json({ error: 'emails array required' });

  const added = [];
  for (const e of emails) {
    if (!e.to || !e.subject || !e.html) continue;
    const item = {
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      to: e.to, subject: e.subject, html: e.html,
      status: 'pending', addedAt: new Date().toISOString(),
      sentAt: null, sentFrom: null, error: null,
    };
    queue.push(item);
    added.push(item.id);
  }

  processQueue().catch(console.error);
  res.json({ ok: true, added: added.length, ids: added });
});

app.get('/status', (req, res) => {
  if (req.query.apiKey !== process.env.API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  res.json({
    total: queue.length,
    pending: queue.filter(i => i.status === 'pending').length,
    sending: queue.filter(i => i.status === 'sending').length,
    sent: queue.filter(i => i.status === 'sent').length,
    error: queue.filter(i => i.status === 'error').length,
    sentToday,
    dailyLimits: Object.fromEntries(SENDERS.map(s => [s.id, s.dailyLimit])),
    accounts: SENDERS.map(s => ({
      id: s.id,
      from: s.from,
      hasKey: !!process.env[s.apiKeyEnv],
      sentToday: sentToday[s.id] || 0,
      limit: s.dailyLimit,
    })),
    queue: queue.slice(-50).map(i => ({
      id: i.id, to: i.to, status: i.status,
      sentFrom: i.sentFrom, addedAt: i.addedAt, sentAt: i.sentAt, error: i.error,
    })),
  });
});

app.post('/clear', (req, res) => {
  if (req.query.apiKey !== process.env.API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  const removed = queue.filter(i => i.status === 'pending').length;
  queue.splice(0, queue.length, ...queue.filter(i => i.status !== 'pending'));
  res.json({ ok: true, removed });
});

app.get('/', (req, res) => res.json({ status: 'AISYA Mailer OK', time: new Date().toISOString() }));
app.get('/ping', (req, res) => res.json({ pong: true, time: new Date().toISOString() }));

const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/ping` : null;
if (SELF_URL) {
  setInterval(() => fetch(SELF_URL).catch(() => {}), 4 * 60 * 1000);
  console.log('Self-ping enabled:', SELF_URL);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AISYA Mailer running on port ${PORT}`));
