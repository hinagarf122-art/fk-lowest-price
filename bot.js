async function scrapeFK(url) {
  if (!url.includes('www.flipkart.com')) {
    url = url.replace('flipkart.com', 'www.flipkart.com');
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[Scraper] Attempt ${attempt}: ${url.slice(0, 65)}`);
      const ua = nextUA();
      const resp = await axios.get(url, {
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache',
          'Cookie': 'T=1; _session_id=abc123456789; flCart=; fn=Guest; fm=G',
        },
        timeout: 20000,
        maxRedirects: 5,
        decompress: true,
      });

      const $ = cheerio.load(resp.data);

      // ── Name Extraction ───────────────────────────────────────
      let name = '';
      for (const s of ['span.VU-ZEz', 'span.B_NuCI', '._35KyD6', 'h1 span', '.yhB1nd', 'title']) {
        const t = s === 'title' ? $('title').text().split('|')[0].split('-')[0].trim() : $(s).first().text().trim();
        if (t && t.length > 4) { name = t; break; }
      }
      if (!name) name = 'Flipkart Product';

      // ── Main Price (Price to Buy) ─────────────────────────────
      let price = null;
      for (const s of ['div.Nx9bqj.CxhGGd', 'div.Nx9bqj', '._30jeq3._16Jk6d', '._16Jk6d', '._25b18c ._30jeq3', '.CEmiEU .Nx9bqj']) {
        const t = $(s).first().text().trim();
        const p = parsePrice(t);
        if (p) { price = p; break; }
      }

      // Fallback Main Price search
      if (!price) {
        $('*').each((_, el) => {
          if (price) return false;
          const own = $(el).clone().children().remove().end().text().trim();
          if (own.includes('₹')) { const p = parsePrice(own); if (p && p > 999) price = p; }
        });
      }

      // ── Lowest Price (With Bank Offer Calculation) ────────────
      let lowestPrice = null;
      
      // Target elements specifically designated for offers / special prices
      for (const s of ['.yRaY8j.ZYYwLA', '.yRaY8j', '._3qQ9m1', '.PCWT0u', '.LFwuGS', 'div.Nx9bqj + div']) {
        const t = $(s).first().text().trim();
        const p = parsePrice(t);
        if (p && price && p < price) { lowestPrice = p; break; }
      }

      // Deep scan all text chunks that match common offer layout formats
      if (!lowestPrice && price) {
        $('[class*="offer"],[class*="bank"],[class*="Bank"],[class*="Offer"], span, div').each((_, el) => {
          const t = $(el).text();
          if (t.includes('₹') && (t.toLowerCase().includes('lowest') || t.toLowerCase().includes('off') || t.toLowerCase().includes('bank'))) {
            const p = parsePrice(t);
            if (p && p < price && p >= 500) { 
              lowestPrice = p; 
              return false; // Break loop if lower match found
            }
          }
        });
      }

      // Dynamic Fallback Matrix: If still not found, check layout structures safely
      if (!lowestPrice || lowestPrice >= price) {
        if (price) {
          // Generally, offer prices might hover around 5% to 15% lower via credit cards
          // For safe default alerts, if no element is readable, we stick to regular price
          lowestPrice = price; 
        }
      }

      if (!price) {
        console.log(`[Scraper] Attempt ${attempt}: no price found`);
        if (attempt < 3) { await sleep(4000); continue; }
        return null;
      }

      console.log(`[Scraper] ✅ "${name.slice(0, 35)}" | Price: ₹${price} | Lowest: ₹${lowestPrice}`);
      return { name, price, lowestPrice };

    } catch (e) {
      console.error(`[Scraper] Attempt ${attempt} error: ${e.message}`);
      if (attempt < 3) await sleep(5000);
    }
  }
  return null;
}
