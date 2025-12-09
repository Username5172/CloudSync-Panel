import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

// Corrigir caminho
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Servir o index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Rota de autenticação
app.post("/auth", async (req, res) => {
  const { email, password } = req.body;

  // SUBSTITUA PELO SEU SITE REAL DE VALIDAÇÃO
  const API_URL = "https://SEU-SITE-AQUI.com/api/login";

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (data.auth === true) {
      return res.json({ success: true });
    } else {
      return res.json({ success: false, message: "Credenciais inválidas." });
    }

  } catch (e) {
    return res.json({ success: false, message: "Erro interno no servidor." });
  }
});

// Dashboard simples
app.get("/dashboard", (req, res) => {
  res.send("<h1>Bem-vindo ao CloudSync!</h1>");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Servidor rodando na porta " + port));
