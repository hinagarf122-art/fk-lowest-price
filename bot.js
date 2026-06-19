require('dotenv').config();
const express     = require('express');
const axios       = require('axios');
const cheerio     = require('cheerio');
const TelegramBot = require('node-telegram-bot-api');
const fs          = require('fs');
const https       = require('https');
const http        = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN     = process.env.BOT_TOKEN     || '8805762974:AAF1MiTNy9HffCv1AXDGP2QIHWSxlmrW1RU'; 
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '7485181331';
const PORT          = process.env.PORT          || 10000;
const RENDER_URL    = process.env.RENDER_URL    || `https://fk-stock-final.onrender.com`;
const CHECK_MS      = 15000;
const MAX_PRODUCTS  = 25;

// ─── DATA ─────────────────────────────────────────────────────────────────────
const DATA_FILE = './data.json';
function loadDB() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
  return { products: [], approvedUsers: [], pendingUsers: [], isChecking: true };
}
function saveDB() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) {} }
let db = loadDB();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
async function tg(chatId, text, extra = {}) {
  try { return await bot.sendMessage(String(chatId), text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra }); }
  catch (e) { console.error('[TG]', e.message); }
}
function isAdmin(id)    { return String(id) === String(ADMIN_CHAT_ID); }
function isApproved(id) { return isAdmin(id) || db.approvedUsers.includes(String(id)); }
function fmt(n)          { return n ? Number(n).toLocaleString('en-IN') : 'N/A'; }

// ─── BOT COMMANDS ─────────────────────────────────────────────────────────────
bot.onText(/\/start/, async msg => {
  const cid = String(msg.chat.id), name = msg.from.first_name || 'User';
  if (isApproved(cid)) return tg(cid,
    `🛒 <b>Flipkart Price Alert Bot</b>\n\n👋 Welcome <b>${name}</b>!\n\n` +
    `📌 <b>Commands:</b>\n/addproduct &lt;url&gt; — Track product\n/list — All products\n/remove &lt;id&gt; — Remove\n/status — Bot status` +
    (isAdmin(cid) ? `\n\n🔑 <b>Admin:</b>\n/approve &lt;id&gt;\n/deny &lt;id&gt;\n/removeuser &lt;id&gt;\n/users` : '')
  );
  if (!db.pendingUsers.includes(cid)) {
    db.pendingUsers.push(cid); saveDB();
    tg(ADMIN_CHAT_ID, `🔔 <b>New Request</b>\n👤 <b>${name}</b>\n🆔 <code>${cid}</code>\n\n/approve ${cid}\n/deny ${cid}`);
  }
  tg(cid, `👋 Hi <b>${name}</b>!\n⏳ Access request sent.\nYour ID: <code>${cid}</code>`);
});

bot.onText(/\/approve (.+)/, async (msg, m) => {
  if (!isAdmin(msg.chat.id)) return;
  const uid = String(m[1].trim());
  if (!db.approvedUsers.includes(uid)) {
    db.approvedUsers.push(uid); db.pendingUsers = db.pendingUsers.filter(u => u !== uid); saveDB();
    tg(ADMIN_CHAT_ID, `✅ <code>${uid}</code> approved!`);
    tg(uid, `✅ <b>Access Granted!</b> Send /start`);
  } else tg(ADMIN_CHAT_ID, `ℹ️ Already approved.`);
});

bot.onText(/\/deny (.+)/, async (msg, m) => {
  if (!isAdmin(msg.chat.id)) return;
  const uid = String(m[1].trim());
  db.pendingUsers = db.pendingUsers.filter(u => u !== uid); saveDB();
  tg(ADMIN_CHAT_ID, `❌ <code>${uid}</code> denied.`); tg(uid, `❌ Access denied.`);
});

bot.onText(/\/removeuser (.+)/, async (msg, m) => {
  if (!isAdmin(msg.chat.id)) return;
  const uid = String(m[1].trim());
  db.approvedUsers = db.approvedUsers.filter(u => u !== uid); saveDB();
  tg(ADMIN_CHAT_ID, `🗑 <code>${uid}</code> removed.`);
});

bot.onText(/\/users/, async msg => {
  if (!isAdmin(msg.chat.id)) return;
  const a = db.approvedUsers.length ? db.approvedUsers.map(u => `✅ <code>${u}</code>`).join('\n') : 'None';
  const p = db.pendingUsers.length  ? db.pendingUsers.map(u => `⏳ <code>${u}</code>`).join('\n')  : 'None';
  tg(ADMIN_CHAT_ID, `👥 <b>Users</b>\n\n<b>Approved:</b>\n${a}\n\n<b>Pending:</b>\n${p}`);
});

bot.onText(/\/addproduct (.+)/, async (msg, m) => {
  const cid = String(msg.chat.id);
  if (!isApproved(cid)) return tg(cid, '⛔ Access denied. Send /start');
  let url = m[1].trim();
  if (!url.includes('flipkart.com')) return tg(cid, '❌ Only Flipkart links supported!');
  if (db.products.length >= MAX_PRODUCTS) return tg(cid, `❌ Max ${MAX_PRODUCTS} limit reached!`);
  if (db.products.find(p => p.url === url)) return tg(cid, '⚠️ Already tracking this!');
  await tg(cid, '⏳ Fetching live price...');
  url = await resolveUrl(url);
  const info = await scrapeFK(url);
  if (!info) return tg(cid, '❌ Could not fetch price. Make sure it\'s a valid Flipkart product page link.');
  const product = { id: Date.now(), url, name: info.name, price: info.price, lowestPrice: info.lowestPrice, effectivePrice: info.effectivePrice, lastChecked: new Date().toISOString(), addedBy: cid };
  db.products.push(product); saveDB();
  tg(cid,
    `✅ <b>Product Added!</b>\n\n📦 <b>${info.name}</b>\n\n` +
    `${info.effectivePrice !== info.price ? '🎯 <b>Best Price (with Bank Offer):</b> ₹' + fmt(info.effectivePrice) + '\n' : ''}` +
    `💰 <b>Price to Buy:</b> ₹${fmt(info.price)}\n` +
    `🏷 <b>Lowest Price for You:</b> ₹${fmt(info.lowestPrice)}\n\n` +
    `🔔 Price alert is ON! (tracks lowest available)\n🆔 <code>${product.id}</code>`
  );
});

bot.onText(/\/list/, async msg => {
  const cid = String(msg.chat.id);
  if (!isApproved(cid)) return tg(cid, '⛔ Access denied.');
  if (!db.products.length) return tg(cid, '📭 No products. Use /addproduct &lt;url&gt;');
  let txt = `📋 <b>Tracked (${db.products.length}/${MAX_PRODUCTS})</b>\n\n`;
  db.products.forEach((p, i) => {
    txt += `${i+1}. <b>${p.name.slice(0, 45)}</b>\n   💰 ₹${fmt(p.price)}  🏷 ₹${fmt(p.lowestPrice)}\n   🆔 <code>${p.id}</code>\n   ❌ <b>Stop tracking:</b> /remove_${p.id}\n\n`;
  });
  tg(cid, txt);
});

bot.onText(/\/remove(?:_)?(.+)/, async (msg, m) => {
  const cid = String(msg.chat.id);
  if (!isApproved(cid)) return tg(cid, '⛔ Access denied.');
  const targetId = m[1].trim();
  const idx = db.products.findIndex(p => String(p.id) === targetId);
  if (idx === -1) return tg(cid, '❌ Not found. Use /list');
  const [r] = db.products.splice(idx, 1); saveDB();
  tg(cid, `🗑 Removed: <b>${r.name.slice(0, 50)}</b>`);
});

bot.onText(/\/status/, async msg => {
  const cid = String(msg.chat.id);
  if (!isApproved(cid)) return tg(cid, '⛔ Access denied.');
  tg(cid,
    `📊 <b>Status</b>\n\n🔄 ${db.isChecking ? '✅ Checking Active' : '❌ Stopped'}\n` +
    `📦 Products: ${db.products.length}/${MAX_PRODUCTS}\n👥 Users: ${db.approvedUsers.length}\n⏱ Interval: 15s\n🕐 ${new Date().toLocaleString('en-IN')}`
  );
});

// ─── URL RESOLVER ─────────────────────────────────────────────────────────────
async function resolveUrl(url) {
  if (!url.includes('dl.flipkart.com') && !url.includes('fkrt.it')) return url;
  console.log('[Resolver] Resolving deep link:', url.slice(0, 70));
  try {
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
      maxRedirects: 10, timeout: 15000, validateStatus: s => s < 400,
    });
    const finalUrl = resp.request?.res?.responseUrl || resp.config?.url || url;
    if (finalUrl && finalUrl.includes('flipkart.com') && !finalUrl.includes('dl.flipkart.com')) {
      try {
        const u = new URL(finalUrl);
        const clean = `${u.origin}${u.pathname}`;
        console.log('[Resolver] ✅ Resolved to:', clean.slice(0, 70));
        return clean;
      } catch { return finalUrl; }
    }
  } catch (e) { console.log('[Resolver] Error:', e.message); }
  try {
    const u = new URL(url);
    const slug = u.pathname.replace(/^\/dl\//, '');
    if (slug && slug.length > 3) {
      const fallback = `https://www.flipkart.com/${slug}`;
      console.log('[Resolver] Fallback URL:', fallback.slice(0, 70));
      return fallback;
    }
  } catch (e) {}
  return url;
}

// ─── SCRAPER CORE ─────────────────────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
];
let uaIndex = 0;
function nextUA() { const ua = USER_AGENTS[uaIndex % USER_AGENTS.length]; uaIndex++; return ua; }

function parsePrice(str) {
  if (!str) return null;
  const nums = str.replace(/[,\s]/g, '').match(/\d{3,6}/g);
  if (!nums) return null;
  const valid = nums.map(Number).filter(n => n >= 500 && n <= 500000);
  return valid.length ? Math.max(...valid) : null;
}

async function scrapeFK(url) {
  if (!url.includes('www.flipkart.com')) url = url.replace('flipkart.com', 'www.flipkart.com');

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[Scraper] Attempt ${attempt}: ${url.slice(0, 65)}`);

      const resp = await axios.get(url, {
        headers: {
          'User-Agent': nextUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Upgrade-Insecure-Requests': '1',
          'Cookie': 'pincode=125121; sn=125121; amsn=125121;' 
        },
        timeout: 15000, 
        maxRedirects: 5,
        validateStatus: function (status) { return status >= 200 && status < 300; }
      });

      const html = resp.data.toString();
      const $    = cheerio.load(html);

      let name = '';
      for (const s of ['span.VU-ZEz', 'span.B_NuCI', '._35KyD6', 'h1 span', '.yhB1nd', 'title']) {
        const t = s === 'title'
          ? $('title').text().split('|')[0].split('-')[0].trim()
          : $(s).first().text().trim();
        if (t && t.length > 4) { name = t; break; }
      }
      if (!name) name = 'Flipkart Product';

      let price       = null;
      let lowestPrice = null;

      const ppdMatch = html.match(/"ppd"\s*:\s*(\{[^}]+\})/);
      if (ppdMatch) {
        try {
          const ppd = JSON.parse(ppdMatch[1]);
          if (ppd.finalPrice && ppd.finalPrice > 100) price       = ppd.finalPrice;
          if (ppd.nepPrice   && ppd.nepPrice   > 100) lowestPrice = ppd.nepPrice;
          console.log(`[Scraper] ✅ ppd JSON → Price:₹${price}  LowestForYou:₹${lowestPrice}  MRP:₹${ppd.mrp}`);
        } catch (e) {
          console.log('[Scraper] ppd parse error:', e.message);
        }
      }

      if (!lowestPrice) {
        const nepMatch = html.match(/"nepPrice"\s*:\s*(\d+)/);
        if (nepMatch) {
          const p = parseInt(nepMatch[1]);
          if (p > 100) { lowestPrice = p; console.log(`[Scraper] ✅ nepPrice regex → LowestForYou:₹${p}`); }
        }
      }

      if (!price) {
        const fpMatch = html.match(/"finalPrice"\s*:\s*(\d+)/);
        if (fpMatch) {
          const p = parseInt(fpMatch[1]);
          if (p > 100) { price = p; console.log(`[Scraper] ✅ finalPrice regex → Price:₹${p}`); }
        }
      }

      if (!price) {
        for (const s of ['div.Nx9bqj.CxhGGd', 'div.Nx9bqj', '.CEmiEU .Nx9bqj', '._30jeq3._16Jk6d', '._16Jk6d']) {
          const t = $(s).first().text().trim();
          const p = parsePrice(t);
          if (p && p > 100) { price = p; console.log(`[Scraper] price via selector "${s}": ₹${p}`); break; }
        }
      }

      if (!lowestPrice) lowestPrice = price;
      const effectivePrice = Math.min(price, lowestPrice);

      if (!price) {
        console.log(`[Scraper] Attempt ${attempt}: no price found`);
        if (attempt < 3) { await sleep(3000); continue; }
        return null;
      }

      console.log(`[Scraper] ✅ "${name.slice(0, 35)}" | PriceToBuy:₹${price} | LowestForYou:₹${lowestPrice} | Effective:₹${effectivePrice}`);
      return { name, price, lowestPrice, effectivePrice };

    } catch (e) {
      console.error(`[Scraper] Attempt ${attempt} error: ${e.message}`);
      if (attempt < 3) await sleep(4000);
    }
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── PRICE CHECK LOOP ─────────────────────────────────────────────────────────
let checkTimer = null;
let isRunning  = false;

function startChecking() {
  if (checkTimer) return;
  db.isChecking = true; saveDB();
  checkTimer = setInterval(runCheck, CHECK_MS);
  console.log('✅ Price check loop: ON (15s)');
  setTimeout(runCheck, 2000);
}
function stopChecking() {
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
  db.isChecking = false; saveDB();
  console.log('⏹ Price check loop: OFF');
}

async function runCheck() {
  if (isRunning || !db.products.length) return;
  isRunning = true;
  console.log(`[${new Date().toLocaleTimeString('en-IN')}] Checking ${db.products.length} product(s)...`);
  
  for (const p of db.products) {
    try {
      const info = await scrapeFK(p.url);
      if (!info || !info.price) { console.log(`[Check] ⚠️  No data: ${p.name.slice(0, 30)}`); continue; }

      const prevEff = p.effectivePrice || p.lowestPrice || p.price;
      const newEff  = info.effectivePrice;
      const pc = info.price       !== p.price;
      const lc = info.lowestPrice !== p.lowestPrice;
      const ec = newEff            !== prevEff;

      p.lastChecked = new Date().toISOString();

      if (pc || lc || ec) {
        let msg = `🚨 <b>PRICE ALERT!</b>\n\n📦 <b>${p.name.slice(0, 60)}</b>\n\n`;
        if (ec) {
          const d = newEff - prevEff;
          msg += `${d < 0 ? '🎉📉' : '📈'} <b>Best Price for You:</b>\n  Was: ₹${fmt(prevEff)}\n  Now: ₹${fmt(newEff)}\n  <b>${d < 0 ? '▼ DROPPED ₹' : '▲ UP ₹'}${fmt(Math.abs(d))}</b>\n\n`;
          p.effectivePrice = newEff;
        }
        if (pc) p.price = info.price;
        if (lc) p.lowestPrice = info.lowestPrice;
        
        msg += `\n🔗 <a href="${p.url}">View on Flipkart</a>\n⏰ ${new Date().toLocaleString('en-IN')}`;
        saveDB();
        const targets = [...new Set([ADMIN_CHAT_ID, ...db.approvedUsers])];
        for (const uid of targets) await tg(uid, msg);
        console.log(`[Alert] 🔔 Sent: ${p.name.slice(0, 30)}`);
      } else {
        console.log(`[Check] ✅ No change: ${p.name.slice(0, 30)} | Buy:₹${info.price} | LowestForYou:₹${info.lowestPrice}`);
        saveDB(); 
      }
    } catch (e) { console.error('[Check] Error:', e.message); }
  }
  isRunning = false;
}

setTimeout(startChecking, 3000);

// ─── KEEP-ALIVE ───────────────────────────────────────────────────────────────
setInterval(() => {
  const u = `${RENDER_URL}/ping`;
  try {
    const mod = u.startsWith('https') ? https : http;
    const r = mod.get(u, () => {}); r.on('error', () => {}); r.setTimeout(5000, () => r.destroy());
  } catch (e) {}
}, 25000);

// ─── WEB PANEL LAYOUT ────────────────────────────────────────────────────────
const PANEL = '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n' +
'<title>Flipkart Price Alert</title>\n' +
'<style>\n' +
'*{margin:0;padding:0;box-sizing:border-box}\n' +
':root{--bg:#07090f;--card:#0d1117;--b:#1e2a3a;--acc:#2563eb;--grn:#10b981;--red:#ef4444;--amb:#f59e0b;--tx:#e2e8f0;--mu:#64748b;--fi:#111827}\n' +
'body{background:var(--bg);color:var(--tx);font-family:\'Segoe UI\',system-ui,sans-serif;min-height:100vh}\n' +
'nav{background:linear-gradient(90deg,#0f2460,#1e40af 60%,#2563eb);height:60px;display:flex;align-items:center;justify-content:space-between;padding:0 28px;box-shadow:0 2px 20px rgba(37,99,235,.5);position:sticky;top:0;z-index:100}\n' +
'.brand{display:flex;align-items:center;gap:10px}\n' +
'.brand h1{font-size:17px;font-weight:700;color:#fff}\n' +
'.brand small{color:#93c5fd;font-size:11px}\n' +
'.pill{display:flex;align-items:center;gap:7px;background:rgba(0,0,0,.35);padding:5px 14px;border-radius:20px;font-size:12px;color:#e2e8f0}\n' +
'.dot{width:8px;height:8px;border-radius:50%}\n' +
'.dot.on{background:#10b981;box-shadow:0 0 0 3px rgba(16,185,129,.25);animation:blink 1.8s infinite}\n' +
'.dot.off{background:#4b5563}\n' +
'@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}\n' +
'.wrap{max-width:1380px;margin:0 auto;padding:20px}\n' +
'.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}\n' +
'@media(max-width:750px){.stats{grid-template-columns:repeat(2,1fr)}}\n' +
'.sc{background:var(--card);border:1px solid var(--b);border-radius:10px;padding:16px 20px;display:flex;align-items:center;gap:14px;transition:.2s}\n' +
'.sc:hover{border-color:#2563eb55;transform:translateY(-2px)}\n' +
'.si{font-size:30px}\n' +
'.sv{font-size:26px;font-weight:800;line-height:1}\n' +
'.sl{font-size:11px;color:var(--mu);margin-top:3px}\n' +
'.row2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}\n' +
'@media(max-width:800px){.row2{grid-template-columns:1fr}}\n' +
'.card{background:var(--card);border:1px solid var(--b);border-radius:12px;overflow:hidden}\n' +
'.ch{padding:14px 18px;border-bottom:1px solid var(--b);display:flex;align-items:center;justify-content:space-between;background:rgba(37,99,235,.04)}\n' +
'.ch h2{font-size:14px;font-weight:600}\n' +
'.cb{padding:18px}\n' +
'.irow{display:flex;gap:8px;margin-bottom:12px}\n' +
'input[type=url]{flex:1;background:var(--fi);border:1px solid var(--b);border-radius:8px;padding:9px 13px;color:var(--tx);font-size:13px;outline:none;transition:.2s}\n' +
'input[type=url]:focus{border-color:var(--acc)}\n' +
'input[type=url]::placeholder{color:var(--mu)}\n' +
'.btn{padding:9px 18px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;transition:.15s;white-space:nowrap}\n' +
'.btn:active{transform:scale(.96)}\n' +
'.ba{background:var(--acc);color:#fff}.ba:hover{background:#1d4ed8}\n' +
'.btn.bg{background:var(--grn);color:#fff}.bg:hover{background:#059669}\n' +
'.br{background:var(--red);color:#fff}.br:hover{background:#dc2626}\n' +
'.bam{background:var(--amb);color:#fff}.bam:hover{background:#d97706}\n' +
'.bsm{padding:5px 11px;font-size:11px;border-radius:6px}\n' +
'.bgh{background:var(--fi);color:var(--mu);border:1px solid var(--b)}\n' +
'.ctrlrow{display:flex;gap:8px;flex-wrap:wrap;padding-top:14px;border-top:1px solid var(--b);margin-top:14px}\n' +
'.log{background:#040710;border:1px solid var(--b);border-radius:8px;height:260px;overflow-y:auto;padding:10px 12px;font-family:\'Courier New\',monospace;font-size:11.5px;line-height:1.7}\n' +
'.li{color:#60a5fa}.ls{color:#34d399}.lw{color:#fbbf24}.le{color:#f87171}\n' +
'.plist{display:flex;flex-direction:column;gap:10px}\n' +
'.pc{background:var(--fi);border:1px solid var(--b);border-radius:10px;padding:14px 16px;display:flex;align-items:center;gap:14px;transition:.2s}\n' +
'.pc:hover{border-color:#2563eb33;transform:translateX(2px)}\n' +
'.pn{width:30px;height:30px;border-radius:50%;background:var(--acc);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0}\n' +
'.pi{flex:1;min-width:0}\n' +
'.pname{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n' +
'.ptags{display:flex;gap:10px;margin-top:5px;flex-wrap:wrap}\n' +
'.tag{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:20px;font-size:12px;font-weight:500}\n' +
'.tb{background:rgba(37,99,235,.12);color:#93c5fd;border:1px solid rgba(37,99,235,.2)}\n' +
'.tg{background:rgba(16,185,129,.12);color:#6ee7b7;border:1px solid rgba(16,185,129,.2)}\n' +
'.pt定位{font-size:10px;color:var(--mu);margin-top:4px}\n' +
'.empty{text-align:center;padding:40px 20px;color:var(--mu)}\n' +
'.ei{font-size:44px;margin-bottom:10px}\n' +
'.toast{position:fixed;bottom:20px;right:20px;background:#1e293b;border:1px solid var(--b);border-radius:10px;padding:12px 18px;box-shadow:0 8px 28px rgba(0,0,0,.5);font-size:13px;z-index:9999;opacity:0;transform:translateY(20px);transition:.3s;pointer-events:none;max-width:300px}\n' +
'.toast.show{opacity:1;transform:translateY(0)}\n' +
'.tok{border-left:3px solid #10b981}.terr{border-left:3px solid #ef4444}\n' +
'.tip{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);border-radius:8px;padding:10px 14px;font-size:12px;color:#fbbf24;margin-bottom:12px}\n' +
'::-webkit-scrollbar{width:5px}::-webkit-scrollbar-thumb{background:#1e2a3a;border-radius:3px}\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'<nav>\n' +
'  <div class="brand">\n' +
'    <span style="font-size:24px">&#128722;</span>\n' +
'    <div><h1>Flipkart Price Alert Bot</h1><small>ppd-JSON &middot; 15s interval &middot; 24/7</small></div>\n' +
'  </div>\n' +
'  <div class="pill"><div class="dot" id="sdot"></div><span id="stxt">Loading&hellip;</span></div>\n
