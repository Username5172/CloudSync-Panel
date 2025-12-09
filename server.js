// server.js - CloudSync Panel (automação com Puppeteer)
// ATENÇÃO: Use somente para contas autorizadas.
// npm i express helmet body-parser express-rate-limit cors dotenv puppeteer

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

// Basic security middlewares
app.use(helmet());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors({ origin: true, credentials: true }));

// Rate limiting per IP (tweak as needed)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 6,
  message: { ok: false, error: 'Muitas requisições - aguarde um pouco' }
});
app.use('/api/', limiter);

// Serve frontend
app.use('/', express.static('public'));

/*
 Simple queue to avoid overlapping browser instances and reduce chance of blocks.
 Each job: { email, password, res }.
*/
const queue = [];
let running = false;

function pushJob(job) {
  queue.push(job);
  processQueue();
}

async function processQueue() {
  if (running) return;
  if (queue.length === 0) return;
  running = true;
  const job = queue.shift();
  try {
    const result = await doAutomation(job.email, job.password);
    // send JSON response
    job.res.json({ ok: true, result });
  } catch (err) {
    job.res.status(500).json({ ok: false, error: err.message || 'erro desconhecido' });
  } finally {
    running = false;
    // next job
    setImmediate(processQueue);
  }
}

async function doAutomation(email, password) {
  if (!email || !password) throw new Error('email e password necessários');

  // Launch puppeteer
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-zygote',
      '--single-process'
    ],
    defaultViewport: { width: 1280, height: 800 }
  });

  const page = await browser.newPage();

  // set a normal user agent to reduce detection
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36');
  // small navigation timeout
  page.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(30000);

  try {
    // 1) go to login page
    await page.goto('https://app.nolagcloud.com/login', { waitUntil: 'networkidle2' });

    // 2) fill email and password using placeholders you provided
    const emailSelector = 'input[placeholder="Seu e-mail ou nome de usuário"], input[type="text"], input[name*=email], input[id*=email]';
    const passSelector  = 'input[placeholder="Sua senha"], input[type="password"], input[name*=pass], input[id*=pass]';

    await page.waitForSelector(emailSelector, { timeout: 10000 });
    await page.focus(emailSelector);
    await page.evaluate((sel) => document.querySelector(sel).value = '', emailSelector);
    await page.type(emailSelector, email, { delay: 25 });

    await page.waitForSelector(passSelector, { timeout: 10000 });
    await page.focus(passSelector);
    await page.evaluate((sel) => document.querySelector(sel).value = '', passSelector);
    await page.type(passSelector, password, { delay: 25 });

    // 3) try to submit: prefer form submit, fallback to button click
    const submitted = await page.evaluate(() => {
      const emailEl = document.querySelector('input[placeholder="Seu e-mail ou nome de usuário"], input[type="text"], input[name*=email], input[id*=email"]');
      if (!emailEl) return false;
      const form = emailEl.closest('form');
      if (form) { form.submit(); return true; }
      return false;
    }).catch(()=>false);

    if (!submitted) {
      // try click submit button
      const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
      if (submitBtn) {
        await submitBtn.click();
      } else {
        // try button with text 'entrar' or 'login' or 'sign in' (case-insensitive)
        const [btn] = await page.$x("//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'entrar') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'login') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'sign in')]");
        if (btn) await btn.click();
      }
    }

    // 4) wait for navigation or for the dashboard root
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(()=>{});
    // ensure we're on the dashboard root (fallback)
    await page.goto('https://app.nolagcloud.com/', { waitUntil: 'networkidle2', timeout: 20000 }).catch(()=>{});

    // Detect common failure: captcha elements or "challenge" text
    const pageText = (await page.evaluate(()=> document.body.innerText)).toLowerCase();
    if (pageText.includes('captcha') || pageText.includes('verificação') || pageText.includes('challenge')) {
      throw new Error('Detectei um CAPTCHA / verificação humana — automação não pode prosseguir');
    }
    // Also detect login error messages from site
    if (pageText.includes('senha incorreta') || pageText.includes('credenciais')) {
      throw new Error('Credenciais inválidas ou login falhou - verifique email/senha');
    }

    // 5) click "Criar Máquina" button (text-based click)
    // we try several forms of the button text (accent/without-accent)
    const [createBtn] = await page.$x("//button[contains(translate(., 'ÁÀÂÃÄÅÇÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÝÃ','áàâãäåçéèêëíìîïóòôõöúùûüýã'), 'criar máquina') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'criar maquina') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'criar')]");
    if (createBtn) {
      await createBtn.click();
    } else {
      // try to find by visible text "Criar Máquina" ignoring accents
      const allButtons = await page.$$('button');
      let clicked = false;
      for (const b of allButtons) {
        const txt = (await page.evaluate(el => (el.innerText || '').trim().toLowerCase(), b)).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (txt === 'criar máquina' || txt === 'criar maquina' || txt.includes('criar')) {
          await b.click();
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        throw new Error('Botão "Criar Máquina" não encontrado na página');
      }
    }

    // 6) wait for UI update and try to capture queue/position info
    await page.waitForTimeout(2000);
    const bodyText = await page.evaluate(()=> document.body.innerText.toLowerCase());
    // search relevant lines
    const matches = bodyText.split('\\n').map(l => l.trim()).filter(l => l && (l.includes('fila') || l.includes('posição') || l.includes('posição na fila') || l.includes('você está') || l.includes('position') || l.includes('queue')));
    // if nothing found, just return generic success message
    await browser.close();
    return { message: 'Ação executada — verifique painel', info: matches.slice(0,10) };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// Endpoint that enqueues a job
app.post('/api/generate', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ ok: false, error: 'email e senha requeridos' });

    // Push job to queue. We do not log password.
    console.log(`Nova solicitação para: ${email} (fila atual: ${queue.length})`);
    pushJob({ email, password, res });

    // Note: response will be sent by the queue worker when job finishes.
  } catch (err) {
    res.status(500).json({ ok: false, error: 'falha interna' });
  }
});

app.listen(PORT, () => console.log(`CloudSync Panel rodando na porta ${PORT}`));
