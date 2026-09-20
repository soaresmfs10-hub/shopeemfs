const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const express = require("express");
const qrcodePng = require("qrcode");
const pino = require("pino");
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { promisify } = require("node:util");

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// ============================================================
// CONFIGURAÇÃO
// ============================================================

// Logger silencioso para não lotar o Render.
const logger = pino({ level: "silent" });

const AUTH_FOLDER =
  process.env.WHATSAPP_AUTH_FOLDER || "auth_info_baileys";

const PORT = process.env.PORT || 3333;

const SUPABASE_URL =
  (process.env.SUPABASE_URL || "").replace(/\/$/, "");

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const SUPABASE_STORAGE_BUCKET =
  process.env.SUPABASE_STORAGE_BUCKET || "whatsapp-session";

const SUPABASE_SESSION_OBJECT =
  process.env.SUPABASE_SESSION_OBJECT ||
  "auth_info_baileys.backup.gz";

// ============================================================
// ESTADO
// ============================================================

let sock = null;
let conectado = false;
let ultimoQR = null;

let backupTimer = null;
let backupInProgress = false;

let conectando = false;
let reconexaoTimer = null;

// ============================================================
// SUPABASE
// ============================================================

function supabaseConfigurado() {
  return Boolean(
    SUPABASE_URL &&
    SUPABASE_SERVICE_ROLE_KEY
  );
}

function storageUrl() {
  return (
    `${SUPABASE_URL}/storage/v1/object/` +
    `${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/` +
    `${encodeURIComponent(SUPABASE_SESSION_OBJECT)}`
  );
}

// ============================================================
// ARQUIVOS DA SESSÃO
// ============================================================

async function listarArquivos(dir, base = dir) {
  const entries = await fs.readdir(dir, {
    withFileTypes: true
  });

  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(
        ...(await listarArquivos(full, base))
      );
    } else if (entry.isFile()) {
      files.push({
        full,
        relative: path.relative(base, full)
      });
    }
  }

  return files;
}

// ============================================================
// RESTAURAR SESSÃO
// ============================================================

async function restaurarSessaoDoSupabase() {
  if (!supabaseConfigurado()) {
    await fs.mkdir(AUTH_FOLDER, {
      recursive: true
    });

    return false;
  }

  try {
    const response = await fetch(storageUrl(), {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization:
          `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });

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
        await fs.mkdir(AUTH_FOLDER, {
          recursive: true
        });

        return false;
      }

      throw new Error(
        `Falha ao baixar sessão (${response.status})`
      );
    }

    const compressed =
      Buffer.from(await response.arrayBuffer());

    const json = await gunzip(compressed);

    const backup =
      JSON.parse(json.toString("utf8"));

    if (
      !backup ||
      backup.version !== 1 ||
      typeof backup.files !== "object"
    ) {
      throw new Error("Backup de sessão inválido.");
    }

    await fs.rm(AUTH_FOLDER, {
      recursive: true,
      force: true
    });

    await fs.mkdir(AUTH_FOLDER, {
      recursive: true
    });

    const base = path.resolve(AUTH_FOLDER);

    for (const [relative, base64] of Object.entries(
      backup.files
    )) {
      const target =
        path.resolve(base, relative);

      if (
        !target.startsWith(
          base + path.sep
        )
      ) {
        throw new Error(
          "Caminho inválido no backup."
        );
      }

      await fs.mkdir(
        path.dirname(target),
        { recursive: true }
      );

      await fs.writeFile(
        target,
        Buffer.from(base64, "base64")
      );
    }

    return true;

  } catch (error) {
    const mensagem = String(
      error?.message || error
    );

    if (
      mensagem.includes("NoSuchKey") ||
      mensagem.includes("Object not found") ||
      mensagem.includes("not_found")
    ) {
      await fs.mkdir(AUTH_FOLDER, {
        recursive: true
      });

      return false;
    }

    console.log("⚠️ Falha ao restaurar sessão.");

    await fs.mkdir(AUTH_FOLDER, {
      recursive: true
    });

    return false;
  }
}

// ============================================================
// SALVAR SESSÃO
// ============================================================

async function salvarSessaoNoSupabase() {
  if (
    !supabaseConfigurado() ||
    backupInProgress
  ) {
    return;
  }

  backupInProgress = true;

  try {
    await fs.mkdir(AUTH_FOLDER, {
      recursive: true
    });

    const files =
      await listarArquivos(AUTH_FOLDER);

    if (files.length === 0) {
      return;
    }

    const data = {};

    for (const file of files) {
      data[
        file.relative
          .split(path.sep)
          .join("/")
      ] = (
        await fs.readFile(file.full)
      ).toString("base64");
    }

    const payload =
      Buffer.from(
        JSON.stringify({
          version: 1,
          updatedAt:
            new Date().toISOString(),
          files: data
        })
      );

    const compressed =
      await gzip(payload);

    const response = await fetch(
      storageUrl(),
      {
        method: "PUT",
        headers: {
          apikey:
            SUPABASE_SERVICE_ROLE_KEY,

          Authorization:
            `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

          "Content-Type":
            "application/gzip",

          "x-upsert": "true"
        },

        body: compressed
      }
    );

    if (!response.ok) {
      throw new Error(
        `Falha ao salvar sessão (${response.status})`
      );
    }

  } catch (error) {
    // Não imprimir o erro para não lotar o Render.
  } finally {
    backupInProgress = false;
  }
}

// ============================================================
// BACKUP COM PEQUENO ATRASO
// ============================================================

function agendarBackup() {
  clearTimeout(backupTimer);

  backupTimer = setTimeout(() => {
    salvarSessaoNoSupabase();
  }, 3000);
}

// ============================================================
// RECONEXÃO CONTROLADA
// ============================================================

function agendarReconexao() {

  // Já existe uma reconexão marcada.
  if (reconexaoTimer) {
    return;
  }

  reconexaoTimer = setTimeout(async () => {

    reconexaoTimer = null;

    await conectar();

  }, 5000);
}

// ============================================================
// CONECTAR WHATSAPP
// ============================================================

async function conectar() {

  // Impede duas conexões simultâneas.
  if (conectando) {
    return;
  }

  // Se já existe uma conexão funcionando,
  // não cria outra.
  if (sock && conectado) {
    return;
  }

  conectando = true;

  try {

    const { state, saveCreds } =
      await useMultiFileAuthState(
        AUTH_FOLDER
      );

    const novoSock =
      makeWASocket({
        auth: state,
        logger,

        markOnlineOnConnect: false
      });

    // Coloca o novo socket como atual.
    sock = novoSock;

    novoSock.ev.on(
      "creds.update",
      async () => {

        try {
          await saveCreds();
          agendarBackup();
        } catch {
          // Silencioso.
        }

      }
    );

    novoSock.ev.on(
      "connection.update",
      async (update) => {

        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        // =========================
        // QR CODE
        // =========================

        if (qr) {
          ultimoQR = qr;

          console.log(
            "📱 QR Code disponível em /qr"
          );
        }

        // =========================
        // CONECTADO
        // =========================

        if (connection === "open") {

          conectado = true;
          conectando = false;
          ultimoQR = null;

          console.log(
            "✅ WhatsApp conectado."
          );

          await salvarSessaoNoSupabase();

          return;
        }

        // =========================
        // DESCONECTADO
        // =========================

        if (connection === "close") {

          conectado = false;

          // Só esse socket pode derrubar
          // o estado global.
          if (sock === novoSock) {
            sock = null;
          }

          conectando = false;

          const codigo =
            lastDisconnect
              ?.error
              ?.output
              ?.statusCode;

          // Logout real.
          if (
            codigo ===
            DisconnectReason.loggedOut
          ) {

            console.log(
              "⚠️ WhatsApp desconectado. Sessão será recriada."
            );

            clearTimeout(backupTimer);

            try {
              await fs.rm(
                AUTH_FOLDER,
                {
                  recursive: true,
                  force: true
                }
              );

              await fs.mkdir(
                AUTH_FOLDER,
                {
                  recursive: true
                }
              );
            } catch {}

            await apagarSessaoNoSupabase();

            ultimoQR = null;

            agendarReconexao();

            return;
          }

          // Queda normal/temporária.
          console.log(
            `⚠️ WhatsApp caiu${codigo ? ` (${codigo})` : ""}. Reconectando...`
          );

          agendarReconexao();
        }

      }
    );

  } catch (error) {

    conectando = false;
    conectado = false;
    sock = null;

    // Não imprime stack gigante.
    console.log(
      "⚠️ Falha ao iniciar WhatsApp. Tentando novamente..."
    );

    agendarReconexao();
  }
}

// ============================================================
// APAGAR SESSÃO DO SUPABASE
// ============================================================

async function apagarSessaoNoSupabase() {

  if (!supabaseConfigurado()) {
    return;
  }

  try {

    const response =
      await fetch(
        storageUrl(),
        {
          method: "DELETE",

          headers: {
            apikey:
              SUPABASE_SERVICE_ROLE_KEY,

            Authorization:
              `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
          }
        }
      );

    // Não precisamos mostrar nada no log.

  } catch {
    // Silencioso.
  }
}

// ============================================================
// EXPRESS
// ============================================================

const app = express();

app.use(
  express.json()
);

// =========================
// HOME
// =========================

app.get("/", (req, res) => {

  res
    .type("text/plain")
    .send("ShopeeBot OK");

});

// =========================
// STATUS
// =========================

app.get("/status", (req, res) => {

  res.json({
    conectado
  });

});

// =========================
// QR CODE
// =========================

app.get("/qr", async (req, res) => {

  if (conectado) {

    return res
      .type("text/html")
      .send(
        "<h2>✅ WhatsApp já está conectado.</h2>"
      );

  }

  if (!ultimoQR) {

    return res
      .type("text/html")
      .send(
        "<h2>⏳ Nenhum QR disponível ainda.</h2>"
      );

  }

  try {

    const png =
      await qrcodePng.toBuffer(
        ultimoQR,
        {
          width: 320,
          margin: 2
        }
      );

    res
      .type("image/png")
      .send(png);

  } catch {

    res
      .status(500)
      .send(
        "Falha ao gerar QR code."
      );

  }

});

// =========================
// GRUPOS
// =========================

app.get("/grupos", async (req, res) => {

  if (!conectado || !sock) {

    return res
      .status(503)
      .json({
        erro:
          "WhatsApp não está conectado ainda."
      });

  }

  try {

    const grupos =
      await sock.groupFetchAllParticipating();

    const lista =
      Object.entries(grupos)
        .map(
          ([id, grupo]) => ({
            id,
            nome: grupo.subject
          })
        );

    res.json({
      grupos: lista
    });

  } catch {

    res
      .status(500)
      .json({
        erro:
          "Falha ao listar grupos."
      });

  }

});

// =========================
// ENVIAR
// =========================

app.post("/send", async (req, res) => {

  const {
    group_id,
    message,
    image_url
  } = req.body || {};

  if (!group_id || !message) {

    return res
      .status(400)
      .json({
        erro:
          "Campos obrigatórios: group_id e message."
      });

  }

  if (!conectado || !sock) {

    return res
      .status(503)
      .json({
        erro:
          "WhatsApp não está conectado ainda."
      });

  }

  try {

    if (image_url) {

      await sock.sendMessage(
        group_id,
        {
          image: {
            url: image_url
          },

          caption: message
        }
      );

    } else {

      await sock.sendMessage(
        group_id,
        {
          text: message
        }
      );

    }

    res.json({
      ok: true
    });

  } catch (erro) {

    // Log curto, somente quando realmente
    // houver tentativa de envio que falhou.
    console.log(
      "⚠️ Falha ao enviar mensagem."
    );

    res
      .status(500)
      .json({
        erro:
          "Falha ao enviar mensagem."
      });

  }

});

// ============================================================
// SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(
    `🚀 Servidor iniciado na porta ${PORT}`
  );
});

// ============================================================
// SHUTDOWN
// ============================================================

async function shutdown() {

  clearTimeout(backupTimer);
  clearTimeout(reconexaoTimer);

  try {
    await salvarSessaoNoSupabase();
  } catch {}

  process.exit(0);
}

process.once(
  "SIGTERM",
  shutdown
);

process.once(
  "SIGINT",
  shutdown
);

// ============================================================
// INICIALIZAÇÃO
// ============================================================

(async () => {

  try {

    const restaurada =
      await restaurarSessaoDoSupabase();

    if (restaurada) {
      console.log(
        "🔄 Sessão do WhatsApp restaurada."
      );
    } else {
      console.log(
        "📱 Nenhuma sessão salva. Aguardando QR."
      );
    }

    await conectar();

    // Backup periódico.
    setInterval(
      salvarSessaoNoSupabase,
      60000
    ).unref();

  } catch {

    console.log(
      "⚠️ Falha na inicialização. Tentando novamente..."
    );

    agendarReconexao();

  }

})();
