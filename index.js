const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

// ============================================================================
// ============================ BUSINESS SETTINGS =============================
// ============================================================================
const SETTINGS = {
  businessName: 'شکور گوشت شاپ',          // <-- REPLACE (دکان کا نام)
  businessType: 'meat shop',              // گوشت کی دکان
  city: 'لاہور',                           // <-- REPLACE (شہر)
  callPhone: '03000000000',               // <-- REPLACE (کال نمبر)
  openingHours: 'صبح 8:00 تا رات 10:00',  // <-- REPLACE (اوقات)
  botNumber: '923469903361',              // <-- REPLACE (مکمل انٹرنیشنل، 92XXXXXXXXXX)
  ownerNumber: '923000000000',            // <-- REPLACE (مالک کا نمبر، '' سے بند کریں)

  flow: 'ORDER',                          // ORDER | BOOKING | INFO

  deliveryFee: 100,                       // <-- REPLACE (ڈلیوری فیس)
  deliveryTime: '45 منٹ',                 // <-- REPLACE (ڈلیوری وقت)

  // گوشت کی اشیاء — فی کلو قیمت
  menu: [
    { id: 1, name: 'چکن',        price: 500 },   // <-- REPLACE
    { id: 2, name: 'بیف',         price: 900 },   // <-- REPLACE
    { id: 3, name: 'مٹن',         price: 1800 },  // <-- REPLACE
    { id: 4, name: 'چکن قیمہ',   price: 600 },   // <-- REPLACE
    { id: 5, name: 'بیف قیمہ',   price: 950 },   // <-- REPLACE
    { id: 6, name: 'مٹن قیمہ',   price: 1900 }   // <-- REPLACE
  ],

  // (BOOKING فلو کے لیے — فی الحال خالی، گوشت کی دکان میں عام طور پر ضرورت نہیں)
  services: [
    { id: 1, name: 'سروس 1', price: 500 },
    { id: 2, name: 'سروس 2', price: 1000 }
  ],

  extraRules: '' // <-- اختیاری اضافی ہدایات
};

// ============================================================================
// ================================ STATE =====================================
// ============================================================================
const sessions = new Map();
const seen = new Set();
const locks = new Map();

function getSession(jid) {
  if (!sessions.has(jid)) {
    sessions.set(jid, {
      step: 'idle',
      cart: {},
      service: null,
      datetime: null,
      name: null,
      address: null
    });
  }
  return sessions.get(jid);
}

function withLock(jid, fn) {
  const prev = locks.get(jid) || Promise.resolve();
  const next = prev.then(() => fn()).catch(e => console.error('[lock]', e.message));
  locks.set(jid, next);
  return next;
}

// ============================================================================
// =============================== HELPERS ====================================
// ============================================================================
async function sendText(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text });
  } catch (e) {
    console.error(`[send] failed -> ${jid}:`, e.message);
  }
}

function getText(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.imageMessage && m.imageMessage.caption) ||
    (m.videoMessage && m.videoMessage.caption) ||
    ''
  ).trim();
}

function toIntlNumber(raw) {
  let n = String(raw || '').replace(/\D/g, '');
  if (!n) return '';
  if (n.startsWith('0')) n = '92' + n.slice(1);
  return n;
}

function menuText() {
  let t = `📋 *${SETTINGS.businessName} - مینو*\n\n`;
  SETTINGS.menu.forEach(m => {
    t += `${m.id}. ${m.name} — Rs ${m.price} فی کلو\n`;
  });
  t += `\nآرڈر کے لیے نمبر بھیجیں، مثلاً: *1x2, 3, 5*`;
  t += `\n(1x2 کا مطلب 2 کلو پہلی چیز)`;
  t += `\n\nمنسوخ کرنے کے لیے *0* بھیجیں۔`;
  return t;
}

function serviceText() {
  let t = `📋 *${SETTINGS.businessName} - سروسز*\n\n`;
  SETTINGS.services.forEach(s => {
    t += `${s.id}. ${s.name}${s.price ? ` — Rs ${s.price}` : ''}\n`;
  });
  t += `\nنمبر بھیج کر چنیں۔\nمنسوخ کرنے کے لیے *0* بھیجیں۔`;
  return t;
}

function parseOrder(text) {
  const items = {};
  const normalized = String(text)
    .replace(/\u00A0/g, ' ')
    .replace(/\s*[xX*×]\s*/g, 'x');
  const tokens = normalized.split(/[,\s]+/).filter(Boolean);
  if (!tokens.length) return null;
  for (const raw of tokens) {
    const clean = raw.replace(/[^\dx]/gi, '').toLowerCase();
    if (!clean) continue;
    const m = clean.match(/^(\d+)(?:x(\d+))?$/);
    if (!m) return null;
    const id = parseInt(m[1], 10);
    const qty = parseInt(m[2] || '1', 10);
    if (!qty || qty < 1 || qty > 50) return null;
    const item = SETTINGS.menu.find(x => x.id === id);
    if (!item) return null;
    items[id] = (items[id] || 0) + qty;
  }
  return Object.keys(items).length ? items : null;
}

function cartLines(cart) {
  let out = '';
  let subtotal = 0;
  Object.entries(cart).forEach(([id, qty]) => {
    const item = SETTINGS.menu.find(x => x.id === Number(id));
    if (!item) return;
    const line = item.price * qty;
    subtotal += line;
    out += `• ${qty} کلو ${item.name} — Rs ${line}\n`;
  });
  return { text: out, subtotal };
}

function cartSummary(cart) {
  const { text, subtotal } = cartLines(cart);
  const total = subtotal + SETTINGS.deliveryFee;
  return (
    `🛒 *آپ کا آرڈر*\n\n${text}\n` +
    `اشیاء کی رقم: Rs ${subtotal}\n` +
    `ڈلیوری فیس: Rs ${SETTINGS.deliveryFee}\n` +
    `*کل رقم: Rs ${total}*\n\n` +
    `جواب دیں:\n1️⃣ تصدیق کریں\n2️⃣ مزید شامل کریں\n3️⃣ منسوخ کریں`
  );
}

async function showWelcome(sock, jid, s) {
  let msg =
    `👋 *${SETTINGS.businessName}* میں خوش آمدید!\n\n` +
    `📍 ${SETTINGS.city}\n` +
    `📞 کال کریں: ${SETTINGS.callPhone}\n` +
    `🕐 اوقات: ${SETTINGS.openingHours}\n\n`;
  if (SETTINGS.flow === 'BOOKING') {
    msg += `سروسز دیکھنے کے لیے *1* یا *BOOK* بھیجیں۔`;
  } else {
    msg += `مینو دیکھنے کے لیے *1* یا *MENU* بھیجیں۔`;
  }
  s.step = 'menu_wait';
  await sendText(sock, jid, msg);
}

// ============================================================================
// =========================== MESSAGE HANDLER ================================
// ============================================================================
async function handleMessage(sock, jid, rawText, msg) {
  const s = getSession(jid);
  const text = (rawText || '').trim();
  const lower = text.toLowerCase();

  // عالمی منسوخی
  if (['0', 'cancel', 'stop', 'exit', 'منسوخ', 'کینسل'].includes(lower)) {
    s.step = 'idle';
    s.cart = {};
    s.service = null;
    s.datetime = null;
    s.name = null;
    s.address = null;
    await sendText(sock, jid, '❌ منسوخ کر دیا گیا۔ دوبارہ شروع کرنے کے لیے *Hi* بھیجیں۔');
    return;
  }

  switch (s.step) {
    case 'idle':
      return showWelcome(sock, jid, s);

    case 'menu_wait': {
      const triggers = ['1', 'menu', 'm', 'hi', 'hello', 'hey', 'start', 'book', 'booking', 'مینو', 'سلام', 'السلام'];
      if (!triggers.includes(lower)) {
        const hint = SETTINGS.flow === 'BOOKING'
          ? 'سروسز دیکھنے کے لیے *1* یا *BOOK* بھیجیں۔'
          : 'مینو دیکھنے کے لیے *1* یا *MENU* بھیجیں۔';
        await sendText(sock, jid, hint + '\nمنسوخ کرنے کے لیے *0* بھیجیں۔');
        return;
      }
      if (SETTINGS.flow === 'BOOKING') {
        s.step = 'booking_service';
        await sendText(sock, jid, serviceText());
      } else if (SETTINGS.flow === 'INFO') {
        s.step = 'info_wait';
        await sendText(sock, jid, menuText());
      } else {
        s.step = 'ordering';
        await sendText(sock, jid, menuText());
      }
      return;
    }

    case 'info_wait': {
      if (['1', 'menu', 'm', 'hi', 'hello', 'مینو', 'سلام'].includes(lower)) {
        await sendText(sock, jid, menuText());
      } else {
        await sendText(sock, jid, 'مینو کے لیے *1* یا *MENU* بھیجیں۔\nمنسوخ کرنے کے لیے *0* بھیجیں۔');
      }
      return;
    }

    case 'ordering': {
      const cart = parseOrder(text);
      if (!cart) {
        await sendText(sock, jid, 'سمجھ نہیں آیا۔ نمبر بھیجیں جیسے *1x2, 3, 5*۔\nمنسوخ کرنے کے لیے *0* بھیجیں۔');
        return;
      }
      s.cart = cart;
      s.step = 'cart_review';
      await sendText(sock, jid, cartSummary(cart));
      return;
    }

    case 'cart_review': {
      if (['1', 'confirm', 'yes', 'ok', 'ٹھیک', 'ہاں', 'تصدیق'].includes(lower)) {
        s.step = 'address_wait';
        await sendText(
          sock, jid,
          '📍 براہ کرم اپنا *مکمل پتہ* بھیجیں۔\n(گھر نمبر، گلی، علاقہ، شہر)\n\nادائیگی ڈلیوری پر نقد ہو گی۔'
        );
      } else if (['2', 'add', 'more', 'addmore', 'مزید'].includes(lower)) {
        s.step = 'ordering';
        await sendText(sock, jid, menuText());
      } else if (['3', 'no', 'نہیں'].includes(lower)) {
        s.step = 'idle';
        s.cart = {};
        await sendText(sock, jid, '❌ آرڈر منسوخ کر دیا گیا۔ دوبارہ شروع کرنے کے لیے *Hi* بھیجیں۔');
      } else {
        await sendText(sock, jid, 'جواب دیں: *1* تصدیق، *2* مزید شامل کریں، *3* منسوخ۔');
      }
      return;
    }

    case 'address_wait': {
      if (text.length < 5) {
        await sendText(sock, jid, 'براہ کرم مکمل پتہ بھیجیں (گھر، گلی، علاقہ، شہر)۔');
        return;
      }
      s.address = text;
      const orderId = 'ORD-' + Date.now().toString().slice(-6);
      const { text: lines, subtotal } = cartLines(s.cart);
      const total = subtotal + SETTINGS.deliveryFee;

      const confirmMsg =
        `✅ *آرڈر کی تصدیق ہو گئی!*\n\n` +
        `🆔 آرڈر نمبر: ${orderId}\n\n` +
        `${lines}\n` +
        `اشیاء کی رقم: Rs ${subtotal}\n` +
        `ڈلیوری فیس: Rs ${SETTINGS.deliveryFee}\n` +
        `*کل رقم: Rs ${total}*\n\n` +
        `💵 ادائیگی: ڈلیوری پر نقد\n` +
        `📍 پتہ: ${s.address}\n\n` +
        `🛵 آپ کا آرڈر *${SETTINGS.deliveryTime}* میں پہنچ جائے گا۔\n` +
        `📞 کسی بھی سوال کے لیے ${SETTINGS.callPhone} پر کال کریں۔`;
      await sendText(sock, jid, confirmMsg);

      if (SETTINGS.ownerNumber) {
        const ownerJid = toIntlNumber(SETTINGS.ownerNumber) + '@s.whatsapp.net';
        const ownerMsg =
          `🔔 *نیا آرڈر آیا!*\n\n` +
          `🆔 ${orderId}\n` +
          `👤 گاہک: ${jid.split('@')[0]}\n\n` +
          `${lines}\n` +
          `اشیاء: Rs ${subtotal}\n` +
          `ڈلیوری: Rs ${SETTINGS.deliveryFee}\n` +
          `*کل: Rs ${total}*\n\n` +
          `💵 نقد ادائیگی (ڈلیوری پر)\n` +
          `📍 ${s.address}`;
        await sendText(sock, ownerJid, ownerMsg);
      }

      s.step = 'idle';
      s.cart = {};
      s.address = null;
      return;
    }

    case 'booking_service': {
      const n = parseInt(text, 10);
      const svc = SETTINGS.services.find(x => x.id === n);
      if (!svc) {
        await sendText(sock, jid, `سروس کا نمبر بھیجیں (1-${SETTINGS.services.length})۔\nمنسوخ کرنے کے لیے *0* بھیجیں۔`);
        return;
      }
      s.service = svc;
      s.step = 'booking_datetime';
      await sendText(sock, jid, `📅 آپ نے *${svc.name}* چنا۔\n\nبراہ کرم *تاریخ اور وقت* بھیجیں (مثلاً: 25 دسمبر، شام 4 بجے)۔`);
      return;
    }

    case 'booking_datetime': {
      if (text.length < 3) {
        await sendText(sock, jid, 'براہ کرم *تاریخ اور وقت* بھیجیں (مثلاً: 25 دسمبر، شام 4 بجے)۔');
        return;
      }
      s.datetime = text;
      s.step = 'booking_name';
      await sendText(sock, jid, '👤 براہ کرم اپنا *پورا نام* بھیجیں۔');
      return;
    }

    case 'booking_name': {
      if (text.length < 2) {
        await sendText(sock, jid, 'براہ کرم اپنا *پورا نام* بھیجیں۔');
        return;
      }
      s.name = text;
      const bookingId = 'BK-' + Date.now().toString().slice(-6);
      const confirmMsg =
        `✅ *بکنگ کی تصدیق ہو گئی!*\n\n` +
        `🆔 ${bookingId}\n` +
        `👤 ${s.name}\n` +
        `💼 ${s.service.name}${s.service.price ? ` — Rs ${s.service.price}` : ''}\n` +
        `📅 ${s.datetime}\n\n` +
        `📍 ${SETTINGS.businessName}, ${SETTINGS.city}\n` +
        `📞 تبدیلی کے لیے ${SETTINGS.callPhone} پر کال کریں۔`;
      await sendText(sock, jid, confirmMsg);

      if (SETTINGS.ownerNumber) {
        const ownerJid = toIntlNumber(SETTINGS.ownerNumber) + '@s.whatsapp.net';
        const ownerMsg =
          `🔔 *نئی بکنگ!*\n\n` +
          `🆔 ${bookingId}\n` +
          `👤 ${s.name} (${jid.split('@')[0]})\n` +
          `💼 ${s.service.name}\n` +
          `📅 ${s.datetime}`;
        await sendText(sock, ownerJid, ownerMsg);
      }

      s.step = 'idle';
      s.service = null;
      s.datetime = null;
      s.name = null;
      return;
    }

    default:
      return showWelcome(sock, jid, s);
  }
}

// ============================================================================
// ============================== BOT START ===================================
// ============================================================================
let isStarting = false;

async function startBot() {
  if (isStarting) return;
  isStarting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState('session_bot');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      auth: state
    });

    let pairingRequested = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !sock.authState.creds.registered) {
        try {
          const link = 'https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(qr);
          console.log('QR LINK:', link);
          try { qrcode.generate(qr, { small: true }); } catch (_) { /* ignore */ }

          if (!pairingRequested) {
            pairingRequested = true;
            setTimeout(async () => {
              try {
                const number = toIntlNumber(SETTINGS.botNumber);
                const code = await sock.requestPairingCode(number);
                console.log('PAIRING CODE:', code);
              } catch (e) {
                console.error('Pairing code error:', e.message);
              }
            }, 1000);
          }
        } catch (e) {
          console.error('QR handling error:', e.message);
        }
      }

      if (connection === 'open') {
        console.log(`✅ بوٹ لائیو ہے — ${SETTINGS.businessName}`);
      } else if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          console.log('⚠️ لاگ آؤٹ ہو گیا — session_bot صاف کر کے دوبارہ pairing...');
          try { fs.rmSync('session_bot', { recursive: true, force: true }); } catch (_) {}
          isStarting = false;
          setTimeout(startBot, 1000);
        } else {
          console.log('🔄 کنکشن بند — 4 سیکنڈ بعد دوبارہ کوشش...');
          isStarting = false;
          setTimeout(startBot, 4000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          if (!msg || !msg.message) continue;
          if (msg.key && msg.key.fromMe) continue;

          const jid = (msg.key && (msg.key.remoteJidAlt || msg.key.remoteJid)) || '';
          if (!jid) continue;
          if (jid === 'status@broadcast') continue;
          if (jid.endsWith('@g.us')) continue;
          if (jid.endsWith('@newsletter')) continue;
          if (jid.endsWith('@broadcast')) continue;

          const mid = msg.key && msg.key.id;
          if (mid) {
            if (seen.has(mid)) continue;
            seen.add(mid);
            if (seen.size > 3000) {
              const first = seen.values().next().value;
              seen.delete(first);
            }
          }

          const text = getText(msg);
          if (!text) continue;

          await withLock(jid, () => handleMessage(sock, jid, text, msg));
        } catch (e) {
          console.error('[upsert] error:', e.message);
        }
      }
    });
  } catch (e) {
    console.error('startBot error:', e.message);
    isStarting = false;
    setTimeout(startBot, 4000);
  }
}

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e && (e.message || e)));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e && (e.message || e)));

startBot();
