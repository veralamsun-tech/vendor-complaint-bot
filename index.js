// ============================================================
//  典華 採購LINE@ 廠商反映機器人
//  環境變數：LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN,
//            GAS_URL, GAS_KEY, GEMINI_API_KEY
// ============================================================
const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const GAS_URL = process.env.GAS_URL;
const GAS_KEY = process.env.GAS_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.0-flash-lite';

const VENUES = ['大直館', '新莊館', '士林館'];
const CATEGORIES = ['品質不良', '數量短少', '送錯品項', '逾時送達', '其他'];
const BRAND = '#968571';
const MAX_PHOTOS = 3;
const TRIGGERS = ['NG商品', 'ng商品', 'Ng商品', '#NG商品', '#ng商品', 'NG 商品', 'ng 商品'];

const client = new line.Client(config);
const app = express();

// ---------- 記憶體暫存 ----------
const sessions = new Map();          // userId -> 對話狀態
const cache = { chef: new Map(), admin: new Map(), vendors: null, vendorsAt: 0 };
const SESSION_TTL = 30 * 60 * 1000;
const CACHE_TTL = 10 * 60 * 1000;

function getSession(id) {
  const s = sessions.get(id);
  if (s && Date.now() - s.updated > SESSION_TTL) { sessions.delete(id); return null; }
  return s || null;
}
function setSession(id, s) { s.updated = Date.now(); sessions.set(id, s); return s; }
function clearSession(id) { sessions.delete(id); }

// ---------- Google Apps Script ----------
async function gas(action, data) {
  const r = await fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: GAS_KEY, action, data: data || {} }),
    redirect: 'follow',
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'GAS error');
  return j;
}
async function getChef(userId) {
  const c = cache.chef.get(userId);
  if (c && Date.now() - c.at < CACHE_TTL) return c.v;
  const { chef } = await gas('getChef', { userId });
  cache.chef.set(userId, { v: chef, at: Date.now() });
  return chef;
}
async function getAdmin(userId) {
  const c = cache.admin.get(userId);
  if (c && Date.now() - c.at < CACHE_TTL) return c.v;
  const { admin } = await gas('getAdmin', { userId });
  cache.admin.set(userId, { v: admin, at: Date.now() });
  return admin;
}
async function getVendors() {
  if (cache.vendors && Date.now() - cache.vendorsAt < CACHE_TTL) return cache.vendors;
  const { vendors } = await gas('getVendors');
  cache.vendors = vendors; cache.vendorsAt = Date.now();
  return vendors;
}

// ---------- 廠商比對 ----------
function norm(s) { return String(s || '').replace(/\s/g, '').toLowerCase(); }
function matchVendors(text, vendors) {
  const t = norm(text);
  if (!t) return [];
  const exact = vendors.filter(v => norm(v.name) === t || v.aliases.some(a => norm(a) === t));
  if (exact.length) return exact.map(v => v.name);
  const partial = vendors.filter(v =>
    norm(v.name).includes(t) || t.includes(norm(v.name)) ||
    v.aliases.some(a => norm(a).includes(t) || t.includes(norm(a))));
  return partial.map(v => v.name);
}

// ---------- Gemini：抽出廠商 / 描述 / 分類 ----------
async function analyze(text, vendors) {
  const fallback = { vendor_match: null, vendor_text: null, description: text, category: '其他' };
  if (!GEMINI_KEY) return fallback;
  const names = vendors.map(v => v.name).join('、');
  const prompt = `你是餐飲公司採購助理。廚師傳來一則反映廠商送貨問題的訊息，請抽出資訊並只回傳 JSON。
廠商清單：${names}
分類只能選：${CATEGORIES.join('、')}
規則：
- vendor_match：訊息中提到的廠商若能對應到清單中的某一家（允許簡稱、錯字），填清單中的完整名稱；否則 null。
- vendor_text：訊息中原本寫的廠商名稱文字；沒提到廠商就 null。
- description：把廠商名去掉後，剩下的問題描述，保留原意，簡短。
- category：最接近的分類。
訊息：「${text}」
JSON 格式：{"vendor_match":..., "vendor_text":..., "description":..., "category":...}`;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }),
    });
    const j = await r.json();
    const raw = j.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const out = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (out.vendor_match && !vendors.some(v => v.name === out.vendor_match)) out.vendor_match = null;
    if (!CATEGORIES.includes(out.category)) out.category = '其他';
    if (!out.description) out.description = text;
    return out;
  } catch (e) {
    console.error('Gemini error', e);
    return fallback;
  }
}

// ---------- LINE 小工具 ----------
function text(t) { return { type: 'text', text: t }; }
function quick(t, items) {
  return { type: 'text', text: t, quickReply: { items: items.map(i => ({ type: 'action', action: i })) } };
}
function pb(label, data) { return { type: 'postback', label: label.slice(0, 20), data, displayText: label.slice(0, 20) }; }
function parsePb(data) { return Object.fromEntries(new URLSearchParams(data)); }
async function downloadImage(messageId) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('base64');
}
async function safePush(to, msgs) {
  try { await client.pushMessage(to, msgs); } catch (e) { console.error('push error', e.originalError?.response?.data || e.message); }
}

function confirmFlex(s, venue) {
  const rows = [
    ['廠商', s.vendor ? s.vendor : `${s.vendorText || '未填'}（待採購確認）`],
    ['照片', `${s.photos.length} 張`],
    ['問題', s.description],
    ['分類', s.category],
    ['館別', venue],
  ];
  return {
    type: 'flex', altText: '請確認反映內容',
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'text', text: '📋 請確認反映內容', weight: 'bold', size: 'md', color: BRAND },
        ...rows.map(([k, v]) => ({ type: 'box', layout: 'baseline', spacing: 'sm', contents: [
          { type: 'text', text: k, size: 'sm', color: '#888888', flex: 1 },
          { type: 'text', text: String(v), size: 'sm', wrap: true, flex: 4 },
        ] })),
      ] },
      footer: { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: BRAND, action: pb('送出反映', 'a=submit') },
        { type: 'button', style: 'secondary', action: pb('重填', 'a=edit') },
        { type: 'button', style: 'secondary', action: pb('取消', 'a=cancel') },
      ] },
    },
  };
}

function caseFlex(c, opts = {}) {
  const id = c['案件編號'];
  const status = c['狀態'];
  const buttons = [];
  if (status === '待處理') buttons.push({ type: 'button', style: 'primary', color: BRAND, action: pb('我接手', `a=take&id=${id}`) });
  if (status === '處理中') buttons.push({ type: 'button', style: 'primary', color: BRAND, action: pb('結案', `a=close&id=${id}`) });
  if (c['照片連結']) buttons.push({ type: 'button', style: 'secondary', action: { type: 'uri', label: '查看照片', uri: c['照片連結'] } });
  const lines = [
    { type: 'text', text: `${opts.title || '🔔 新案件'} ${id}`, weight: 'bold', size: 'md', color: BRAND },
    { type: 'text', text: `${c['館別']}｜${c['師傅']}`, size: 'sm', color: '#888888' },
    { type: 'text', text: `廠商：${c['廠商']}${c['廠商待確認'] ? '（待確認）' : ''}`, wrap: true },
    { type: 'text', text: `問題：${c['問題描述']}`, wrap: true },
    { type: 'text', text: `分類：${c['問題分類'] || '—'}｜狀態：${status}${c['負責人'] ? '｜' + c['負責人'] : ''}`, size: 'sm', color: '#888888', wrap: true },
  ];
  return {
    type: 'flex', altText: `案件 ${id}`,
    contents: { type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: lines },
      ...(buttons.length ? { footer: { type: 'box', layout: 'horizontal', spacing: 'sm', contents: buttons } } : {}),
    },
  };
}

// ============================================================
//  Webhook
// ============================================================
app.get('/', (req, res) => res.send('vendor-complaint-bot ok'));
app.post('/webhook', line.middleware(config), (req, res) => {
  res.status(200).end();
  handleBatch(req.body.events).catch(err => console.error('batch error', err));
});

// 同一個人同一批訊息合併處理，只回一次（reply 免費、push 要算額度）
async function handleBatch(events) {
  const groups = new Map();
  for (const ev of events) {
    const key = (ev.source.groupId || ev.source.userId || 'x') + ':' + (ev.source.userId || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  for (const evs of groups.values()) {
    const replies = [];
    let replyToken = null;
    for (const ev of evs) {
      try {
        const out = ev.source.type === 'group' ? await handleGroup(ev) : ev.source.type === 'user' ? await handleUser(ev) : [];
        if (out && out.length) replies.push(...out);
        if (ev.replyToken) replyToken = ev.replyToken;
      } catch (e) {
        console.error('event error', e);
        replies.push(text('系統發生錯誤，請稍後再試或通知管理者。'));
      }
    }
    if (replyToken && replies.length) {
      try { await client.replyMessage(replyToken, replies.slice(-5)); }
      catch (e) { console.error('reply error', e.originalError?.response?.data || e.message); }
    }
  }
}

// ============================================================
//  一對一：師傅
// ============================================================
async function handleUser(ev) {
  const userId = ev.source.userId;
  if (ev.type !== 'message' && ev.type !== 'postback') return [];

  const msgText = ev.type === 'message' && ev.message.type === 'text' ? ev.message.text.trim() : null;
  const isImage = ev.type === 'message' && ev.message.type === 'image';
  const pbData = ev.type === 'postback' ? parsePb(ev.postback.data) : null;
  const s = getSession(userId);

  // 通用指令
  if (msgText === '#我的ID') return [text(`你的 LINE ID：\n${userId}`)];
  if (msgText === '#取消' || msgText === '取消') {
    if (!s) return [];
    clearSession(userId);
    return [text('已取消，這次反應不會送出。')];
  }

  // 採購在一對一也可以下指令
  if (msgText && msgText.startsWith('#')) {
    const admin = await getAdmin(userId);
    if (admin) {
      const r = await handleAdminCommand(msgText, admin, userId);
      if (r) return r;
    }
  }

  // 進行中的流程：註冊或反映
  if (s) {
    if (s.stage.startsWith('reg_')) return handleRegistration(ev, userId, s, msgText, pbData);
    const chef = await getChef(userId);
    if (chef) return handleComplaint(ev, userId, chef, s, msgText, isImage, pbData);
    clearSession(userId);
    return [];
  }

  // 沒有進行中的流程：只認觸發字，其他一律不理（讓採購正常聊天）
  if (msgText && TRIGGERS.includes(msgText)) {
    const chef = await getChef(userId);
    if (!chef) return startRegistration(userId);
    setSession(userId, newComplaint());
    return [text('好的，請把「廠商名＋問題描述」和「1-3 張照片」傳給我。\n例如：ＸＸ（廠商）的ＸＸ（商品）不新鮮，很多都爛了\n\n📌 中途想放棄，請輸入【取消】')];
  }
  if (msgText === '#我的案件') {
    const { cases } = await gas('getOpenCases');
    const mine = cases.filter(c => c['師傅LINE ID'] === userId);
    if (!mine.length) return [text('你目前沒有未結案的反映。')];
    return [text('你目前未結案的反映：\n' + mine.map(c => `${c['案件編號']}｜${c['廠商']}｜${c['狀態']}${c['負責人'] ? '（' + c['負責人'] + '）' : ''}`).join('\n'))];
  }
  return [];
}

function newComplaint() {
  return { stage: 'collect', vendor: null, vendorText: null, vendorUnconfirmed: false, description: null, category: null, photos: [] };
}

// ---------- 註冊 ----------
function startRegistration(userId) {
  setSession(userId, { stage: 'reg_venue' });
  return [quick('你好！第一次使用請先設定，請問你在哪個館？', VENUES.map(v => pb(v, `a=venue&v=${encodeURIComponent(v)}`)))];
}
async function handleRegistration(ev, userId, s, msgText, pbData) {
  if (s.stage === 'reg_venue') {
    const v = pbData?.a === 'venue' ? pbData.v : (VENUES.includes(msgText) ? msgText : null);
    if (!v) return [quick('請點選你所在的館別：', VENUES.map(x => pb(x, `a=venue&v=${encodeURIComponent(x)}`)))];
    s.venue = v; s.stage = 'reg_name'; setSession(userId, s);
    let display = '';
    try { display = (await client.getProfile(userId)).displayName; } catch (e) {}
    const items = display ? [pb(`用「${display}」`, `a=name&v=${encodeURIComponent(display)}`)] : [];
    return [quick('請問怎麼稱呼？（直接輸入名字）', items)];
  }
  if (s.stage === 'reg_name') {
    const name = pbData?.a === 'name' ? pbData.v : msgText;
    if (!name) return [text('請輸入你的名字。')];
    await gas('registerChef', { userId, name, venue: s.venue });
    cache.chef.delete(userId);
    setSession(userId, newComplaint());
    return [text(`設定完成！${s.venue} ${name} 師傅你好。\n\n現在請把「廠商名＋問題描述」和「1-3 張照片」傳給我，例如：\nＸＸ（廠商）的ＸＸ（商品）不新鮮，很多都爛了（＋照片）\n\n📌 小提醒\n1. 如需反應廠商/食品問題，請先輸入【NG商品】\n2. 中途想放棄，請輸入【取消】`)];
  }
  return [];
}

// ---------- 反映流程 ----------
async function handleComplaint(ev, userId, chef, s, msgText, isImage, pbData) {
  const venue = chef['館別'];

  // 圖片：任何階段都收
  if (isImage) {
    if (s.photos.length >= MAX_PHOTOS) return [text(`最多 ${MAX_PHOTOS} 張照片，這張就不收了。`)];
    s.photos.push({ base64: await downloadImage(ev.message.id), mime: 'image/jpeg' });
    setSession(userId, s);
    return nextStep(userId, s, venue, `收到照片（${s.photos.length}/${MAX_PHOTOS}）。`);
  }

  // 確認卡的按鈕
  if (pbData) {
    if (pbData.a === 'cancel') { clearSession(userId); return [text('已取消，這次反應不會送出。')]; }
    if (pbData.a === 'edit') { setSession(userId, newComplaint()); return [text('好，請重新傳一次「廠商名＋問題」和照片。')]; }
    if (pbData.a === 'vendor') {
      s.vendor = pbData.v; s.vendorUnconfirmed = false; s.stage = 'collect'; setSession(userId, s);
      return nextStep(userId, s, venue, `廠商：${s.vendor}。`);
    }
    if (pbData.a === 'vendor_other') {
      s.vendor = null; s.vendorUnconfirmed = true; s.stage = 'collect'; setSession(userId, s);
      return nextStep(userId, s, venue, `好，先記「${s.vendorText}」，採購會再確認。`);
    }
    if (pbData.a === 'submit') return submitCase(userId, chef, s);
    return [];
  }

  if (!msgText) return [];

  // 問廠商階段：這句話就是廠商名
  if (s.stage === 'ask_vendor' || s.stage === 'pick_vendor') {
    const vendors = await getVendors();
    const hits = matchVendors(msgText, vendors);
    s.vendorText = msgText;
    if (hits.length === 1) { s.vendor = hits[0]; s.vendorUnconfirmed = false; }
    else if (hits.length > 1) return askPick(userId, s, hits);
    else { s.vendor = null; s.vendorUnconfirmed = true; }
    s.stage = 'collect'; setSession(userId, s);
    return nextStep(userId, s, venue, s.vendor ? `廠商：${s.vendor}。` : `先記「${msgText}」，採購會再確認廠商。`);
  }

  // 一般文字：交給 Gemini 拆解
  const vendors = await getVendors();
  const a = await analyze(msgText, vendors);
  s.description = s.description ? `${s.description}；${a.description}` : a.description;
  s.category = a.category;
  if (!s.vendor) {
    if (a.vendor_match) { s.vendor = a.vendor_match; s.vendorUnconfirmed = false; s.vendorText = a.vendor_text; }
    else if (a.vendor_text) {
      s.vendorText = a.vendor_text;
      const hits = matchVendors(a.vendor_text, vendors);
      if (hits.length === 1) s.vendor = hits[0];
      else if (hits.length > 1) { setSession(userId, s); return askPick(userId, s, hits); }
      else s.vendorUnconfirmed = true;
    }
  }
  setSession(userId, s);
  return nextStep(userId, s, venue, '收到。');
}

function askPick(userId, s, hits) {
  s.stage = 'pick_vendor'; setSession(userId, s);
  const items = hits.slice(0, 3).map(h => pb(h, `a=vendor&v=${encodeURIComponent(h)}`));
  items.push(pb('都不是', 'a=vendor_other'));
  return [quick('請問是哪一家廠商？', items)];
}

// 決定下一步要問什麼
function nextStep(userId, s, venue, prefix) {
  if (!s.description && !s.vendor && !s.vendorText) {
    s.stage = 'collect'; setSession(userId, s);
    return [text(`${prefix}\n請用文字說明一下：哪一家廠商、什麼問題？\n例如：ＸＸ（廠商）的ＸＸ（商品）不新鮮，很多都爛了`)];
  }
  if (!s.vendor && !s.vendorText) {
    s.stage = 'ask_vendor'; setSession(userId, s);
    return [text(`${prefix}\n請問是哪一家廠商？`)];
  }
  if (!s.description) {
    s.stage = 'collect'; setSession(userId, s);
    return [text(`${prefix}\n請簡單描述一下問題（例如：不新鮮很多都爛了、少送兩箱）。`)];
  }
  if (s.photos.length === 0) {
    s.stage = 'collect'; setSession(userId, s);
    return [text(`${prefix}\n請傳 1-3 張照片，方便採購跟廠商反映。`)];
  }
  s.stage = 'confirm'; setSession(userId, s);
  return [confirmFlex(s, venue)];
}

async function submitCase(userId, chef, s) {
  const { caseId, photoUrl } = await gas('createCase', {
    venue: chef['館別'], chefName: chef['姓名'], chefId: userId,
    vendor: s.vendor || s.vendorText || '未填', vendorUnconfirmed: !s.vendor,
    description: s.description, category: s.category, photos: s.photos,
  });
  clearSession(userId);

  // 通知採購
  const { case: c } = await gas('getCase', { caseId });
  const { value: groupId } = await gas('getConfig', { key: '採購群ID' });
  if (groupId) await safePush(groupId, [caseFlex(c)]);
  else {
    const { admins } = await gas('getAdmins');
    for (const a of admins) await safePush(a['LINE ID'], [caseFlex(c)]);
  }
  return [text(`✅ 已建立案件 ${caseId}，採購已收到通知，處理進度會再回報你。\n\n採購如果有問題會直接在這裡問你，正常回覆就好。`)];
}

// ============================================================
//  群組：採購
// ============================================================
async function handleGroup(ev) {
  const groupId = ev.source.groupId;
  const userId = ev.source.userId;

  if (ev.type === 'join') {
    return [text('大家好，我是廠商反映機器人。\n請一位採購輸入「#設定採購群」把這個群設為案件通知群，\n每位採購請輸入「#我是採購 你的名字」完成登記。')];
  }
  if (ev.type !== 'message' && ev.type !== 'postback') return [];
  const msgText = ev.type === 'message' && ev.message.type === 'text' ? ev.message.text.trim() : null;
  const pbData = ev.type === 'postback' ? parsePb(ev.postback.data) : null;
  if (!userId) return [];

  // 登記與設定
  if (msgText === '#設定採購群') {
    await gas('setConfig', { key: '採購群ID', value: groupId });
    return [text('✅ 已將這個群設為採購案件通知群。')];
  }
  if (msgText && msgText.startsWith('#我是採購')) {
    const name = msgText.replace('#我是採購', '').trim();
    if (!name) return [text('請在後面加上名字，例如：#我是採購 小美')];
    await gas('registerAdmin', { userId, name });
    cache.admin.delete(userId);
    return [text(`✅ ${name} 已登記為採購。`)];
  }

  const admin = await getAdmin(userId);
  const s = getSession(userId);

  // 結案中：這句話就是處理結果
  if (admin && s && s.stage === 'closing' && msgText) {
    if (msgText === '取消' || msgText === '#取消') { clearSession(userId); return [text('已取消結案。')]; }
    if (!msgText.startsWith('#')) { clearSession(userId); return closeCase(s.caseId, admin, msgText); }
  }

  if (pbData) {
    if (!admin) return [text('請先輸入「#我是採購 你的名字」完成登記，再按按鈕。')];
    if (pbData.a === 'take') {
      const r = await gas('takeCase', { caseId: pbData.id, adminName: admin['姓名'] });
      if (r.already) return [text(`案件 ${pbData.id} 已由 ${r.handler} 接手。`)];
      const c = r.case;
      await safePush(c['師傅LINE ID'], [text(`採購 ${admin['姓名']} 已接手你的案件 ${pbData.id}，如需補充細節會直接在這裡問你。`)]);
      return [text(`${admin['姓名']} 已接手 ${pbData.id}`), caseFlex(c, { title: '🛠 處理中' })];
    }
    if (pbData.a === 'close') {
      setSession(userId, { stage: 'closing', caseId: pbData.id });
      return [text(`${admin['姓名']}，請直接輸入案件 ${pbData.id} 的處理結果（例如：廠商同意明日補貨 2 箱）。\n輸入【取消】可放棄。`)];
    }
    return [];
  }

  if (msgText && msgText.startsWith('#')) {
    if (msgText === '#取消') { clearSession(userId); return [text('已取消。')]; }
    if (!admin) return [text('請先輸入「#我是採購 你的名字」完成登記。')];
    const r = await handleAdminCommand(msgText, admin, userId);
    if (r) return r;
  }
  return []; // 其他閒聊一律不理
}

// 採購文字指令（群組或一對一都可用）
async function handleAdminCommand(msgText, admin, userId) {
  const [cmd, ...rest] = msgText.split(/\s+/);
  if (cmd === '#未結案') {
    const { cases } = await gas('getOpenCases');
    if (!cases.length) return [text('目前沒有未結案的案件 🎉')];
    return [text('未結案：\n' + cases.map(c => `${c['案件編號']}｜${c['館別']}｜${c['廠商']}｜${c['狀態']}${c['負責人'] ? '（' + c['負責人'] + '）' : ''}`).join('\n'))];
  }
  if (cmd === '#結案') {
    const [id, ...res] = rest;
    if (!id || !res.length) return [text('格式：#結案 案件編號 處理結果\n例如：#結案 20260904-01 廠商同意明日補貨2箱')];
    return closeCase(id, admin, res.join(' '));
  }
  if (cmd === '#廠商') {
    const [id, ...v] = rest;
    if (!id || !v.length) return [text('格式：#廠商 案件編號 正確廠商名')];
    await gas('updateVendor', { caseId: id, vendor: v.join(' '), adminName: admin['姓名'] });
    return [text(`✅ 案件 ${id} 廠商已改為「${v.join(' ')}」`)];
  }
  if (cmd === '#案件') {
    const id = rest[0];
    if (!id) return [text('格式：#案件 案件編號')];
    const { case: c } = await gas('getCase', { caseId: id });
    if (!c) return [text('找不到這個案件。')];
    return [caseFlex(c, { title: '📄 案件' })];
  }
  if (cmd === '#開單') {
    const q = rest.join(' ').trim();
    if (!q) return [text('格式：#開單 師傅名字\n例如：#開單 慶哥')];
    const { chefs } = await gas('findChefs', { name: q });
    if (!chefs.length) return [text(`找不到叫「${q}」的師傅。師傅要先跟 LINE@ 打過「NG商品」完成設定，名單裡才有他。`)];
    if (chefs.length > 1) return [text('找到多位，請打更完整的名字：\n' + chefs.map(c => `${c['館別']} ${c['姓名']}`).join('\n'))];
    const chef = chefs[0];
    setSession(chef['LINE ID'], newComplaint());
    await safePush(chef['LINE ID'], [text(`採購 ${admin['姓名']} 幫你開了 NG商品 反應流程。\n請把「廠商名＋問題描述」和「1-3 張照片」傳給我，例如：\nＸＸ（廠商）的ＸＸ（商品）不新鮮，很多都爛了\n\n📌 中途想放棄，請輸入【取消】`)]);
    return [text(`✅ 已請 ${chef['館別']} ${chef['姓名']} 師傅傳送反應內容。`)];
  }
  if (cmd === '#說明') {
    return [text('採購指令：\n#未結案 — 列出未結案\n#案件 編號 — 查看案件\n#結案 編號 處理結果 — 結案\n#廠商 編號 正確廠商名 — 修正廠商\n#開單 師傅名字 — 幫師傅開啟反應流程\n#設定採購群 — 把目前群組設為通知群\n#我是採購 名字 — 登記為採購')];
  }
  return null;
}

async function closeCase(caseId, admin, result) {
  const { case: c } = await gas('closeCase', { caseId, adminName: admin['姓名'], result });
  await safePush(c['師傅LINE ID'], [text(`✅ 你的案件 ${caseId} 已結案\n廠商：${c['廠商']}\n處理結果：${result}\n\n謝謝你的反映！`)]);
  return [text(`✅ 案件 ${caseId} 已結案｜${admin['姓名']}\n處理結果：${result}`)];
}

// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('bot listening on', PORT));
