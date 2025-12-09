// Servidor básico (NÃO automatiza login no NoLagCloud)
// Apenas exemplo para hospedar no Render
import express from "express";
const app = express();

app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/index.html");
});

app.post("/login", (req, res) => {
  res.send("Recebido: " + JSON.stringify(req.body));
});

app.listen(3000, () => console.log("Rodando na porta 3000"));
