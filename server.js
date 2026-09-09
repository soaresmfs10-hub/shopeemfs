const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const express = require("express");
const qrcode = require("qrcode-terminal");
const qrcodePng = require("qrcode");
const pino = require("pino");
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { promisify } = require("node:util");

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const logger = pino({ level: "silent" });

// Sessão local temporária. No Render grátis ela é restaurada do Supabase ao iniciar.
const AUTH_FOLDER = process.env.WHATSAPP_AUTH_FOLDER || "auth_info_baileys";
const PORT = process.env.PORT || 3333;

// Supabase Storage: use a SERVICE ROLE KEY somente no servidor.
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "whatsapp-session";
const SUPABASE_SESSION_OBJECT = process.env.SUPABASE_SESSION_OBJECT || "auth_info_baileys.backup.gz";

let sock = null;
let conectado = false;
let backupTimer = null;
let backupInProgress = false;
let ultimoQR = null;

function supabaseConfigurado() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function storageUrl() {
  return `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${encodeURIComponent(SUPABASE_SESSION_OBJECT)}`;
}

async function listarArquivos(dir, base = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listarArquivos(full, base));
    } else if (entry.isFile()) {
      files.push({ full, relative: path.relative(base, full) });
    }
  }

  return files;
}

async function restaurarSessaoDoSupabase() {
  if (!supabaseConfigurado()) {
    console.log("ℹ️ Supabase Storage não configurado. A sessão ficará apenas local.");
    await fs.mkdir(AUTH_FOLDER, { recursive: true });
    return false;
  }

  console.log("☁️ Procurando backup da sessão do WhatsApp no Supabase...");

  try {
    const response = await fetch(storageUrl(), {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });

    // O Supabase Storage pode retornar 404 ou 400/NoSuchKey
    // quando o arquivo ainda não existe.
    if (!response.ok) {
      const text = await response.text();

      const arquivoNaoExiste =
        response.status === 404 ||
        (
          response.status === 400 &&
          (
            text.includes("NoSuchKey") ||
            text.includes("Object not found") ||
            text.includes("not_found")
          )
        );

      if (arquivoNaoExiste) {
        console.log("ℹ️ Nenhum backup encontrado.");
        console.log("📱 Será criada uma nova sessão. Escaneie o QR Code no WhatsApp.");

        await fs.mkdir(AUTH_FOLDER, { recursive: true });
        return false;
      }

      throw new Error(
        `Falha ao baixar sessão do Supabase (${response.status}): ${text}`
      );
    }

    const compressed = Buffer.from(await response.arrayBuffer());
    const json = await gunzip(compressed);
    const backup = JSON.parse(json.toString("utf8"));

    if (!backup || backup.version !== 1 || typeof backup.files !== "object") {
      throw new Error("Backup de sessão inválido.");
    }

    await fs.rm(AUTH_FOLDER, { recursive: true, force: true });
    await fs.mkdir(AUTH_FOLDER, { recursive: true });

    let restored = 0;
    const base = path.resolve(AUTH_FOLDER);

    for (const [relative, base64] of Object.entries(backup.files)) {
      const target = path.resolve(base, relative);

      if (!target.startsWith(base + path.sep)) {
        throw new Error("Caminho inválido no backup da sessão.");
      }

      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(base64, "base64"));
      restored++;
    }

    console.log(`✅ Sessão restaurada do Supabase (${restored} arquivos).`);
    return true;

  } catch (error) {
    console.error("❌ Erro ao restaurar sessão:", error.message);

    // Se o arquivo simplesmente ainda não existe,
    // não deve derrubar o serviço.
    if (
      error.message.includes("NoSuchKey") ||
      error.message.includes("Object not found") ||
      error.message.includes("not_found")
    ) {
      console.log("ℹ️ Nenhuma sessão salva ainda. Iniciando uma sessão nova.");
      await fs.mkdir(AUTH_FOLDER, { recursive: true });
      return false;
    }

    throw error;
  }
}

async function salvarSessaoNoSupabase() {
  if (!supabaseConfigurado() || backupInProgress) return;

  backupInProgress = true;
  try {
    await fs.mkdir(AUTH_FOLDER, { recursive: true });
    const files = await listarArquivos(AUTH_FOLDER);

    if (files.length === 0) return;

    const data = {};
    for (const file of files) {
      data[file.relative.split(path.sep).join("/")] = (await fs.readFile(file.full)).toString("base64");
    }

    const payload = Buffer.from(JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      files: data
    }));

    const compressed = await gzip(payload);

    const response = await fetch(storageUrl(), {
      method: "PUT",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/gzip",
        "x-upsert": "true"
      },
      body: compressed
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Falha ao salvar sessão (${response.status}): ${text}`);
    }

    console.log(`☁️ Sessão do WhatsApp salva no Supabase (${files.length} arquivos).`);
  } catch (error) {
    console.error("⚠️ Não foi possível fazer backup da sessão:", error.message);
  } finally {
    backupInProgress = false;
  }
}

function agendarBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    salvarSessaoNoSupabase();
  }, 2000);
}

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  sock = makeWASocket({
    auth: state,
    logger,
    markOnlineOnConnect: false
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    agendarBackup();
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      ultimoQR = qr;
      console.log("\n📱 ESCANEIE O QR CODE: abra /qr no navegador (o desenho no log fica ilegível).\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      conectado = true;
      ultimoQR = null;
      console.log("\n✅ WHATSAPP CONECTADO! Serviço pronto para receber pedidos de envio.");
      salvarSessaoNoSupabase();
    }

    if (connection === "close") {
      conectado = false;
      const codigo = lastDisconnect?.error?.output?.statusCode;

      if (codigo !== DisconnectReason.loggedOut) {
        console.log("\n⚠️ Conexão caiu. Reconectando em 3s...");
        setTimeout(conectar, 3000);
      } else {
        console.log("\n❌ WhatsApp deslogado. Apagando sessão antiga e gerando um QR Code novo...");
        limparSessaoEReconectar();
      }
    }
  });
}

async function apagarSessaoNoSupabase() {
  if (!supabaseConfigurado()) return;

  try {
    const response = await fetch(storageUrl(), {
      method: "DELETE",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });

    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      throw new Error(`status ${response.status}: ${text}`);
    }

    console.log("🗑️ Sessão antiga apagada do Supabase.");
  } catch (error) {
    console.error("⚠️ Não foi possível apagar a sessão antiga do Supabase:", error.message);
  }
}

async function limparSessaoEReconectar() {
  clearTimeout(backupTimer);

  try {
    await fs.rm(AUTH_FOLDER, { recursive: true, force: true });
    await fs.mkdir(AUTH_FOLDER, { recursive: true });
  } catch (error) {
    console.error("⚠️ Erro ao limpar sessão local:", error.message);
  }

  await apagarSessaoNoSupabase();

  setTimeout(conectar, 2000);
}

// ===================== API HTTP =====================

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.type("text/plain").send("ShopeeBot OK");
});

app.get("/status", (req, res) => {
  res.json({ conectado });
});

app.get("/qr", async (req, res) => {
  if (conectado) {
    return res
      .type("text/html")
      .send("<h2>✅ WhatsApp já está conectado. Não há QR pendente.</h2>");
  }

  if (!ultimoQR) {
    return res
      .type("text/html")
      .send("<h2>⏳ Nenhum QR code gerado ainda. Aguarde alguns segundos e recarregue a página.</h2>");
  }

  try {
    const png = await qrcodePng.toBuffer(ultimoQR, { width: 320, margin: 2 });
    res.type("image/png").send(png);
  } catch (erro) {
    console.log("\n❌ Erro ao gerar imagem do QR:", erro);
    res.status(500).send("Falha ao gerar QR code.");
  }
});

app.get("/grupos", async (req, res) => {
  if (!conectado || !sock) {
    return res.status(503).json({ erro: "WhatsApp não está conectado ainda." });
  }

  try {
    const grupos = await sock.groupFetchAllParticipating();
    const lista = Object.entries(grupos).map(([id, grupo]) => ({ id, nome: grupo.subject }));
    res.json({ grupos: lista });
  } catch (erro) {
    console.log("\n❌ Erro ao listar grupos:", erro);
    res.status(500).json({ erro: "Falha ao listar grupos." });
  }
});

app.post("/send", async (req, res) => {
  const { group_id, message, image_url } = req.body || {};

  if (!group_id || !message) {
    return res.status(400).json({ erro: "Campos obrigatórios: group_id e message." });
  }

  if (!conectado || !sock) {
    return res.status(503).json({ erro: "WhatsApp não está conectado ainda." });
  }

  try {
    if (image_url) {
      await sock.sendMessage(group_id, { image: { url: image_url }, caption: message });
    } else {
      await sock.sendMessage(group_id, { text: message });
    }

    const preview = message.length > 80 ? message.slice(0, 80) + "..." : message;
    console.log(`\n🎉 MENSAGEM ENVIADA`);
    console.log(`📱 Grupo: ${group_id}`);
    console.log(`📝 Conteúdo: ${preview}`);
    console.log(`🖼️ Foto: ${image_url ? "enviada" : "não enviada"}`);
    res.json({ ok: true });
  } catch (erro) {
    console.log("\n❌ ERRO ao enviar mensagem:", erro);
    res.status(500).json({ erro: "Falha ao enviar mensagem.", detalhe: String(erro) });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 API do WhatsApp rodando na porta ${PORT}`);
});

async function shutdown() {
  console.log("\n💾 Encerrando: salvando sessão no Supabase...");
  clearTimeout(backupTimer);
  await salvarSessaoNoSupabase();
  process.exit(0);
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

(async () => {
  console.log("🚀 Iniciando serviço WhatsApp...");
  await restaurarSessaoDoSupabase();
  await conectar();

  // Backup periódico para capturar arquivos de chave que o Baileys atualiza.
  setInterval(salvarSessaoNoSupabase, 60000).unref();
})();
