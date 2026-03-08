const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const app     = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// ══════════════════════════════════════
// ПЕРСИСТЕНТНОСТЬ ОЧЕРЕДИ
// ══════════════════════════════════════
const QUEUE_FILE = path.join('/tmp', 'aisya_queue.json');

function saveQueue() {
  try {
    // Сохраняем только pending письма (sent/error не нужны после перезапуска)
    const toSave = queue.filter(i => i.status === 'pending');
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(toSave), 'utf8');
  } catch(e) { console.error('saveQueue error:', e.message); }
}

function loadQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    if (Array.isArray(data) && data.length) {
      queue.push(...data);
      console.log(`✓ Загружено ${data.length} писем из очереди`);
    }
  } catch(e) { console.error('loadQueue error:', e.message); }
}

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
  setTimeout(() => { for(const s of SENDERS) sentToday[s.id]=0; console.log('Daily reset'); resetDaily();

// ══════════════════════════════════════
// ВТОРОЕ КАСАНИЕ (авто)
// ══════════════════════════════════════
const TOUCH2_DAYS = parseInt(process.env.TOUCH2_DAYS)||5; // через сколько дней
const touch2Sent = new Set(); // чтобы не дублировать

async function scheduleSecondTouch() {
  if (!process.env.PROXYAPI_KEY) return;
  const now = Date.now();
  const cutoff = now - TOUCH2_DAYS * 24*60*60*1000;

  for (const item of queue) {
    // Только отправленные, открытые, без ответа, не обработанные
    if (item.status !== 'sent') continue;
    if (!item.openedAt) continue;
    if (touch2Sent.has(item.id)) continue;
    if (!item.sentAt || new Date(item.sentAt).getTime() > cutoff) continue;

    // Проверяем нет ли уже второго касания для этого адреса
    const alreadyQueued = queue.some(q =>
      q.to === item.to && q.isTouch2 && (q.status === 'pending' || q.status === 'sent')
    );
    if (alreadyQueued) { touch2Sent.add(item.id); continue; }

    touch2Sent.add(item.id);

    // Генерируем второе письмо через GPT
    try {
      const firstText = (item.html||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,400);
      const prompt = `Ты пишешь второе холодное письмо. Первое письмо было отправлено ${TOUCH2_DAYS} дней назад, получатель его открыл но не ответил.

Напиши короткое второе письмо (3-5 предложений) которое:
- Ссылается на первое письмо естественно ("писал вам на прошлой неделе...")
- Добавляет новый аргумент или другой угол
- Заканчивается конкретным вопросом
- Пишется как живой человек, без маркеров нейросети
- ЗАПРЕЩЕНО длинное тире, слова "эффективно", "оптимизировать", "инновационный"
- Без приветствия и подписи, только текст письма

Первое письмо: ${firstText}`;

      const body = await gptRequest(prompt, 250);
      if (!body) continue;

      const subjectPrompt = `Придумай тему для второго письма (ответ на неотвеченное первое, до 7 слов, без кавычек): ${firstText.slice(0,100)}`;
      const subject = await gptRequest(subjectPrompt, 20) || 'Повторно: ' + (item.subject||'').slice(0,30);

      const sig = process.env.MAIL_SIGNATURE || '';
      const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#222;">${
        body.split('\n').map(l => l ? `<p style="margin:0 0 8px">${l}</p>` : '<br>').join('')
      }${sig ? `<br><hr style="border:none;border-top:1px solid #eee;margin:16px 0">${sig}` : ''}</div>`;

      const touch2Item = {
        id: Date.now().toString(36)+Math.random().toString(36).slice(2),
        to: item.to,
        subject,
        html: htmlBody,
        domain: item.domain || '',
        status: 'pending',
        isTouch2: true,
        touch2OfId: item.id,
        addedAt: new Date().toISOString(),
        sentAt: null, sentFrom: null, error: null, openedAt: null,
      };

      queue.push(touch2Item);
      saveQueue();
      console.log(`2-е касание запланировано: ${item.to} (тема: ${subject})`);
    } catch(e) {
      console.log('touch2 error:', e.message);
    }
  }
}

// Проверяем второе касание каждые 2 часа
setInterval(scheduleSecondTouch, 2*60*60*1000); }, ms);
}
resetDaily();

// ══════════════════════════════════════
// ВТОРОЕ КАСАНИЕ (авто)
// ══════════════════════════════════════
const TOUCH2_DAYS = parseInt(process.env.TOUCH2_DAYS)||5; // через сколько дней
const touch2Sent = new Set(); // чтобы не дублировать

async function scheduleSecondTouch() {
  if (!process.env.PROXYAPI_KEY) return;
  const now = Date.now();
  const cutoff = now - TOUCH2_DAYS * 24*60*60*1000;

  for (const item of queue) {
    // Только отправленные, открытые, без ответа, не обработанные
    if (item.status !== 'sent') continue;
    if (!item.openedAt) continue;
    if (touch2Sent.has(item.id)) continue;
    if (!item.sentAt || new Date(item.sentAt).getTime() > cutoff) continue;

    // Проверяем нет ли уже второго касания для этого адреса
    const alreadyQueued = queue.some(q =>
      q.to === item.to && q.isTouch2 && (q.status === 'pending' || q.status === 'sent')
    );
    if (alreadyQueued) { touch2Sent.add(item.id); continue; }

    touch2Sent.add(item.id);

    // Генерируем второе письмо через GPT
    try {
      const firstText = (item.html||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,400);
      const prompt = `Ты пишешь второе холодное письмо. Первое письмо было отправлено ${TOUCH2_DAYS} дней назад, получатель его открыл но не ответил.

Напиши короткое второе письмо (3-5 предложений) которое:
- Ссылается на первое письмо естественно ("писал вам на прошлой неделе...")
- Добавляет новый аргумент или другой угол
- Заканчивается конкретным вопросом
- Пишется как живой человек, без маркеров нейросети
- ЗАПРЕЩЕНО длинное тире, слова "эффективно", "оптимизировать", "инновационный"
- Без приветствия и подписи, только текст письма

Первое письмо: ${firstText}`;

      const body = await gptRequest(prompt, 250);
      if (!body) continue;

      const subjectPrompt = `Придумай тему для второго письма (ответ на неотвеченное первое, до 7 слов, без кавычек): ${firstText.slice(0,100)}`;
      const subject = await gptRequest(subjectPrompt, 20) || 'Повторно: ' + (item.subject||'').slice(0,30);

      const sig = process.env.MAIL_SIGNATURE || '';
      const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#222;">${
        body.split('\n').map(l => l ? `<p style="margin:0 0 8px">${l}</p>` : '<br>').join('')
      }${sig ? `<br><hr style="border:none;border-top:1px solid #eee;margin:16px 0">${sig}` : ''}</div>`;

      const touch2Item = {
        id: Date.now().toString(36)+Math.random().toString(36).slice(2),
        to: item.to,
        subject,
        html: htmlBody,
        domain: item.domain || '',
        status: 'pending',
        isTouch2: true,
        touch2OfId: item.id,
        addedAt: new Date().toISOString(),
        sentAt: null, sentFrom: null, error: null, openedAt: null,
      };

      queue.push(touch2Item);
      saveQueue();
      console.log(`2-е касание запланировано: ${item.to} (тема: ${subject})`);
    } catch(e) {
      console.log('touch2 error:', e.message);
    }
  }
}

// Проверяем второе касание каждые 2 часа
setInterval(scheduleSecondTouch, 2*60*60*1000);

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
// ПЕРСОНАЛИЗАЦИЯ (ProxyAPI → GPT-4o-mini)
// ══════════════════════════════════════
async function gptRequest(prompt, maxTokens=200) {
  const apiKey = process.env.PROXYAPI_KEY;
  if (!apiKey) return null;
  try {
    const resp = await fetch('https://api.proxyapi.ru/openai/v1/chat/completions', {
      method:'POST',
      headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body: JSON.stringify({ model:'gpt-4o-mini', max_tokens:maxTokens, messages:[{role:'user',content:prompt}] }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch(e) { return null; }
}

async function getSiteText(domain) {
  try {
    const r = await fetch(`https://${domain}`, { signal: AbortSignal.timeout(5000) });
    const h = await r.text();
    return h.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0, 800);
  } catch(e) { return ''; }
}

async function personalizeLine(domain, html) {
  const apiKey = process.env.PROXYAPI_KEY;
  if (!apiKey) return { html, subject: null };

  try {
    const siteText = await getSiteText(domain);
    if (!siteText) return { html, subject: null };

    // Определяем тип компании для адаптации письма
    const siteTextLower = siteText.toLowerCase();
    const isIT = ['разработ', 'software', 'it-компани', 'веб-студи', 'digital', 'искусственный интеллект', 'нейросет', 'автоматизаци', 'saas', 'приложени', 'программн', 'devops', 'стартап'].some(w => siteTextLower.includes(w));

    const itContext = isIT ? `ВАЖНО: Это IT или технологическая компания. НЕ пиши про автоматизацию входящих и 1С — они это сами делают. Вместо этого пиши про:
- Автоматизацию внутренних операционных процессов (онбординг клиентов, поддержка, документооборот)
- Ускорение работы команды разработки (авто-генерация документации, тест-кейсов, постановка задач)
- Автоматизацию работы с клиентами (обработка тикетов, ответы на типовые запросы, мониторинг NPS)
- Снижение нагрузки на менеджеров по продажам и поддержке` : '';

    const prompt = `Ты пишешь холодное письмо от лица Данила Ерофеева, CEO компании AISYA (разработка и внедрение ИИ-ядра для автоматизации операционных процессов бизнеса).

Напиши ПОЛНОЕ письмо под конкретную компанию на основе текста её сайта.

СТИЛЬ — строго по образцам ниже:
- Начинай с "Добрый день." или "Здравствуйте."
- Покажи что реально смотрел сайт: назови конкретный продукт, услугу, специфику
- Опиши операционную боль характерную для этого типа бизнеса (заявки, номенклатура, счета, 1С, согласования, карточки клиентов)
- Объясни что делает AISYA: ИИ-ядро встраивается в 1С/CRM/ERP, закрывает входящие, письма, заявки, мессенджеры
- Упомяни B2B модуль если релевантно: транскрибация звонков, проверка контрагента, черновик договора
- Реши не коробочное, собирается под процессы компании
- Предложи тестовый стенд бесплатно под один процесс
- Заверши вопросом: "Подскажите, пожалуйста, с кем у вас лучше обсудить такие вещи."
- Подпись: Данил, AISYA, +7 927 255 05 32

ЗАПРЕЩЕНО:
- Длинное тире — (маркер нейросети), только запятые и точки
- Слова: "эффективно", "оптимизировать", "значительно", "инновационный", "современный", "синергия"
- Вводные фразы: "Я заметил что", "Изучив ваш сайт", "Будучи экспертом"
- Общие фразы без конкретики про этот бизнес

ОБРАЗЕЦ 1 (магазин экипировки):
Добрый день.
Обращаюсь по задаче автоматизации операционного слоя.
Смотрел ваш каталог на БлокПОСТ, у вас типичная для экипировочных сетей сложная номенклатура: от берцев и софтшеллов до вещей уровня "Горка" и противоосколочных комплектов. Плюс часть клиентов явно берёт не одну позицию, а сразу комплекты экипировки.

В таких магазинах менеджеры обычно тратят много времени на одно и то же: подбор позиций из каталога, уточнения по наличию, сбор комплектации, счета, занесение клиента в 1С.

Мы в AISYA как раз автоматизируем этот слой. ИИ-ядро встраивается в 1С / CRM и начинает разбирать входящие: письма, заявки с сайта, вопросы по товарам, формирует карточки клиентов, счета и помогает менеджеру ориентироваться в номенклатуре.

Есть ещё модуль для B2B: во время звонка система транскрибирует разговор, проверяет компанию по открытым источникам и параллельно собирает карточку клиента и черновик договора.

Решение не коробочное, обычно собираем под конкретную архитектуру компании. Если интересно, можем собрать небольшой тестовый стенд под один из ваших процессов.

Подскажите, пожалуйста, с кем у вас лучше обсудить такие вещи.

Данил
AISYA
+7 927 255 05 32

ОБРАЗЕЦ 2 (оптовая торговля с корпоративными клиентами):
Здравствуйте.
Посмотрел ваш сайт, у вас очень показательная для рынка модель: большой каталог и параллельно работа с корпоративными клиентами. В таких компаниях менеджеры часто половину времени тратят не на продажи, а на поток операционных вещей: заявки, подбор позиций, счета, карточки клиентов в 1С.

Мы в AISYA как раз автоматизируем этот слой. Делаем ИИ-ядро, которое встраивается в 1С / CRM и начинает разбирать входящие: письма, заявки с сайта, обращения из мессенджеров, формирует счета, карточки клиентов и помогает менеджеру ориентироваться в номенклатуре.

Отдельный модуль, ассистент для B2B-продаж: во время звонка он транскрибирует разговор, проверяет контрагента по открытым источникам и параллельно собирает карточку клиента и черновик договора.

Решение не коробочное, собирается под процессы компании. Если интересно, можем показать на тестовом стенде как это может работать в вашей структуре.

Подскажите, пожалуйста, с кем у вас корректно обсудить такие вещи.

Данил
AISYA
+7 927 255 05 32

Текст сайта компании: \${siteText}

Напиши только письмо, без пояснений и комментариев.`;

    // Параллельно генерируем абзац и тему
    const [line, subject] = await Promise.all([
      gptRequest(prompt, 600),
      gptRequest(`На основе текста сайта придумай тему холодного письма (до 8 слов). Тема должна быть конкретной и релевантной бизнесу компании. Не используй слова: "автоматизация", "предложение", "сотрудничество". Пиши как живой человек, без кавычек. Текст сайта: ${siteText}`, 30)
    ]);

    let resultHtml = html;
    if (line) {
      // GPT написал полное письмо — заменяем шаблон целиком
      // Разбиваем по двойным и одинарным переносам, сохраняем структуру
      const paragraphs = line
        .split(/\n\n+/)  // сначала делим по двойным переносам
        .map(block => block.trim())
        .filter(block => block.length > 0);

      const bodyHtml = paragraphs.map(block => {
        // Внутри блока одинарные переносы — тоже отдельные строки
        const lines = block.split('\n').map(l => l.trim()).filter(l => l);
        const inner = lines.join('<br>');
        return `<p style="margin:0 0 14px;color:#222;font-family:Arial,sans-serif;font-size:14px;line-height:1.7;">${inner}</p>`;
      }).join('');

      // Вытаскиваем подпись из оригинального шаблона (всё после <hr> или последний <table>)
      let signature = '';
      const hrMatch = html.match(/<hr[^>]*>([\s\S]*)/i);
      const tableMatch = html.match(/(<table[\s\S]*<\/table>)[^<]*$/i);
      if (hrMatch) signature = '<hr style="border:none;border-top:1px solid #eee;margin:20px 0">' + hrMatch[1];
      else if (tableMatch) signature = tableMatch[1];

      resultHtml = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#222;max-width:580px;padding:0;">${bodyHtml}${signature}</div>`;
    }

    // Тема: запрещаем плохие слова
    let finalSubject = subject || null;
    if (finalSubject) {
      const bad = ['современн', 'ускорьте', 'оптимизируй', 'инновацион', 'эффективн', 'AI-решени', 'бизнес-процессы'];
      if (bad.some(w => finalSubject.toLowerCase().includes(w.toLowerCase()))) {
        finalSubject = null; // оставляем оригинальную тему шаблона
      }
    }

    return { html: resultHtml, subject: finalSubject };

  } catch(e) {
    console.log(`Персонализация пропущена для ${domain}: ${e.message}`);
    return { html, subject: null };
  }
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

  // Персонализация если включена и флаг стоит
  let html = item.html;
  if (process.env.PROXYAPI_KEY && item.domain && item.personalize !== false) {
    const result = await personalizeLine(item.domain, html);
    html = result.html;
    if (result.subject) item.subject = result.subject;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{ Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ from:sender.from, to:[item.to], subject:item.subject, html:html+trackImg }),
    });
    const data = await res.json();
    if (res.ok && data.id) {
      item.status='sent'; item.sentAt=new Date().toISOString();
      item.sentFrom=sender.from; item.resendId=data.id;
      sentToday[sender.id]=(sentToday[sender.id]||0)+1;
      lastSentTime[sender.id]=Date.now();
      console.log(`✓ ${item.to}`);
      saveQueue();
    } else {
      item.status='error'; item.error=JSON.stringify(data);
    }
  } catch(err) { item.status='error'; item.error=err.message; saveQueue(); }
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
      domain: e.domain || e.to.split('@')[1] || '',
      personalize: req.body.personalize !== false, // по умолчанию true
      status:'pending', addedAt:new Date().toISOString(),
      sentAt:null, sentFrom:null, error:null, openedAt:null,
    };
    queue.push(item); added.push(item.id);
    saveQueue();
  }
  if (!isStopped && !isPaused) processQueue().catch(console.error);
  res.json({ ok:true, added:added.length });
});

// Прокси для 2GIS API
app.get('/2gis', async (req, res) => {
  if (!auth(req, res)) return;
  const { q, page_size } = req.query;
  const apiKey = process.env.DGIS_KEY;
  if (!apiKey) return res.status(503).json({ error: 'DGIS_KEY not set' });
  try {
    const url = `https://catalog.api.2gis.com/3.0/items?q=${encodeURIComponent(q)}&fields=items.name,items.contact_groups&page_size=${page_size||50}&key=${apiKey}&locale=ru_RU&type=branch`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Мгновенная отправка (тест) — минуя очередь и расписание
app.post('/send-now', async (req,res) => {
  if (!auth(req,res)) return;
  const { to, subject, html, domain } = req.body;
  if (!to||!subject||!html) return res.status(400).json({error:'to/subject/html required'});
  const sender = pickSender();
  if (!sender) return res.status(503).json({error:'Нет доступных отправителей'});
  const apiKey = process.env[sender.apiKeyEnv];
  try {
    // Персонализация для теста тоже
    let finalHtml = html;
    let finalSubject = subject;
    const d = to.split('@')[1] || domain || '';
    if (process.env.PROXYAPI_KEY && d) {
      const result = await personalizeLine(d, html);
      finalHtml = result.html;
      if (result.subject) finalSubject = result.subject;
    }
    const r = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{ Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ from:sender.from, to:[to], subject:finalSubject, html:finalHtml }),
    });
    const data = await r.json();
    if (r.ok && data.id) {
      res.json({ ok:true, id:data.id, from:sender.from, personalized:!!process.env.PROXYAPI_KEY });
    } else {
      res.status(500).json({ ok:false, error:JSON.stringify(data) });
    }
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
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
    queue: queue.slice(-2000).map(i=>({
      id:i.id, to:i.to, subject:i.subject,
      htmlPreview: (i.html||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,2000),
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
    to, subject, html,
    domain: req.body.domain || to.split('@')[1] || '',
    status:'pending',
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
// Загружаем очередь при старте
loadQueue();
if (queue.length > 0) {
  console.log(`▶ Автозапуск: ${queue.length} писем в очереди`);
  processQueue().catch(console.error);
}

app.listen(PORT, ()=>console.log(`AISYA Mailer on :${PORT}`));
