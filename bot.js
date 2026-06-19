require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const https = require('https');
const http = require('http');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const BOT_TOKEN     = process.env.BOT_TOKEN     || '8805762974:AAElbRkMFLtdsFf8Xt88ASnTCSCjyl-DHh4';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '7485181331';
const PORT          = process.env.PORT          || 3000;
const RENDER_URL    = process.env.RENDER_URL    || `http://localhost:${PORT}`;
const CHECK_MS      = 15000;
const MAX_PRODUCTS  = 25;

// ─── DATA ──────────────────────────────────────────────────────────────────────
const DATA_FILE = './data.json';
function loadDB() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }
  catch(e){}
  return { products:[], approvedUsers:[], pendingUsers:[], isChecking:false };
}
function saveDB() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db,null,2)); } catch(e){} }
let db = loadDB();

// ─── EXPRESS ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended:true }));

// ─── TELEGRAM ──────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling:true });

async function tg(chatId, text, extra={}) {
  try { return await bot.sendMessage(String(chatId), text, { parse_mode:'HTML', disable_web_page_preview:true, ...extra }); }
  catch(e) { console.error('[TG]', e.message); }
}

function isAdmin(id) { return String(id) === String(ADMIN_CHAT_ID); }
function isApproved(id) { return isAdmin(id) || db.approvedUsers.includes(String(id)); }
function fmt(n) { return n ? n.toLocaleString('en-IN') : 'N/A'; }

// ──────────────────────────── COMMANDS ────────────────────────────────────────

bot.onText(/\/start/, async msg => {
  const cid  = String(msg.chat.id);
  const name = msg.from.first_name || 'User';
  if (isApproved(cid)) {
    return tg(cid,
      `🛒 <b>Flipkart Price Alert Bot</b>\n\n`+
      `👋 Welcome <b>${name}</b>!\n\n`+
      `<b>Commands:</b>\n`+
      `/addproduct &lt;url&gt; — Track a product\n`+
      `/list — View tracked products\n`+
      `/remove &lt;id&gt; — Remove product\n`+
      `/status — Bot status\n`+
      (isAdmin(cid)?`\n🔑 <b>Admin:</b>\n/approve &lt;id&gt;\n/deny &lt;id&gt;\n/removeuser &lt;id&gt;\n/users`:'')
    );
  }
  if (!db.pendingUsers.includes(cid)) {
    db.pendingUsers.push(cid); saveDB();
    tg(ADMIN_CHAT_ID,
      `🔔 <b>New Access Request</b>\n\n`+
      `👤 <b>${name}</b>\n`+
      `🆔 Chat ID: <code>${cid}</code>\n`+
      `@${msg.from.username||'no_username'}\n\n`+
      `✅ /approve ${cid}\n❌ /deny ${cid}`
    );
  }
  tg(cid, `👋 Hi <b>${name}</b>!\n\n⏳ Access request sent to admin.\nYour ID: <code>${cid}</code>`);
});

bot.onText(/\/approve (.+)/, async (msg,m) => {
  if (!isAdmin(msg.chat.id)) return;
  const uid = String(m[1].trim());
  if (!db.approvedUsers.includes(uid)) {
    db.approvedUsers.push(uid);
    db.pendingUsers = db.pendingUsers.filter(u=>u!==uid);
    saveDB();
    tg(ADMIN_CHAT_ID, `✅ User <code>${uid}</code> approved!`);
    tg(uid, `✅ <b>Access Granted!</b>\nSend /start to begin.`);
  } else tg(ADMIN_CHAT_ID, `ℹ️ Already approved.`);
});

bot.onText(/\/deny (.+)/, async (msg,m) => {
  if (!isAdmin(msg.chat.id)) return;
  const uid = String(m[1].trim());
  db.pendingUsers = db.pendingUsers.filter(u=>u!==uid); saveDB();
  tg(ADMIN_CHAT_ID, `❌ User <code>${uid}</code> denied.`);
  tg(uid, `❌ Your access request was denied.`);
});

bot.onText(/\/removeuser (.+)/, async (msg,m) => {
  if (!isAdmin(msg.chat.id)) return;
  const uid = String(m[1].trim());
  db.approvedUsers = db.approvedUsers.filter(u=>u!==uid); saveDB();
  tg(ADMIN_CHAT_ID, `🗑 User <code>${uid}</code> removed.`);
});

bot.onText(/\/users/, async msg => {
  if (!isAdmin(msg.chat.id)) return;
  const a = db.approvedUsers.length ? db.approvedUsers.map(u=>`✅ <code>${u}</code>`).join('\n') : 'None';
  const p = db.pendingUsers.length  ? db.pendingUsers.map(u=>`⏳ <code>${u}</code>`).join('\n')  : 'None';
  tg(ADMIN_CHAT_ID, `👥 <b>Users</b>\n\n<b>Approved:</b>\n${a}\n\n<b>Pending:</b>\n${p}`);
});

bot.onText(/\/addproduct (.+)/, async (msg,m) => {
  const cid = String(msg.chat.id);
  if (!isApproved(cid)) return tg(cid,'⛔ Access denied. Send /start');
  const url = m[1].trim();
  if (!url.includes('flipkart.com')) return tg(cid,'❌ Only Flipkart links supported!');
  if (db.products.length >= MAX_PRODUCTS) return tg(cid,`❌ Max ${MAX_PRODUCTS} products limit reached!`);
  if (db.products.find(p=>p.url===url)) return tg(cid,'⚠️ Already tracking this product!');
  const wait = await tg(cid,'⏳ Fetching live price from Flipkart...');
  const info = await scrapeFlipkart(url);
  if (!info) return tg(cid,'❌ Could not fetch product. Check URL or try again.');
  const product = { id:Date.now(), url, name:info.name, price:info.price, lowestPrice:info.lowestPrice, lastChecked:new Date().toISOString(), addedBy:cid };
  db.products.push(product); saveDB();
  tg(cid,
    `✅ <b>Product Added!</b>\n\n`+
    `📦 <b>${info.name}</b>\n\n`+
    `💰 <b>Price to Buy:</b> ₹${fmt(info.price)}\n`+
    `🏷 <b>Lowest Price for You:</b> ₹${fmt(info.lowestPrice)}\n\n`+
    `🔔 Price change alerts are ON!\n`+
    `🆔 ID: <code>${product.id}</code>`
  );
});

bot.onText(/\/list/, async msg => {
  const cid = String(msg.chat.id);
  if (!isApproved(cid)) return tg(cid,'⛔ Access denied.');
  if (!db.products.length) return tg(cid,'📭 No products tracked.\nUse /addproduct &lt;url&gt;');
  let txt = `📋 <b>Tracked Products (${db.products.length}/${MAX_PRODUCTS})</b>\n\n`;
  db.products.forEach((p,i)=>{
    txt+=`${i+1}. <b>${p.name.slice(0,45)}</b>\n   💰 ₹${fmt(p.price)}  |  🏷 ₹${fmt(p.lowestPrice)}\n   🆔 <code>${p.id}</code>\n\n`;
  });
  tg(cid,txt);
});

bot.onText(/\/remove (.+)/, async (msg,m) => {
  const cid = String(msg.chat.id);
  if (!isApproved(cid)) return tg(cid,'⛔ Access denied.');
  const idx = db.products.findIndex(p=>String(p.id)===m[1].trim());
  if (idx===-1) return tg(cid,'❌ Not found. Use /list for IDs.');
  const [removed] = db.products.splice(idx,1); saveDB();
  tg(cid,`🗑 Removed: <b>${removed.name.slice(0,50)}</b>`);
});

bot.onText(/\/status/, async msg => {
  const cid = String(msg.chat.id);
  if (!isApproved(cid)) return tg(cid,'⛔ Access denied.');
  tg(cid,
    `📊 <b>Bot Status</b>\n\n`+
    `🔄 Checking: ${db.isChecking?'✅ Active (every 15s)':'❌ Stopped'}\n`+
    `📦 Products: ${db.products.length}/${MAX_PRODUCTS}\n`+
    `👥 Approved Users: ${db.approvedUsers.length}\n`+
    `⏱ Interval: 15 seconds\n`+
    `🕐 Server Time: ${new Date().toLocaleString('en-IN')}`
  );
});

// ─── PUPPETEER SCRAPER ─────────────────────────────────────────────────────────
let browserInst = null;

async function getBrowser() {
  if (browserInst) {
    try { const pages = await browserInst.pages(); if (pages) return browserInst; }
    catch(e) { browserInst = null; }
  }
  console.log('[Browser] Launching Puppeteer...');
  browserInst = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox','--disable-setuid-sandbox',
      '--disable-dev-shm-usage','--disable-accelerated-2d-canvas',
      '--no-first-run','--no-zygote','--single-process',
      '--disable-gpu','--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
  browserInst.on('disconnected', () => { browserInst = null; });
  return browserInst;
}

async function scrapeFlipkart(url) {
  let page = null;
  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const br = await getBrowser();
      page = await br.newPage();

      // Block unnecessary resources for speed
      await page.setRequestInterception(true);
      page.on('request', req => {
        const t = req.resourceType();
        if (['image','media','font','stylesheet'].includes(t)) req.abort();
        else req.continue();
      });

      await page.setViewport({ width:1366, height:768 });
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      await page.setExtraHTTPHeaders({
        'Accept-Language':'en-IN,en;q=0.9,hi;q=0.8',
        'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      });

      // Set page zoom 90%
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(document, 'readyState', { get: () => 'complete' });
      });

      await page.goto(url, { waitUntil:'networkidle2', timeout:35000 });

      // Wait a bit for JS to render prices
      await new Promise(r => setTimeout(r, 2500));

      // Set zoom via CSS
      await page.evaluate(() => { document.body.style.zoom = '90%'; });

      const result = await page.evaluate(() => {
        function parseRs(str) {
          if (!str) return null;
          const cleaned = str.replace(/[₹,\s]/g,'');
          const m = cleaned.match(/(\d{4,6})/);
          return m ? parseInt(m[1]) : null;
        }

        // ── Product Name ──────────────────────────────────────
        const nameSelectors = [
          'span.VU-ZEz','span.B_NuCI','h1._9E25nV span',
          'h1 span','[class*="productName"]','[class*="title"] h1',
          '.yhB1nd','._35KyD6',
        ];
        let name = '';
        for (const s of nameSelectors) {
          const el = document.querySelector(s);
          if (el && el.innerText && el.innerText.length > 5) { name = el.innerText.trim(); break; }
        }
        if (!name) name = document.title.split('|')[0].split('-')[0].trim();

        // ── Main Price (Price to Buy) ─────────────────────────
        const priceSelectors = [
          // 2024-2025 Flipkart selectors
          'div.Nx9bqj.CxhGGd',
          'div.Nx9bqj',
          '._30jeq3._16Jk6d',
          '._16Jk6d',
          '.CEmiEU .Nx9bqj',
          '._25b18c ._30jeq3',
          '[class*="finalPrice"]',
          '._3I9_wc._2p6lqe',
          '.fhExFL > div',
        ];
        let priceVal = null;
        let priceRaw = '';
        for (const s of priceSelectors) {
          const el = document.querySelector(s);
          if (el) {
            const txt = el.innerText.trim();
            const p = parseRs(txt);
            if (p && p > 100) { priceVal = p; priceRaw = txt; break; }
          }
        }

        // ── Lowest Price For You ──────────────────────────────
        const lowestSelectors = [
          '.yRaY8j.ZYYwLA',
          '.yRaY8j',
          '._3qQ9m1',
          '.PCWT0u',
          '[class*="lowestPrice"]',
          '[class*="lowest"]',
          '.LFwuGS',
        ];
        let lowestVal = null;
        let lowestRaw = '';
        for (const s of lowestSelectors) {
          const el = document.querySelector(s);
          if (el) {
            const txt = el.innerText.trim();
            const p = parseRs(txt);
            if (p && p > 100) { lowestVal = p; lowestRaw = txt; break; }
          }
        }

        // ── Fallback: scan all price-looking elements ─────────
        if (!priceVal) {
          const allEls = document.querySelectorAll('[class*="price"],[class*="Price"]');
          for (const el of allEls) {
            const txt = el.innerText.trim();
            if (txt.includes('₹')) {
              const p = parseRs(txt);
              if (p && p > 1000 && p < 500000) { priceVal = p; priceRaw = txt; break; }
            }
          }
        }

        // ── Bank Offer / Lowest Price Fallback ────────────────
        if (!lowestVal) {
          // Look for "lowest price for you" text nearby
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while (node = walker.nextNode()) {
            if (node.textContent.toLowerCase().includes('lowest price')) {
              // Find nearby price
              const parent = node.parentElement;
              if (parent) {
                const nearby = parent.closest('[class]');
                if (nearby) {
                  const ps = nearby.querySelectorAll('[class*="price"],[class*="Price"]');
                  for (const p of ps) {
                    const v = parseRs(p.innerText);
                    if (v && v > 100) { lowestVal = v; lowestRaw = p.innerText; break; }
                  }
                }
              }
              if (lowestVal) break;
            }
          }
        }

        // If still no lowest price, look for bank offer price
        if (!lowestVal && priceVal) {
          const offerTexts = document.querySelectorAll('._3xFhiH,._2AfrYn,.OtOsyX,._3BNbOM,[class*="offer"],[class*="Offer"]');
          for (const el of offerTexts) {
            const txt = el.innerText;
            if (txt.includes('₹') && (txt.toLowerCase().includes('bank') || txt.toLowerCase().includes('offer'))) {
              const matches = txt.replace(/,/g,'').match(/₹(\d{4,6})/g);
              if (matches) {
                for (const m of matches) {
                  const v = parseInt(m.replace(/[₹,]/g,''));
                  if (v && v < priceVal && v > 1000) { lowestVal = v; break; }
                }
              }
            }
          }
        }

        if (!lowestVal) lowestVal = priceVal; // fallback same as price

        return { name, price:priceVal, lowestPrice:lowestVal, priceRaw, lowestRaw };
      });

      await page.close(); page = null;

      if (!result.price) {
        console.log(`[Scraper] Attempt ${attempt}: no price found for ${url}`);
        if (attempt < MAX_RETRIES) { await new Promise(r=>setTimeout(r,3000)); continue; }
        return null;
      }

      console.log(`[Scraper] ✅ ${result.name.slice(0,40)} | ₹${result.price} | Lowest: ₹${result.lowestPrice}`);
      return result;

    } catch(e) {
      console.error(`[Scraper] Attempt ${attempt} error:`, e.message);
      if (page) { try { await page.close(); } catch{} page = null; }
      if (e.message.includes('browser') || e.message.includes('Target')) browserInst = null;
      if (attempt < MAX_RETRIES) await new Promise(r=>setTimeout(r,3000));
    }
  }
  return null;
}

// ─── PRICE CHECK LOOP ──────────────────────────────────────────────────────────
let checkTimer  = null;
let isRunning   = false; // prevent overlap

function startChecking() {
  if (checkTimer) return;
  db.isChecking = true; saveDB();
  checkTimer = setInterval(runCheck, CHECK_MS);
  console.log('✅ Price check loop started (every 15s)');
  runCheck(); // immediate first run
}

function stopChecking() {
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
  db.isChecking = false; saveDB();
  console.log('⏹ Price check loop stopped');
}

async function runCheck() {
  if (isRunning) { console.log('[Check] Skipping — previous run still active'); return; }
  if (!db.products.length) return;
  isRunning = true;
  const ts = new Date().toLocaleTimeString('en-IN');
  console.log(`[${ts}] Checking ${db.products.length} product(s)...`);

  for (const p of db.products) {
    try {
      const info = await scrapeFlipkart(p.url);
      if (!info || !info.price) {
        console.log(`[Check] ⚠️  No data for: ${p.name.slice(0,30)}`);
        continue;
      }

      const oldPrice  = p.price;
      const oldLowest = p.lowestPrice;
      const newPrice  = info.price;
      const newLowest = info.lowestPrice;

      p.lastChecked = new Date().toISOString();

      const priceChanged  = newPrice  !== oldPrice;
      const lowestChanged = newLowest !== oldLowest;

      if (priceChanged || lowestChanged) {
        p.price       = newPrice;
        p.lowestPrice = newLowest;
        saveDB();

        let msg = `🚨 <b>PRICE ALERT!</b>\n\n📦 <b>${p.name.slice(0,60)}</b>\n\n`;

        if (priceChanged) {
          const diff  = newPrice - oldPrice;
          const arrow = diff < 0 ? '📉 DROP' : '📈 RISE';
          msg += `${arrow} <b>Price to Buy:</b>\n`;
          msg += `  Old: ₹${fmt(oldPrice)}\n`;
          msg += `  New: ₹${fmt(newPrice)}\n`;
          msg += `  Change: <b>${diff<0?'':'+'}₹${fmt(Math.abs(diff))}</b>\n\n`;
        }

        if (lowestChanged) {
          const diff  = newLowest - oldLowest;
          const arrow = diff < 0 ? '💚 DROP' : '🔺 RISE';
          msg += `${arrow} <b>Lowest Price for You:</b>\n`;
          msg += `  Old: ₹${fmt(oldLowest)}\n`;
          msg += `  New: ₹${fmt(newLowest)}\n`;
          msg += `  Change: <b>${diff<0?'':'+'}₹${fmt(Math.abs(diff))}</b>\n\n`;
        }

        msg += `🔗 <a href="${p.url}">View on Flipkart</a>\n`;
        msg += `⏰ ${new Date().toLocaleString('en-IN')}`;

        const targets = [...new Set([ADMIN_CHAT_ID, ...db.approvedUsers])];
        for (const uid of targets) await tg(uid, msg);
        console.log(`[Alert] 🔔 Sent for: ${p.name.slice(0,30)}`);
      } else {
        console.log(`[Check] ✅ No change: ${p.name.slice(0,30)} ₹${newPrice}`);
        saveDB(); // update lastChecked
      }
    } catch(e) {
      console.error(`[Check] Error on ${p.id}:`, e.message);
    }
  }

  isRunning = false;
}

// Auto-resume if was checking before restart
if (db.isChecking) {
  console.log('[Boot] Resuming price check loop from saved state...');
  setTimeout(startChecking, 8000);
} else {
  // Start by default on fresh launch
  setTimeout(startChecking, 8000);
  db.isChecking = true; saveDB();
}

// ─── KEEP-ALIVE (prevents Render 30s freeze) ──────────────────────────────────
setInterval(() => {
  const target = RENDER_URL.includes('localhost')
    ? `http://localhost:${PORT}/ping`
    : `${RENDER_URL}/ping`;
  try {
    const mod = target.startsWith('https') ? https : http;
    const req = mod.get(target, () => {});
    req.on('error', () => {});
    req.setTimeout(5000, () => req.destroy());
  } catch(e) {}
}, 25000);

// ─── WEB PANEL HTML ───────────────────────────────────────────────────────────
const PANEL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flipkart Price Alert Bot</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#07090f;--card:#0d1117;--border:#1e2a3a;
  --accent:#2563eb;--green:#10b981;--red:#ef4444;--orange:#f59e0b;
  --text:#e2e8f0;--muted:#64748b;--faint:#1a2332;
}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh}

nav{
  background:linear-gradient(90deg,#0f2460 0%,#1e40af 60%,#2563eb 100%);
  height:60px;display:flex;align-items:center;justify-content:space-between;
  padding:0 28px;box-shadow:0 2px 20px rgba(37,99,235,.5);position:sticky;top:0;z-index:100;
}
nav .brand{display:flex;align-items:center;gap:10px}
nav .brand h1{font-size:17px;font-weight:700;color:#fff}
nav .brand small{color:#93c5fd;font-size:11px}
.status-pill{
  display:flex;align-items:center;gap:7px;background:rgba(0,0,0,.35);
  padding:5px 14px;border-radius:20px;font-size:12px;color:#e2e8f0;
}
.dot{width:8px;height:8px;border-radius:50%}
.dot.on{background:#10b981;box-shadow:0 0 0 3px rgba(16,185,129,.25);animation:blink 1.8s infinite}
.dot.off{background:#4b5563}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}

.wrap{max-width:1380px;margin:0 auto;padding:20px}

.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}
@media(max-width:800px){.stats{grid-template-columns:repeat(2,1fr)}}
.stat{
  background:var(--card);border:1px solid var(--border);border-radius:10px;
  padding:16px 20px;display:flex;align-items:center;gap:14px;
  transition:.2s;cursor:default;
}
.stat:hover{border-color:#2563eb55;transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,0,0,.35)}
.stat-icon{font-size:30px;flex-shrink:0}
.stat-val{font-size:26px;font-weight:800;line-height:1}
.stat-lbl{font-size:11px;color:var(--muted);margin-top:3px}

.row2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
@media(max-width:800px){.row2{grid-template-columns:1fr}}

.card{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.ch{
  padding:14px 18px;border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;
  background:rgba(37,99,235,.04);
}
.ch h2{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}
.cb{padding:18px}

.irow{display:flex;gap:8px;margin-bottom:12px}
input[type=url]{
  flex:1;background:var(--faint);border:1px solid var(--border);border-radius:8px;
  padding:9px 13px;color:var(--text);font-size:13px;outline:none;transition:.2s;
}
input[type=url]:focus{border-color:var(--accent)}
input[type=url]::placeholder{color:var(--muted)}

.btn{
  padding:9px 18px;border-radius:8px;border:none;cursor:pointer;
  font-size:13px;font-weight:600;transition:.15s;white-space:nowrap;
}
.btn:active{transform:scale(.96)}
.btn-blue{background:var(--accent);color:#fff}
.btn-blue:hover{background:#1d4ed8;box-shadow:0 3px 10px rgba(37,99,235,.4)}
.btn-green{background:var(--green);color:#fff}
.btn-green:hover{background:#059669}
.btn-red{background:var(--red);color:#fff}
.btn-red:hover{background:#dc2626}
.btn-amber{background:var(--orange);color:#fff}
.btn-amber:hover{background:#d97706}
.btn-sm{padding:5px 11px;font-size:11px;border-radius:6px}
.btn-ghost{background:var(--faint);color:var(--muted);border:1px solid var(--border)}

.ctrl-row{display:flex;gap:8px;flex-wrap:wrap;padding-top:14px;border-top:1px solid var(--border);margin-top:14px}

.log{
  background:#040710;border:1px solid var(--border);border-radius:8px;
  height:260px;overflow-y:auto;padding:10px 12px;
  font-family:'Courier New',monospace;font-size:11.5px;line-height:1.7;
}
.le{padding:0}
.le.i{color:#60a5fa}.le.s{color:#34d399}.le.w{color:#fbbf24}.le.e{color:#f87171}

.plist{display:flex;flex-direction:column;gap:10px}
.pc{
  background:var(--faint);border:1px solid var(--border);border-radius:10px;
  padding:14px 16px;display:flex;align-items:center;gap:14px;
  transition:.2s;
}
.pc:hover{border-color:#2563eb33;transform:translateX(2px)}
.pnum{
  width:30px;height:30px;border-radius:50%;background:var(--accent);
  display:flex;align-items:center;justify-content:center;
  font-size:12px;font-weight:700;flex-shrink:0;
}
.pinfo{flex:1;min-width:0}
.pname{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ptags{display:flex;gap:10px;margin-top:5px;flex-wrap:wrap}
.tag{
  display:inline-flex;align-items:center;gap:5px;
  padding:2px 9px;border-radius:20px;font-size:12px;font-weight:500;
}
.tag-b{background:rgba(37,99,235,.12);color:#93c5fd;border:1px solid rgba(37,99,235,.2)}
.tag-g{background:rgba(16,185,129,.12);color:#6ee7b7;border:1px solid rgba(16,185,129,.2)}
.ptime{font-size:10px;color:var(--muted);margin-top:4px}

.empty{text-align:center;padding:40px 20px;color:var(--muted)}
.empty .ei{font-size:44px;margin-bottom:10px}

.toast{
  position:fixed;bottom:20px;right:20px;background:#1e293b;
  border:1px solid var(--border);border-radius:10px;padding:12px 18px;
  box-shadow:0 8px 28px rgba(0,0,0,.5);font-size:13px;z-index:9999;
  opacity:0;transform:translateY(20px);transition:.3s;pointer-events:none;max-width:300px;
}
.toast.show{opacity:1;transform:translateY(0)}
.toast.ok{border-left:3px solid #10b981}
.toast.err{border-left:3px solid #ef4444}

::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-thumb{background:#1e2a3a;border-radius:3px}
</style>
</head>
<body>
<nav>
  <div class="brand">
    <span style="font-size:24px">🛒</span>
    <div><h1>Flipkart Price Alert Bot</h1><small>Real-time price monitoring · 15s interval</small></div>
  </div>
  <div class="status-pill">
    <div class="dot" id="sdot"></div>
    <span id="stxt">Loading…</span>
  </div>
</nav>

<div class="wrap">
  <div class="stats">
    <div class="stat"><span class="stat-icon">📦</span><div><div class="stat-val" id="sP">0</div><div class="stat-lbl">Products Tracked</div></div></div>
    <div class="stat"><span class="stat-icon">👥</span><div><div class="stat-val" id="sU">0</div><div class="stat-lbl">Approved Users</div></div></div>
    <div class="stat"><span class="stat-icon">⏱</span><div><div class="stat-val">15s</div><div class="stat-lbl">Check Interval</div></div></div>
    <div class="stat"><span class="stat-icon">🎯</span><div><div class="stat-val" id="sS">25</div><div class="stat-lbl">Slots Available</div></div></div>
  </div>

  <div class="row2">
    <div class="card">
      <div class="ch"><h2>➕ Add Flipkart Product</h2><span style="font-size:11px;color:var(--muted);background:rgba(37,99,235,.1);padding:2px 10px;border-radius:20px">Max 25</span></div>
      <div class="cb">
        <div class="irow">
          <input type="url" id="purl" placeholder="Paste Flipkart product URL…" />
          <button class="btn btn-blue" onclick="addProduct()">Add</button>
        </div>
        <small style="color:var(--muted)">⚠️ Only Flipkart.com links supported</small>
        <div class="ctrl-row">
          <button class="btn btn-green" onclick="ctrl('start')">▶ Start</button>
          <button class="btn btn-red"   onclick="ctrl('stop')">⏹ Stop</button>
          <button class="btn btn-amber" onclick="ctrl('check')">🔄 Check Now</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="ch"><h2>📋 Activity Log</h2><button class="btn btn-sm btn-ghost" onclick="clrLog()">Clear</button></div>
      <div class="cb" style="padding:10px">
        <div class="log" id="logBox"><div class="le i">[System] Panel loaded…</div></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="ch"><h2>🛍 Tracked Products</h2><button class="btn btn-sm btn-ghost" onclick="loadData()">↻ Refresh</button></div>
    <div class="cb">
      <div class="plist" id="plist">
        <div class="empty"><div class="ei">📭</div><div>No products tracked yet</div></div>
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
function toast(msg,type='ok'){
  const t=document.getElementById('toast');
  t.textContent=(type==='ok'?'✅ ':'❌ ')+msg;
  t.className='toast show '+type;
  setTimeout(()=>t.className='toast',3000);
}
function log(msg,cls='i'){
  const b=document.getElementById('logBox');
  const d=document.createElement('div');
  d.className='le '+cls;
  d.textContent='['+new Date().toLocaleTimeString('en-IN')+'] '+msg;
  b.appendChild(d);b.scrollTop=b.scrollHeight;
}
function clrLog(){document.getElementById('logBox').innerHTML=''}
function fmt(n){return n?n.toLocaleString('en-IN'):'N/A'}

async function loadData(){
  try{
    const r=await fetch('/api/status');
    const d=await r.json();
    const on=d.isChecking;
    document.getElementById('sdot').className='dot '+(on?'on':'off');
    document.getElementById('stxt').textContent=on?'Checking Active':'Checking Stopped';
    document.getElementById('sP').textContent=d.products.length;
    document.getElementById('sU').textContent=d.approvedUsers;
    document.getElementById('sS').textContent=25-d.products.length;
    renderList(d.products);
  }catch(e){}
}

function renderList(ps){
  const c=document.getElementById('plist');
  if(!ps.length){c.innerHTML='<div class="empty"><div class="ei">📭</div><div>No products tracked. Add a Flipkart link above!</div></div>';return;}
  c.innerHTML=ps.map((p,i)=>\`
    <div class="pc">
      <div class="pnum">\${i+1}</div>
      <div class="pinfo">
        <div class="pname" title="\${p.name}">\${p.name}</div>
        <div class="ptags">
          <span class="tag tag-b">💰 ₹\${fmt(p.price)}</span>
          \${p.lowestPrice&&p.lowestPrice!==p.price?\`<span class="tag tag-g">🏷 ₹\${fmt(p.lowestPrice)}</span>\`:''}
        </div>
        <div class="ptime">Last checked: \${p.lastChecked?new Date(p.lastChecked).toLocaleString('en-IN'):'Never'}</div>
      </div>
      <button class="btn btn-sm btn-red" onclick="del('\${p.id}')">🗑</button>
    </div>
  \`).join('');
}

async function addProduct(){
  const url=document.getElementById('purl').value.trim();
  if(!url)return toast('Enter a URL','err');
  if(!url.includes('flipkart.com'))return toast('Only Flipkart links!','err');
  log('Fetching: '+url.slice(0,55)+'…');
  try{
    const r=await fetch('/api/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
    const d=await r.json();
    if(d.success){
      toast(d.product.name.slice(0,35));
      log('✅ '+d.product.name+' | ₹'+fmt(d.product.price)+' | Lowest ₹'+fmt(d.product.lowestPrice),'s');
      document.getElementById('purl').value='';
      loadData();
    }else{toast(d.error||'Failed','err');log('❌ '+(d.error||'Failed'),'e');}
  }catch(e){toast('Network error','err');}
}

async function del(id){
  if(!confirm('Remove this product?'))return;
  const r=await fetch('/api/products/'+id,{method:'DELETE'});
  const d=await r.json();
  if(d.success){toast('Removed');loadData();}else toast(d.error||'Failed','err');
}

async function ctrl(a){
  log('Control: '+a,'w');
  const r=await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:a})});
  const d=await r.json();
  toast(d.message||'Done');
  log('✅ '+(d.message||a),'s');
  loadData();
}

loadData();
setInterval(loadData,10000);
</script>
</body>
</html>`;

// ─── API ENDPOINTS ─────────────────────────────────────────────────────────────
app.get('/',     (_,res) => res.send(PANEL));
app.get('/ping', (_,res) => res.json({ok:true, ts:Date.now()}));

app.get('/api/status', (_,res) => res.json({
  isChecking  : db.isChecking,
  products    : db.products,
  approvedUsers: db.approvedUsers.length,
  pendingUsers : db.pendingUsers.length,
}));

app.post('/api/products', async (req,res) => {
  const { url } = req.body;
  if (!url || !url.includes('flipkart.com')) return res.json({success:false,error:'Invalid Flipkart URL'});
  if (db.products.length >= MAX_PRODUCTS) return res.json({success:false,error:`Max ${MAX_PRODUCTS} products reached`});
  if (db.products.find(p=>p.url===url)) return res.json({success:false,error:'Already tracking this product'});
  const info = await scrapeFlipkart(url);
  if (!info||!info.price) return res.json({success:false,error:'Could not fetch product — check URL'});
  const product = { id:Date.now(), url, name:info.name, price:info.price, lowestPrice:info.lowestPrice, lastChecked:new Date().toISOString(), addedBy:'panel' };
  db.products.push(product); saveDB();
  res.json({success:true,product});
});

app.delete('/api/products/:id', (req,res) => {
  const idx = db.products.findIndex(p=>String(p.id)===req.params.id);
  if (idx===-1) return res.json({success:false,error:'Not found'});
  db.products.splice(idx,1); saveDB();
  res.json({success:true});
});

app.post('/api/control', (req,res) => {
  const { action } = req.body;
  if (action==='start') { startChecking(); return res.json({message:'✅ Checking started (15s interval)'}); }
  if (action==='stop')  { stopChecking();  return res.json({message:'⏹ Checking stopped'}); }
  if (action==='check') { runCheck();      return res.json({message:'🔄 Manual check triggered'}); }
  res.json({message:'Unknown action'});
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Server: http://localhost:${PORT}`);
  console.log(`🤖 Telegram Bot: ACTIVE`);
  console.log(`👑 Admin ID: ${ADMIN_CHAT_ID}\n`);
});
