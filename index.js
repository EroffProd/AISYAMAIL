const express = require('express');
const cors    = require('cors');
const app     = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// ══════════════════════════════════════
// ЯЩИКИ  (ключи берём из Railway env)
// ══════════════════════════════════════
const SENDERS = [
  { id:'erofeev', from:'Данил Ерофеев <erofeev@aisya.online>', apiKeyEnv:'RESEND_API_KEY_1', dailyLimit:80 },
  { id:'aiprod',  from:'AISYA <ai-prod@aisya.online>',         apiKeyEnv:'RESEND_API_KEY_1', dailyLimit:80 },
  { id:'ceo',     from:'Данил Ерофеев <ceo@aisya.ru>',         apiKeyEnv:'RESEND_API_KEY_2', dailyLimit:80 },
];

// ══════════════════════════════════════
// СОСТОЯНИЕ
// ══════════════════════════════════════
const queue       = [];     // все письма
const sentToday   = {};
const lastSentTime= {};
let isProcessing  = false;
let isPaused      = false;  // пауза (письма стоят, не удаляются)
let isStopped     = false;  // стоп  (processQueue завершается)

for (const s of SENDERS) sentToday[s.id] = 0;
function resetDaily() {
  const ms = new Date(new Date().setHours(24,0,0,0)) - Date.now();
  setTimeout(() => { for(const s of SENDERS) sentToday[s.id]=0; console.log('Daily reset'); resetDaily(); }, ms);
}
resetDaily();

// ══════════════════════════════════════
// РАСПИСАНИЕ (МСК = UTC+3)
// SCHEDULE_START / SCHEDULE_END / SCHEDULE_DAYS
// ══════════════════════════════════════
function isWorkingTime() {
  const msk     = new Date(Date.now() + 3*60*60*1000);
  const h = msk.getUTCHours(), m = msk.getUTCMinutes();
  const dow = msk.getUTCDay() === 0 ? 7 : msk.getUTCDay();
  const now = h*60+m;
  const [sh,sm] = (process.env.SCHEDULE_START||'8:30').split(':').map(Number);
  const [eh,em] = (process.env.SCHEDULE_END  ||'18:00').split(':').map(Number);
  const days = (process.env.SCHEDULE_DAYS||'1,2,3,4,5').split(',').map(Number);
  if (!days.includes(dow)) return { ok:false, reason:`выходной (${dow})` };
  if (now < sh*60+sm)      return { ok:false, reason:`рано (${h}:${String(m).padStart(2,'0')} МСК, старт ${process.env.SCHEDULE_START||'8:30'})` };
  if (now >= eh*60+em)     return { ok:false, reason:`поздно (${h}:${String(m).padStart(2,'0')} МСК, конец ${process.env.SCHEDULE_END||'18:00'})` };
  return { ok:true };
}
function minsUntilStart() {
  const msk = new Date(Date.now()+3*60*60*1000);
  const now = msk.getUTCHours()*60+msk.getUTCMinutes();
  const [sh,sm] = (process.env.SCHEDULE_START||'8:30').split(':').map(Number);
  const s = sh*60+sm;
  return now < s ? s-now : 24*60-now+s;
}

// ══════════════════════════════════════
// ВЫБОР ОТПРАВИТЕЛЯ (ротация)
// ══════════════════════════════════════
function pickSender() {
  const avail = SENDERS.filter(s => process.env[s.apiKeyEnv] && (sentToday[s.id]||0) < s.dailyLimit);
  if (!avail.length) return null;
  avail.sort((a,b) => (lastSentTime[a.id]||0)-(lastSentTime[b.id]||0));
  return avail[0];
}

// ══════════════════════════════════════
// ОТПРАВКА
// ══════════════════════════════════════
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;

async function sendEmail(item) {
  const sender = pickSender();
  if (!sender) { item.status='error'; item.error='Нет отправителей'; return; }
  const apiKey = process.env[sender.apiKeyEnv];
  const trackImg = SELF_URL ? `<img src="${SELF_URL}/track/${item.id}" width="1" height="1" style="display:none">` : '';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{ Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ from:sender.from, to:[item.to], subject:item.subject, html:item.html+trackImg }),
    });
    const data = await res.json();
    if (res.ok && data.id) {
      item.status='sent'; item.sentAt=new Date().toISOString();
      item.sentFrom=sender.from; item.resendId=data.id;
      sentToday[sender.id]=(sentToday[sender.id]||0)+1;
      lastSentTime[sender.id]=Date.now();
      console.log(`✓ ${item.to}`);
    } else {
      item.status='error'; item.error=JSON.stringify(data);
    }
  } catch(err) { item.status='error'; item.error=err.message; }
}

// ══════════════════════════════════════
// ОБРАБОТЧИК ОЧЕРЕДИ
// ══════════════════════════════════════
async function processQueue() {
  if (isProcessing) return;
  isProcessing = true; isStopped = false;

  while (true) {
    if (isStopped) { console.log('🛑 Queue stopped'); break; }

    const pending = queue.filter(i => i.status==='pending');
    if (!pending.length) break;

    if (isPaused) {
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    const sched = isWorkingTime();
    if (!sched.ok) {
      console.log(`⏸ ${sched.reason}`);
      await new Promise(r => setTimeout(r, minsUntilStart()*60*1000));
      continue;
    }

    const item = pending[0];
    item.status = 'sending';
    await sendEmail(item);

    if (!isStopped && queue.filter(i=>i.status==='pending').length > 0) {
      const mn = parseInt(process.env.PAUSE_MIN)||3;
      const mx = parseInt(process.env.PAUSE_MAX)||7;
      const ms = (mn + Math.random()*(mx-mn))*60*1000;
      console.log(`⏳ Пауза ${Math.round(ms/60000)} мин`);
      // Ждём с проверкой паузы/стопа каждые 5 сек
      const end = Date.now()+ms;
      while (Date.now()<end) {
        if (isStopped) break;
        await new Promise(r=>setTimeout(r,5000));
      }
    }
  }
  isProcessing = false;
}

// ══════════════════════════════════════
// API
// ══════════════════════════════════════
function auth(req,res) {
  const key = req.query.apiKey || (req.body&&req.body.apiKey);
  if (key !== process.env.API_KEY) { res.status(401).json({error:'Unauthorized'}); return false; }
  return true;
}

// Добавить письма в очередь
app.post('/send', (req,res) => {
  if (!auth(req,res)) return;
  const { emails } = req.body;
  if (!Array.isArray(emails)||!emails.length) return res.status(400).json({error:'emails[]'});
  const added=[];
  for (const e of emails) {
    if (!e.to||!e.subject||!e.html) continue;
    const item = {
      id: Date.now().toString(36)+Math.random().toString(36).slice(2),
      to:e.to, subject:e.subject, html:e.html,
      status:'pending', addedAt:new Date().toISOString(),
      sentAt:null, sentFrom:null, error:null, openedAt:null,
    };
    queue.push(item); added.push(item.id);
  }
  if (!isStopped && !isPaused) processQueue().catch(console.error);
  res.json({ ok:true, added:added.length });
});

// Статус
app.get('/status', (req,res) => {
  if (!auth(req,res)) return;
  res.json({
    paused: isPaused, stopped: isStopped,
    pending: queue.filter(i=>i.status==='pending').length,
    sending: queue.filter(i=>i.status==='sending').length,
    sent:    queue.filter(i=>i.status==='sent').length,
    error:   queue.filter(i=>i.status==='error').length,
    total:   queue.length,
    sentToday,
    schedule: { ...isWorkingTime(), start:process.env.SCHEDULE_START||'8:30', end:process.env.SCHEDULE_END||'18:00' },
    accounts: SENDERS.map(s=>({ id:s.id, from:s.from, hasKey:!!process.env[s.apiKeyEnv], sentToday:sentToday[s.id]||0, limit:s.dailyLimit })),
    // Очередь — последние 200, включаем subject и первые 500 символов html для просмотра
    queue: queue.slice(-200).map(i=>({
      id:i.id, to:i.to, subject:i.subject,
      htmlPreview: (i.html||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,300),
      status:i.status, sentFrom:i.sentFrom,
      addedAt:i.addedAt, sentAt:i.sentAt, error:i.error, openedAt:i.openedAt,
    })),
  });
});

// Добавить одно письмо вручную
app.post('/add', (req,res) => {
  if (!auth(req,res)) return;
  const { to, subject, html } = req.body;
  if (!to||!subject||!html) return res.status(400).json({error:'to,subject,html required'});
  const item = {
    id: Date.now().toString(36)+Math.random().toString(36).slice(2),
    to, subject, html, status:'pending',
    addedAt:new Date().toISOString(), sentAt:null, sentFrom:null, error:null, openedAt:null,
  };
  queue.push(item);
  if (!isStopped && !isPaused) processQueue().catch(console.error);
  res.json({ ok:true, id:item.id });
});

// Удалить письмо из очереди (только pending)
app.delete('/queue/:id', (req,res) => {
  if (!auth(req,res)) return;
  const idx = queue.findIndex(i=>i.id===req.params.id && i.status==='pending');
  if (idx===-1) return res.status(404).json({error:'Not found or not pending'});
  queue.splice(idx,1);
  res.json({ ok:true });
});

// Пауза
app.post('/pause', (req,res) => {
  if (!auth(req,res)) return;
  isPaused=true; res.json({ok:true, paused:true});
  console.log('⏸ Paused');
});

// Возобновить
app.post('/resume', (req,res) => {
  if (!auth(req,res)) return;
  isPaused=false; isStopped=false;
  processQueue().catch(console.error);
  res.json({ok:true, paused:false});
  console.log('▶ Resumed');
});

// Стоп (сбрасывает isProcessing после цикла)
app.post('/stop', (req,res) => {
  if (!auth(req,res)) return;
  isStopped=true; isPaused=false;
  res.json({ok:true, stopped:true});
  console.log('🛑 Stopped');
});

// Очистить pending
app.post('/clear', (req,res) => {
  if (!auth(req,res)) return;
  const removed = queue.filter(i=>i.status==='pending').length;
  queue.splice(0,queue.length,...queue.filter(i=>i.status!=='pending'));
  res.json({ok:true,removed});
});

// Трекинг открытий
app.get('/track/:id', (req,res) => {
  const item = queue.find(i=>i.id===req.params.id);
  if (item && item.status==='sent' && !item.openedAt) {
    item.openedAt=new Date().toISOString();
    console.log(`👁 Opened: ${item.to}`);
  }
  const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
  res.setHeader('Content-Type','image/gif');
  res.setHeader('Cache-Control','no-cache,no-store');
  res.send(gif);
});

app.get('/',    (_,res) => res.json({status:'AISYA Mailer OK'}));
app.get('/ping',(_,res) => res.json({pong:true}));

// Self-ping чтобы Railway не усыпил
if (SELF_URL) setInterval(()=>fetch(`${SELF_URL}/ping`).catch(()=>{}), 4*60*1000);

const PORT = process.env.PORT||3000;
app.listen(PORT, ()=>console.log(`AISYA Mailer on :${PORT}`));
