// server.js - CloudSync Panel (CommonJS, robusto)
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// middlewares básicos de segurança
app.use(helmet());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors({ origin: true }));

// rate limit simples
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  message: { ok: false, error: 'Muitas requisições. Tente novamente em instantes.' }
});
app.use('/api/', limiter);

// servir frontend estático
app.use('/', express.static('public'));

// TENTAR carregar puppeteer - se falhar, mantemos o servidor OK, mas desabilitamos automação
let puppeteer = null;
let puppeteerAvailable = false;
try {
  puppeteer = require('puppeteer');
  puppeteerAvailable = true;
  console.log('Puppeteer carregado com sucesso.');
} catch (e) {
  console.error('Puppeteer NÃO pôde ser carregado. Endpoints de automação estarão indisponíveis.', e.message || e);
  puppeteerAvailable = false;
}

/*
Fila simples para evitar múltiplas instâncias concorrentes
Cada job: { email, password, res }
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
    if (!puppeteerAvailable) {
      throw new Error('Automação indisponível no momento (Puppeteer não carregado). Verifique logs/instalação.');
    }
    const out = await doAutomation(job.email, job.password);
    job.res.json({ ok: true, result: out });
  } catch (err) {
    job.res.status(500).json({ ok: false, error: err.message || 'erro desconhecido' });
  } finally {
    running = false;
    setImmediate(processQueue);
  }
}

async function doAutomation(email, password) {
  if (!email || !password) throw new Error('email e senha necessários');

  // Iniciar browser
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 800 }
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
  page.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(30000);

  try {
    await page.goto('https://app.nolagcloud.com/login', { waitUntil: 'networkidle2' });

    // seletores que você já forneceu
    const emailSelector = 'input[placeholder="Seu e-mail ou nome de usuário"], input[type="text"], input[name*=email], input[id*=email]';
    const passSelector = 'input[placeholder="Sua senha"], input[type="password"], input[name*=pass], input[id*=pass]';

    await page.waitForSelector(emailSelector, { timeout: 10000 });
    await page.evaluate((sel, val) => { const el = document.querySelector(sel); if (el) { el.value = ''; el.focus(); el.value = val; el.dispatchEvent(new Event('input',{bubbles:true})); } }, emailSelector, email);

    await page.waitForSelector(passSelector, { timeout: 10000 });
    await page.evaluate((sel, val) => { const el = document.querySelector(sel); if (el) { el.value = ''; el.focus(); el.value = val; el.dispatchEvent(new Event('input',{bubbles:true})); } }, passSelector, password);

    // tentar submeter
    const submitted = await page.evaluate(() => {
      const emailEl = document.querySelector('input[placeholder="Seu e-mail ou nome de usuário"], input[type="text"], input[name*=email], input[id*=email"]');
      if (!emailEl) return false;
      const form = emailEl.closest('form');
      if (form) { form.submit(); return true; }
      return false;
    }).catch(()=>false);

    if (!submitted) {
      const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
      if (submitBtn) await submitBtn.click();
      else {
        const [btn] = await page.$x("//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'entrar') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'login') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'sign in')]");
        if (btn) await btn.click();
      }
    }

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(()=>{});
    await page.goto('https://app.nolagcloud.com/', { waitUntil: 'networkidle2', timeout: 20000 }).catch(()=>{});

    // detectar captcha / erros
    const pageText = (await page.evaluate(()=> document.body.innerText)).toLowerCase();
    if (pageText.includes('captcha') || pageText.includes('verificação') || pageText.includes('challenge')) {
      throw new Error('CAPTCHA detectado — automação não pode prosseguir.');
    }
    if (pageText.includes('senha incorreta') || pageText.includes('credenciais')) {
      throw new Error('Credenciais inválidas / login falhou.');
    }

    // clicar no botão "Criar Máquina"
    const [createBtn] = await page.$x("//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'criar máquina') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'criar maquina') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'), 'criar')]");
    if (createBtn) {
      await createBtn.click();
    } else {
      // fallback: procurar por botão que contenha 'criar' ignorando acentos
      const allButtons = await page.$$('button');
      let clicked = false;
      for (const b of allButtons) {
        let txt = await page.evaluate(el => (el.innerText || '').trim().toLowerCase(), b);
        txt = txt.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (txt === 'criar maquina' || txt.includes('criar')) {
          await b.click(); clicked = true; break;
        }
      }
      if (!clicked) throw new Error('Botão "Criar Máquina" não encontrado.');
    }

    await page.waitForTimeout(2000);
    const bodyText = await page.evaluate(()=> document.body.innerText.toLowerCase());
    const matches = bodyText.split('\n').map(l => l.trim()).filter(l => l && (l.includes('fila') || l.includes('posição') || l.includes('posição na fila') || l.includes('você está') || l.includes('position') || l.includes('queue')));
    await browser.close();
    return { message: 'Ação executada', info: matches.slice(0,10) };
  } catch (err) {
    try { await browser.close(); } catch(e){/*ignore*/ }
    throw err;
  }
}

// endpoint que enfileira
app.post('/api/generate', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: 'email e senha requeridos' });

  if (!puppeteerAvailable) {
    return res.status(503).json({ ok: false, error: 'Automação indisponível (Puppeteer não instalado ou não carregado). Veja logs.' });
  }

  console.log(`Nova solicitação para ${email} — posição na fila: ${queue.length + 1}`);
  pushJob({ email, password, res });
});

// healthcheck
app.get('/health', (req, res) => res.json({ ok: true, puppeteer: puppeteerAvailable, queue: queue.length }));

app.listen(PORT, () => {
  console.log(`CloudSync Panel rodando na porta ${PORT} — Puppeteer disponível: ${puppeteerAvailable}`);
});
