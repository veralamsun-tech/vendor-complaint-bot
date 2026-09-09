// ============================================================
//  典華 採購LINE@ 廠商反映機器人 (v2)
//  師傅照平常傳訊息；採購用 #開單 建案；預覽卡在採購群確認
//  環境變數：LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, GAS_URL, GAS_KEY
// ============================================================
const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const GAS_URL = process.env.GAS_URL;
const GAS_KEY = process.env.GAS_KEY;

const BRAND = '#968571';
const VENUES = ['大直館', '新莊館', '士林館'];
const MAX_PHOTOS = 5;
const BURST_GAP_MS = 15 * 60 * 1000;     // 師傅訊息間隔超過 15 分鐘就視為另一件事
const LOOKBACK_MS = 3 * 24 * 3600 * 1000; // 訊息保存 3 天（存在試算表「訊息暫存」）
const BUFFER_TTL = 30 * 60 * 1000;       // 記憶體暫存 30 分鐘（試算表才是正本）
const DRAFT_TTL = 30 * 60 * 1000;        // 預覽 30 分鐘未確認作廢
const NG_DEBOUNCE_MS = 60 * 1000;        // 師傅打 NG 後等 60 秒再出預覽
const CACHE_TTL = 10 * 60 * 1000;

const client = new line.Client(config);
const app = express();

// ============================================================
//  記憶體：訊息暫存 / 預覽草稿 / 快取
// ============================================================
const buffers = new Map();     // userId -> [{ts, type, text, messageId, chatId, chatType}]
const drafts = new Map();      // draftId -> draft
let lastDraftId = null;
const ngTimers = new Map();    // userId -> timeout
const nameCache = new Map();   // chatId:userId -> {name, at}
const cache = { vendors: null, vendorsAt: 0, chefs: null, chefsAt: 0, admins: new Map(), groups: null, groupsAt: 0 };

function remember(ev) {
  const userId = ev.source.userId;
  if (!userId || ev.type !== 'message') return;
  const m = ev.message;
  if (m.type !== 'text' && m.type !== 'image') return;
  const chatType = ev.source.type;
  const chatId = chatType === 'group' ? ev.source.groupId : chatType === 'room' ? ev.source.roomId : userId;
  const item = { ts: ev.timestamp || Date.now(), type: m.type, text: m.type === 'text' ? m.text : '', messageId: m.id, chatId, chatType, userId };
  const list = buffers.get(userId) || [];
  list.push(item);
  buffers.set(userId, list.slice(-40));
  pendingSave.push(item);
  if (!saveTimer) saveTimer = setTimeout(flushPending, 2500);
}

// 寫進試算表「訊息暫存」（只存一對一和設定過的師傅群；廠商群不存）
let pendingSave = [];
let saveTimer = null;
let flushing = null;
async function flushPending() {
  saveTimer = null;
  if (flushing) await flushing;
  if (!pendingSave.length) return;
  const batch = pendingSave; pendingSave = [];
  flushing = (async () => {
    try {
      const g = await getGroups();
      const msgs = [];
      for (const it of batch) {
        if (it.chatType !== 'user' && !g.venues[it.chatId]) continue;
        if (it.type === 'text' && parseCommand(it.text)) continue;
        const displayName = await displayNameOf(it.userId, it.chatId, it.chatType);
        msgs.push({ ...it, displayName });
      }
      if (msgs.length) await gas('saveMsgs', { msgs });
    } catch (e) { console.error('saveMsgs error', e.message); }
  })();
  await flushing;
  flushing = null;
}
async function chefMessages(userId) {
  await flushPending();
  const { msgs } = await gas('getMsgs', { userId, since: Date.now() - LOOKBACK_MS });
  const seen = new Set(msgs.map(m => m.messageId));
  for (const it of (buffers.get(userId) || [])) if (!seen.has(it.messageId)) msgs.push(it);
  return msgs.sort((a, b) => a.ts - b.ts);
}
async function recentSenders(chatId) {
  await flushPending();
  const { senders } = await gas('recentSenders', { since: Date.now() - LOOKBACK_MS, chatId: chatId || '' });
  return senders;
}
setInterval(() => {
  const cutoff = Date.now() - BUFFER_TTL;
  for (const [uid, list] of buffers) {
    const kept = list.filter(i => i.ts >= cutoff);
    if (kept.length) buffers.set(uid, kept); else buffers.delete(uid);
  }
  for (const [id, d] of drafts) if (Date.now() - d.createdAt > DRAFT_TTL) drafts.delete(id);
}, 60 * 1000);

async function findBufferedMessage(messageId) {
  for (const [uid, list] of buffers) {
    const item = list.find(i => i.messageId === messageId);
    if (item) return { userId: uid, item };
  }
  await flushPending();
  const { msg } = await gas('findMsg', { messageId });
  return msg ? { userId: msg.userId, item: msg } : null;
}

// ============================================================
//  Google Apps Script
// ============================================================
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
async function getVendors(force) {
  if (!force && cache.vendors && Date.now() - cache.vendorsAt < CACHE_TTL) return cache.vendors;
  const { vendors } = await gas('getVendors');
  cache.vendors = vendors; cache.vendorsAt = Date.now();
  return vendors;
}
async function getChefs(force) {
  if (!force && cache.chefs && Date.now() - cache.chefsAt < CACHE_TTL) return cache.chefs;
  const { chefs } = await gas('getChefs');
  cache.chefs = chefs; cache.chefsAt = Date.now();
  return chefs;
}
async function getAdmin(userId) {
  const c = cache.admins.get(userId);
  if (c && Date.now() - c.at < CACHE_TTL) return c.v;
  const { admin } = await gas('getAdmin', { userId });
  cache.admins.set(userId, { v: admin, at: Date.now() });
  return admin;
}
async function getGroups(force) {
  if (!force && cache.groups && Date.now() - cache.groupsAt < CACHE_TTL) return cache.groups;
  const { groups, purchasingGroupId } = await gas('getGroups');
  cache.groups = { venues: groups, purchasingGroupId }; cache.groupsAt = Date.now();
  return cache.groups;
}

// ============================================================
//  小工具
// ============================================================
function text(t) { return { type: 'text', text: t }; }
function pb(label, data) { return { type: 'postback', label: label.slice(0, 20), data, displayText: label.slice(0, 20) }; }
function parsePb(data) { return Object.fromEntries(new URLSearchParams(data)); }
function norm(s) { return String(s || '').replace(/[\s\u3000]/g, '').toLowerCase(); }
function dateLabel(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  const today = new Date(Date.now() + 8 * 3600 * 1000);
  const sameDay = d.toISOString().slice(0, 10) === today.toISOString().slice(0, 10);
  return (sameDay ? '' : d.toISOString().slice(5, 10).replace('-', '/') + ' ') + d.toISOString().slice(11, 16);
}
function hhmm(ts) { return new Date(ts + 8 * 3600 * 1000).toISOString().slice(11, 16); }
async function safePush(to, msgs) {
  try { await client.pushMessage(to, msgs); } catch (e) { console.error('push error', e.originalError?.response?.data || e.message); }
}
async function downloadImage(messageId) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('base64');
}
async function displayNameOf(userId, chatId, chatType) {
  const key = chatId + ':' + userId;
  const c = nameCache.get(key);
  if (c && Date.now() - c.at < CACHE_TTL) return c.name;
  let name = '';
  try {
    if (chatType === 'group') name = (await client.getGroupMemberProfile(chatId, userId)).displayName;
    else if (chatType === 'room') name = (await client.getRoomMemberProfile(chatId, userId)).displayName;
    else name = (await client.getProfile(userId)).displayName;
  } catch (e) { name = ''; }
  nameCache.set(key, { name, at: Date.now() });
  return name;
}
// 「新莊/雅聚中廚砧板頭/周振揚」→ { name: 周振揚, venue: 新莊館 }
function parseDisplayName(dn) {
  const parts = String(dn || '').split(/[\/／|｜]/).map(s => s.trim()).filter(Boolean);
  const name = parts.length ? parts[parts.length - 1] : String(dn || '');
  let venue = '';
  for (const v of VENUES) if (String(dn || '').includes(v.replace('館', ''))) { venue = v; break; }
  return { name, venue };
}

// 指令解析：訊息任何位置出現 #指令 都算，其餘文字切成 tokens
const COMMANDS = ['開單', '刪照片', '取消', '作廢', '未結案', '案件', '結案', '廠商', '說明', '設定採購群', '設定館別', '我是採購', '我的ID', '我的', '確認'];
function parseCommand(t) {
  if (!t) return null;
  const s = t.replace(/\u3000/g, ' ');
  const re = new RegExp('[#＃]\\s*(' + COMMANDS.join('|') + ')');
  const m = s.match(re);
  if (!m) {
    if (/^\s*取消\s*$/.test(s)) return { cmd: '取消', tokens: [], rest: '' };
    return null;
  }
  const rest = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/[「」【】\[\]（）()]/g, ' ');
  const tokens = rest.split(/\s+/).map(x => x.trim()).filter(Boolean);
  return { cmd: m[1], tokens, rest: tokens.join(' ') };
}
// 師傅訊息開頭是 NG（寬鬆）
function isNgMessage(t) {
  return /^[\s「」【】\[\]（）()#＃]*[nNｎＮ][gGｇＧ]/.test(String(t || ''));
}

// ============================================================
//  比對：廠商 / 師傅
// ============================================================
function matchVendor(token, vendors) {
  const t = norm(token);
  if (t.length < 2) return null;
  let hit = vendors.find(v => norm(v.name) === t || v.aliases.some(a => norm(a) === t));
  if (hit) return hit.name;
  const partial = vendors.filter(v => norm(v.name).includes(t) || t.includes(norm(v.name)) ||
    v.aliases.some(a => norm(a).includes(t) || t.includes(norm(a))));
  return partial.length === 1 ? partial[0].name : (partial.length > 1 ? partial[0].name : null);
}

async function resolveChefByToken(token, ctx) {
  const t = norm(token);
  if (t.length < 2) return null;
  // 1) 師傅名單
  const chefs = await getChefs();
  const c = chefs.find(x => norm(x['姓名']) === t) || chefs.find(x => norm(x['姓名']).includes(t) || t.includes(norm(x['姓名'])));
  if (c) return { userId: c['LINE ID'], name: c['姓名'], venue: c['館別'], registered: true };
  // 2) 最近 3 天有傳訊息的人（同一個群優先）
  const senders = await recentSenders(ctx.anyChat ? '' : ctx.chatId);
  const hit = senders.find(x => x.displayName && norm(x.displayName).includes(t));
  if (!hit) return null;
  const parsed = parseDisplayName(hit.displayName);
  return { userId: hit.userId, name: parsed.name, venue: parsed.venue, registered: false, chatId: hit.chatId };
}

async function chefInfoByUserId(userId, chatId, chatType) {
  const chefs = await getChefs();
  const c = chefs.find(x => x['LINE ID'] === userId);
  if (c) return { userId, name: c['姓名'], venue: c['館別'], registered: true };
  const dn = await displayNameOf(userId, chatId, chatType);
  const parsed = parseDisplayName(dn);
  return { userId, name: parsed.name || '師傅', venue: parsed.venue, registered: false };
}

// ============================================================
//  建立草稿（預覽）
// ============================================================
async function buildDraft({ chef, vendorToken, descTokens, quoted, byAdmin }) {
  const vendors = await getVendors();
  const all = await chefMessages(chef.userId);
  // 把師傅的訊息依時間切成「一段一段」（間隔超過 15 分鐘就是另一件事）
  const bursts = [];
  for (const it of all) {
    const last = bursts.length ? bursts[bursts.length - 1] : null;
    if (last && it.chatId === last[0].chatId && it.ts - last[last.length - 1].ts <= BURST_GAP_MS) last.push(it);
    else bursts.push([it]);
  }
  let items = [];
  if (quoted) items = bursts.find(b => b.some(i => i.messageId === quoted.messageId)) || [];
  else if (bursts.length) items = bursts[bursts.length - 1]; // 最近的一段

  const texts = items.filter(i => i.type === 'text' && !parseCommand(i.text)).map(i => i.text.trim()).filter(Boolean);
  const photos = items.filter(i => i.type === 'image').slice(-MAX_PHOTOS).map(i => ({ messageId: i.messageId, ts: i.ts }));
  const src = items.length ? items[items.length - 1] : null;

  let vendor = vendorToken ? matchVendor(vendorToken, vendors) : null;
  let vendorUnconfirmed = false;
  if (!vendor) {
    // 從師傅原話裡找廠商
    for (const t of texts.join(' ').split(/[\s，,。、；;：:]+/)) { const v = matchVendor(t, vendors); if (v) { vendor = v; break; } }
  }
  if (!vendor) { vendor = vendorToken || '未填'; vendorUnconfirmed = true; }

  const description = descTokens && descTokens.length ? descTokens.join(' ') : texts.join('；');

  // 館別：師傅名單 > 顯示名稱 > 該群設定
  let venue = chef.venue || '';
  if (!venue && src && src.chatType === 'group') {
    const g = await getGroups();
    venue = g.venues[src.chatId] || '';
  }

  const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
  const draft = {
    id, createdAt: Date.now(), chef, venue, vendor, vendorUnconfirmed, description, photos,
    sourceChatId: src ? src.chatId : chef.userId, sourceChatType: src ? src.chatType : 'user',
    byAdmin: byAdmin || null,
  };
  drafts.set(id, draft);
  lastDraftId = id;
  return draft;
}

function previewFlex(d) {
  const photoLine = d.photos.length ? d.photos.map((p, i) => `${'①②③④⑤'[i] || (i + 1)}${dateLabel(p.ts)}`).join('  ') : '（無）';
  const rows = [
    ['師傅', `${d.venue || '館別未知'} ${d.chef.name}`],
    ['廠商', d.vendorUnconfirmed ? `${d.vendor} ⚠ 待確認` : d.vendor],
    ['描述', d.description || '（無文字）'],
    ['照片', photoLine],
  ];
  return {
    type: 'flex', altText: `預覽：${d.chef.name}｜${d.vendor}`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'text', text: '📋 預覽（尚未建立）', weight: 'bold', size: 'md', color: BRAND },
        ...rows.map(([k, v]) => ({ type: 'box', layout: 'baseline', spacing: 'sm', contents: [
          { type: 'text', text: k, size: 'sm', color: '#888888', flex: 1 },
          { type: 'text', text: String(v), size: 'sm', wrap: true, flex: 5 },
        ] })),
        { type: 'text', text: '修改：重打 #開單 帶正確內容｜刪照片：#刪照片 2', size: 'xs', color: '#999999', wrap: true, margin: 'md' },
      ] },
      footer: { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: BRAND, action: pb('確認建立', `a=confirm&d=${d.id}`) },
        { type: 'button', style: 'secondary', action: pb('取消', `a=discard&d=${d.id}`) },
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
    { type: 'text', text: `${c['館別']}｜${c['師傅']}${c['開單人'] ? '｜開單：' + c['開單人'] : ''}`, size: 'sm', color: '#888888', wrap: true },
    { type: 'text', text: `廠商：${c['廠商']}${c['廠商待確認'] ? '（待確認）' : ''}`, wrap: true },
    { type: 'text', text: `問題：${c['問題描述'] || '—'}`, wrap: true },
    { type: 'text', text: `狀態：${status}${c['負責人'] ? '｜' + c['負責人'] : ''}`, size: 'sm', color: '#888888', wrap: true },
  ];
  return {
    type: 'flex', altText: `案件 ${id}`,
    contents: { type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: lines },
      ...(buttons.length ? { footer: { type: 'box', layout: 'horizontal', spacing: 'sm', contents: buttons } } : {}),
    },
  };
}


// 多張案件卡（最多 10 張）
function casesCarousel(cases, title) {
  const bubbles = cases.slice(0, 10).map(c => caseFlex(c, { title: title || (c['狀態'] === '處理中' ? '🛠 處理中' : '🔔 待處理') }).contents);
  return { type: 'flex', altText: `${cases.length} 件案件`, contents: { type: 'carousel', contents: bubbles } };
}
// 用編號或名字（師傅／廠商）找未結案；回 {case} / {choices} / null
async function resolveOpenCase(token, adminName) {
  const { cases } = await gas('getOpenCases');
  if (!token) return { choices: cases };
  if (/^\d{8}-\d{2}$/.test(token)) {
    const { case: c } = await gas('getCase', { caseId: token });
    return c ? { case: c } : null;
  }
  const t = norm(token);
  let hits = cases.filter(c => norm(c['師傅']).includes(t) || norm(c['廠商']).includes(t) || t.includes(norm(c['廠商'])) || norm(c['館別']).includes(t));
  if (hits.length > 1 && adminName) {
    const mine = hits.filter(c => c['負責人'] === adminName);
    if (mine.length === 1) hits = mine;
  }
  if (hits.length === 1) return { case: hits[0] };
  if (hits.length > 1) return { choices: hits };
  return null;
}
function caseQuickReply(prompt, cases, action) {
  const items = cases.slice(0, 12).map(c => pb(`${c['廠商']}/${c['師傅']}`.slice(0, 20), `a=${action}&id=${c['案件編號']}`));
  return quickMsg(prompt, items);
}
function quickMsg(t, items) {
  return { type: 'text', text: t, quickReply: { items: items.map(i => ({ type: 'action', action: i })) } };
}

// 把預覽送到採購群（若指令就是在採購群打的，用 reply 回；否則 push）
async function sendPreview(draft, ctx) {
  const g = await getGroups();
  const pg = g.purchasingGroupId;
  if (pg && ctx.chatId !== pg) {
    await safePush(pg, [previewFlex(draft)]);
    return ctx.inVenueGroup ? [] : [text('📋 預覽已送到採購群，請到那邊確認。')];
  }
  return [previewFlex(draft)];
}

// ============================================================
//  確認建立
// ============================================================
async function confirmDraft(draftId, admin) {
  const d = drafts.get(draftId);
  if (!d) return [text('這張預覽已失效（可能超過 30 分鐘或已被處理），請重新 #開單。')];
  drafts.delete(draftId);
  if (lastDraftId === draftId) lastDraftId = null;

  // 自動登記師傅
  if (!d.chef.registered) {
    try { await gas('registerChef', { userId: d.chef.userId, name: d.chef.name, venue: d.venue }); cache.chefs = null; } catch (e) { console.error(e); }
  }
  // 下載照片
  const photos = [];
  let failed = 0;
  for (const p of d.photos) {
    try { photos.push({ base64: await downloadImage(p.messageId), mime: 'image/jpeg' }); }
    catch (e) { failed++; console.error('photo download failed', p.messageId, e.message); }
  }
  const { case: c, caseId } = await gas('createCase', {
    venue: d.venue, chefName: d.chef.name, chefId: d.chef.userId,
    vendor: d.vendor, vendorUnconfirmed: d.vendorUnconfirmed,
    description: d.description, category: '', photos,
    source: d.sourceChatType === 'user' ? '一對一' : d.sourceChatId,
    createdBy: admin ? admin['姓名'] : '',
  });

  // 通知師傅端（來源群或一對一）一行
  const line1 = `✅ 已建立案件 ${caseId}（${d.vendor}／${(d.description || '').slice(0, 30)}），採購處理中。`;
  const g = await getGroups();
  if (d.sourceChatType === 'user') await safePush(d.chef.userId, [text(line1)]);
  else if (g.venues[d.sourceChatId]) await safePush(d.sourceChatId, [text(line1)]);

  const out = [caseFlex(c)];
  if (failed) out.push(text(`⚠ 有 ${failed} 張照片已無法從 LINE 取得（放太久），請師傅補傳，採購再到雲端資料夾補上。`));
  return out;
}

// ============================================================
//  Webhook
// ============================================================
app.get('/', (req, res) => res.send('vendor-complaint-bot v2 ok'));
app.post('/webhook', line.middleware(config), (req, res) => {
  res.status(200).end();
  handleBatch(req.body.events).catch(err => console.error('batch error', err));
});

async function handleBatch(events) {
  for (const ev of events) remember(ev);
  const groups = new Map();
  for (const ev of events) {
    const key = (ev.source.groupId || ev.source.roomId || ev.source.userId || 'x') + ':' + (ev.source.userId || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }
  for (const evs of groups.values()) {
    const replies = [];
    let replyToken = null;
    for (const ev of evs) {
      try {
        const out = await handleEvent(ev);
        if (out && out.length) replies.push(...out);
        if (ev.replyToken) replyToken = ev.replyToken;
      } catch (e) {
        console.error('event error', e);
        replies.push(text('系統發生錯誤：' + (e.message || '').slice(0, 80)));
      }
    }
    if (replyToken && replies.length) {
      try { await client.replyMessage(replyToken, replies.slice(-5)); }
      catch (e) { console.error('reply error', e.originalError?.response?.data || e.message); }
    }
  }
}

async function handleEvent(ev) {
  if (ev.type !== 'message' && ev.type !== 'postback') return [];
  const userId = ev.source.userId;
  if (!userId) return [];
  const chatType = ev.source.type;
  const chatId = chatType === 'group' ? ev.source.groupId : chatType === 'room' ? ev.source.roomId : userId;
  const msgText = ev.type === 'message' && ev.message.type === 'text' ? ev.message.text : null;
  const pbData = ev.type === 'postback' ? parsePb(ev.postback.data) : null;

  const g = await getGroups();
  const isPurchasingGroup = chatType !== 'user' && chatId === g.purchasingGroupId;
  const venueOfGroup = chatType !== 'user' ? (g.venues[chatId] || '') : '';
  const inVenueGroup = !!venueOfGroup;
  const ctx = { chatId, chatType, isPurchasingGroup, inVenueGroup, anyChat: isPurchasingGroup || chatType === 'user' };

  // ---- 按鈕（只在採購群 / 一對一 理會）----
  if (pbData) {
    if (!isPurchasingGroup && chatType !== 'user') return [];
    const admin = await getAdmin(userId);
    if (!admin) return [text('請先登記：#我是採購 你的名字')];
    if (pbData.a === 'confirm') return confirmDraft(pbData.d, admin);
    if (pbData.a === 'discard') { drafts.delete(pbData.d); return [text('已取消這張預覽。')]; }
    if (pbData.a === 'take') {
      const r = await gas('takeCase', { caseId: pbData.id, adminName: admin['姓名'] });
      if (r.already) return [text(`案件 ${pbData.id} 已由 ${r.handler} 接手。`)];
      return [text(`${admin['姓名']} 已接手 ${pbData.id}`), caseFlex(r.case, { title: '🛠 處理中' })];
    }
    if (pbData.a === 'void') {
      await gas('voidCase', { caseId: pbData.id, adminName: admin['姓名'], reason: '' });
      return [text(`🗑 案件 ${pbData.id} 已作廢。`)];
    }
    if (pbData.a === 'close') {
      drafts.set('closing:' + userId, { closingCaseId: pbData.id, createdAt: Date.now() });
      return [text(`${admin['姓名']}，請直接輸入案件 ${pbData.id} 的處理結果（例如：廠商同意明日補貨 2 箱）。\n輸入【取消】可放棄。`)];
    }
    return [];
  }

  if (!msgText) {
    // 圖片等：只暫存，不回；若師傅剛打過 NG，照片進來就重新計時
    if (ngTimers.has(userId)) scheduleNgDraft(userId, chatId, chatType);
    return [];
  }

  const cmd = parseCommand(msgText);

  // ---- 師傅打 NG 開頭（一對一或師傅群）→ 60 秒後自動出預覽到採購群 ----
  if (!cmd && isNgMessage(msgText) && (chatType === 'user' || inVenueGroup)) {
    scheduleNgDraft(userId, chatId, chatType);
    return [];
  }

  if (!cmd) {
    // 結案中：這句話就是處理結果（採購在採購群或一對一）
    const closing = drafts.get('closing:' + userId);
    if (closing && (isPurchasingGroup || chatType === 'user')) {
      const admin = await getAdmin(userId);
      if (admin) {
        drafts.delete('closing:' + userId);
        return closeCase(closing.closingCaseId, admin, msgText.trim());
      }
    }
    return []; // 其他一律不理
  }

  // ---- 登記 / 設定（不需要先是採購）----
  if (cmd.cmd === '我的ID') return [text(`你的 LINE ID：\n${userId}`)];
  if (cmd.cmd === '設定採購群') {
    if (chatType === 'user') return [text('請在採購群裡輸入這個指令。')];
    await gas('setConfig', { key: '採購群ID', value: chatId });
    cache.groups = null;
    return [text('✅ 已將這個群設為採購案件通知群。')];
  }
  if (cmd.cmd === '我是採購') {
    const name = cmd.tokens.join(' ').trim();
    if (!name) return [text('請在後面加上名字，例如：#我是採購 小美')];
    if (!isPurchasingGroup && chatType !== 'user') return [];
    await gas('registerAdmin', { userId, name });
    cache.admins.delete(userId);
    return [text(`✅ ${name} 已登記為採購。`)];
  }

  // ---- 以下都要是採購 ----
  const admin = await getAdmin(userId);
  if (!admin) {
    if (cmd.cmd === '取消') return [];
    if (isPurchasingGroup || chatType === 'user') return [text('請先在採購群登記：#我是採購 你的名字')];
    if (inVenueGroup && cmd.cmd === '開單') return [text('請先在採購群登記：#我是採購 你的名字')];
    return [];
  }
  // 未設定的群（例如廠商群）：完全不回
  if (chatType !== 'user' && !isPurchasingGroup && !inVenueGroup && cmd.cmd !== '設定館別') return [];

  if (cmd.cmd === '設定館別') {
    if (chatType === 'user') return [text('請在師傅群裡輸入這個指令。')];
    const v = cmd.tokens.find(t => VENUES.includes(t)) || cmd.tokens.find(t => VENUES.includes(t + '館'));
    if (!v) return [text('格式：#設定館別 大直館／新莊館／士林館')];
    const venue = VENUES.includes(v) ? v : v + '館';
    await gas('setGroupVenue', { groupId: chatId, venue });
    cache.groups = null;
    return [text(`✅ 這個群已設定為「${venue}」師傅群。採購在這裡打 #開單 就能建案。`)];
  }

  if (cmd.cmd === '取消') {
    if (drafts.has('closing:' + userId)) { drafts.delete('closing:' + userId); return [text('已取消結案。')]; }
    if (lastDraftId && drafts.has(lastDraftId)) { drafts.delete(lastDraftId); lastDraftId = null; return [text('已取消預覽。')]; }
    return [];
  }

  if (cmd.cmd === '開單') return openCase(ev, cmd, admin, ctx);

  if (cmd.cmd === '刪照片') {
    const d = lastDraftId ? drafts.get(lastDraftId) : null;
    if (!d) return [text('目前沒有待確認的預覽。')];
    const nums = cmd.tokens.join(' ').match(/\d+/g);
    if (!nums) return [text('格式：#刪照片 2（照片編號）')];
    const idx = new Set(nums.map(n => parseInt(n, 10) - 1));
    d.photos = d.photos.filter((p, i) => !idx.has(i));
    return sendPreview(d, ctx);
  }

  if (cmd.cmd === '確認') {
    if (!lastDraftId || !drafts.has(lastDraftId)) return [text('目前沒有待確認的預覽。')];
    return confirmDraft(lastDraftId, admin);
  }

  if (cmd.cmd === '未結案' || cmd.cmd === '我的') {
    let { cases } = await gas('getOpenCases');
    if (cmd.cmd === '我的') cases = cases.filter(c => c['負責人'] === admin['姓名']);
    if (!cases.length) return [text(cmd.cmd === '我的' ? '你目前沒有處理中的案件。' : '目前沒有未結案的案件 🎉')];
    const out = [casesCarousel(cases)];
    if (cases.length > 10) out.push(text(`共 ${cases.length} 件，只顯示最近 10 件。`));
    return out;
  }
  if (cmd.cmd === '案件') {
    const r = await resolveOpenCase(cmd.tokens[0], admin['姓名']);
    if (!r) return [text('找不到這個案件。可以打編號、師傅名或廠商名。')];
    if (r.choices) return [casesCarousel(r.choices, '📄 案件')];
    return [caseFlex(r.case, { title: '📄 案件' })];
  }
  if (cmd.cmd === '結案') {
    // 用法：#結案（挑選）／#結案 編號或名字 處理結果
    const [key, ...res] = cmd.tokens;
    const r = await resolveOpenCase(key, admin['姓名']);
    if (!r) return [text(`找不到「${key}」的案件。可以打編號、師傅名或廠商名，或直接打 #結案 從清單挑。`)];
    if (r.choices) {
      if (!r.choices.length) return [text('目前沒有未結案的案件。')];
      return [caseQuickReply('要結哪一件？點一下：', r.choices, 'close')];
    }
    const id = r.case['案件編號'];
    if (!res.length) {
      drafts.set('closing:' + userId, { closingCaseId: id, createdAt: Date.now() });
      return [text(`${admin['姓名']}，請輸入案件 ${id}（${r.case['廠商']}／${r.case['師傅']}）的處理結果。\n輸入【取消】可放棄。`)];
    }
    return closeCase(id, admin, res.join(' '));
  }
  if (cmd.cmd === '廠商') {
    const [key, ...v] = cmd.tokens;
    if (!key || !v.length) return [text('格式：#廠商 編號或師傅名 正確廠商名')];
    const r = await resolveOpenCase(key, admin['姓名']);
    if (!r || r.choices) return [text('找不到唯一的案件，請改用編號。')];
    const id = r.case['案件編號'];
    await gas('updateVendor', { caseId: id, vendor: v.join(' '), adminName: admin['姓名'] });
    return [text(`✅ 案件 ${id} 廠商已改為「${v.join(' ')}」`)];
  }
  if (cmd.cmd === '作廢') {
    const [key, ...reason] = cmd.tokens;
    const r = await resolveOpenCase(key, admin['姓名']);
    if (!r) return [text('找不到這個案件。可以打編號、師傅名或廠商名。')];
    if (r.choices) return [caseQuickReply('要作廢哪一件？點一下：', r.choices, 'void')];
    const id = r.case['案件編號'];
    await gas('voidCase', { caseId: id, adminName: admin['姓名'], reason: reason.join(' ') });
    return [text(`🗑 案件 ${id} 已作廢。`)];
  }
  if (cmd.cmd === '說明') {
    return [text('採購指令：\n#開單 師傅名 廠商名 [補充描述] — 建案（可引用師傅訊息，省略師傅名）\n#刪照片 2 — 預覽時刪掉第 2 張\n#確認 — 確認最新預覽（同按鈕）\n#未結案 — 所有未結案卡片（有按鈕）\n#我的 — 我負責的案件\n#結案 — 從清單挑一件結案\n#結案 師傅名或廠商名 處理結果 — 直接結案\n#廠商 師傅名 正確廠商名 — 修正廠商\n#作廢 — 從清單挑一件作廢\n#設定館別 ○○館 — 在師傅群設定館別\n#設定採購群 — 在採購群設定\n#我是採購 名字 — 登記為採購')];
  }
  return [];
}

// ============================================================
//  #開單
// ============================================================
function venueLabel(chatId) {
  return cache.groups && cache.groups.venues ? cache.groups.venues[chatId] || '' : '';
}
async function openCase(ev, cmd, admin, ctx) {
  const vendors = await getVendors();
  const quotedId = ev.message && ev.message.quotedMessageId;
  let chef = null;
  let quoted = null;
  let tokens = [...cmd.tokens];

  if (quotedId) {
    const found = await findBufferedMessage(quotedId);
    if (found) {
      quoted = found.item;
      chef = await chefInfoByUserId(found.userId, found.item.chatId, found.item.chatType);
    }
  }

  // 找師傅：逐個 token 試（不限順序）
  let chefToken = null;
  if (!chef) {
    for (const t of tokens) {
      if (matchVendor(t, vendors)) continue; // 是廠商就跳過
      const c = await resolveChefByToken(t, ctx);
      if (c) { chef = c; chefToken = t; break; }
    }
  }
  if (!chef) {
    // 列出最近有傳訊息的人，方便採購照抄名稱
    const senders = await recentSenders(ctx.anyChat ? '' : ctx.chatId);
    const listTxt = senders.length
      ? '\n\n最近有傳訊息的人（照抄名稱即可）：\n' + senders.slice(0, 8).map(r => `・${r.displayName || '(無名稱)'}（${r.chatType === 'user' ? '一對一' : (venueLabel(r.chatId) || '群組')} ${dateLabel(r.ts)}）`).join('\n')
      : '\n\n最近 3 天沒有任何師傅的訊息。';
    return [text('找不到師傅「' + (tokens[0] || '') + '」。' + listTxt)];
  }
  if (chefToken) tokens = tokens.filter(t => t !== chefToken);

  // 找廠商：逐個 token 試
  let vendorToken = null;
  for (const t of tokens) { if (matchVendor(t, vendors)) { vendorToken = t; break; } }
  if (!vendorToken && tokens.length) vendorToken = tokens[0]; // 都對不到：第一個當廠商（待確認）
  if (vendorToken) tokens = tokens.filter(t => t !== vendorToken);

  // 若有舊預覽，先丟掉
  if (lastDraftId && drafts.has(lastDraftId)) drafts.delete(lastDraftId);

  const draft = await buildDraft({ chef, vendorToken, descTokens: tokens, quoted, byAdmin: admin });
  if (!draft.description && !draft.photos.length) {
    drafts.delete(draft.id); lastDraftId = null;
    return [text(`${chef.name} 最近 3 天沒有可用的訊息或照片，請他再傳一次。`)];
  }
  return sendPreview(draft, ctx);
}

// 師傅打 NG 開頭：60 秒後把他最近的訊息做成預覽，送採購群
function scheduleNgDraft(userId, chatId, chatType) {
  if (ngTimers.has(userId)) clearTimeout(ngTimers.get(userId));
  ngTimers.set(userId, setTimeout(async () => {
    ngTimers.delete(userId);
    try {
      const g = await getGroups();
      if (!g.purchasingGroupId) return;
      const chef = await chefInfoByUserId(userId, chatId, chatType);
      const draft = await buildDraft({ chef, vendorToken: null, descTokens: [], quoted: null, byAdmin: null });
      // 描述去掉開頭的 NG 字樣
      draft.description = draft.description.replace(/^[\s「」【】\[\]（）()#＃]*[nNｎＮ][gGｇＧ]\s*商品?[\s，,：:、。]*/, '').trim();
      await safePush(g.purchasingGroupId, [text(`🔔 ${draft.venue || ''} ${chef.name} 師傅傳來 NG 反映，請確認：`), previewFlex(draft)]);
    } catch (e) { console.error('ng draft error', e); }
  }, NG_DEBOUNCE_MS));
}

async function closeCase(caseId, admin, result) {
  const { case: c } = await gas('closeCase', { caseId, adminName: admin['姓名'], result });
  const msg = text(`✅ 案件 ${caseId} 已結案\n廠商：${c['廠商']}\n處理結果：${result}`);
  const g = await getGroups();
  const src = c['來源'];
  if (src === '一對一' || !src) { if (c['師傅LINE ID']) await safePush(c['師傅LINE ID'], [msg]); }
  else if (g.venues[src]) await safePush(src, [msg]);
  return [text(`✅ 案件 ${caseId} 已結案｜${admin['姓名']}\n處理結果：${result}`)];
}

// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('bot v2 listening on', PORT));
