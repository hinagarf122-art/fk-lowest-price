async function getBrowser() {
  if (browserInst) {
    try { const pages = await browserInst.pages(); if (pages) return browserInst; }
    catch(e) { browserInst = null; }
  }
  console.log('[Browser] Launching Puppeteer...');
  
  // Render environment me production standard path check karne ke liye
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;

  browserInst = await puppeteer.launch({
    headless: 'new',
    executablePath: executablePath, // Render standard binary use karega
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process'
    ],
  });
  browserInst.on('disconnected', () => { browserInst = null; });
  return browserInst;
}
