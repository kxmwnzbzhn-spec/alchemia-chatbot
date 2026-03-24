/**
 * ═══════════════════════════════════════════════════════
 * CHATBOT WHATSAPP — The Alchemia Lab
 * v2.0 — Soporte de Pedidos, Productos & Rastreo
 * ═══════════════════════════════════════════════════════
 */
require("dotenv").config();
const express = require("express");
const axios = require("axios");

const path = require("path");
const { registerIncident, resolveIncident, getTodayIncidents, detectIncidentType, extractOrderNumber, readData } = require("./incidents");
const { startScheduler, runDailyReport } = require("./scheduler");

const app = express();

// Llamada directa a Anthropic API via axios (sin SDK)
async function callClaude({ system, messages, tools, max_tokens = 1024 }) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  const body = { model: "claude-haiku-4-5", max_tokens, system, messages };
  if (tools && tools.length) body.tools = tools;
  const response = await axios.post('https://api.anthropic.com/v1/messages', body, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    timeout: 30000,
  });
  return response.data;
}



app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ── Sesiones por número de WhatsApp ──
const sessions = new Map();
function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, { history: [], lastActivity: Date.now(), contactCount: 0, knownOrder: null, clientName: null });
  }
  const s = sessions.get(phone);
  s.lastActivity = Date.now();
  return s;
}
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [p, s] of sessions.entries()) { if (s.lastActivity < cutoff) sessions.delete(p); }
}, 15 * 60 * 1000);

// ── WooCommerce (The Alchemia Lab) ──
const woo = axios.create({
  baseURL: `${process.env.WOO_URL}/wp-json/wc/v3`,
  auth: { username: process.env.WOO_KEY, password: process.env.WOO_SECRET },
});

async function searchProducts(query) {
  try {
    const { data } = await woo.get("/products", { params: { search: query, per_page: 5, status: "publish" } });
    return data.map(p => ({
      id: p.id, name: p.name, price: p.price, regular_price: p.regular_price,
      sale_price: p.sale_price, stock_status: p.stock_status, stock_quantity: p.stock_quantity,
      short_description: p.short_description?.replace(/<[^>]+>/g, "").trim(),
      categories: p.categories?.map(c => c.name).join(", "), permalink: p.permalink
    }));
  } catch (err) { console.error("[WOO]", err.message); return []; }
}

async function getOrderByNumber(orderNumber) {
  try {
    const { data } = await woo.get("/orders", { params: { number: orderNumber, per_page: 1 } });
    if (!data.length) return null;
    const o = data[0];
    return {
      id: o.id, number: o.number, status: o.status, date_created: o.date_created,
      customer_name: `${o.billing.first_name} ${o.billing.last_name}`,
      customer_email: o.billing.email, total: o.total, currency: o.currency,
      items: o.line_items?.map(i => `${i.name} x${i.quantity}`).join(", "),
      shipping_method: o.shipping_lines?.[0]?.method_title, meta_data: o.meta_data
    };
  } catch (err) { console.error("[WOO ORDER]", err.message); return null; }
}

async function getShipmentByOrderId(orderId) {
  try {
    const order = await getOrderByNumber(orderId);
    if (!order) return { order: null, shipment: null, trackingNumber: null };
    const trackingMeta = order.meta_data?.find(m =>
      ["_envia_tracking_number", "tracking_number", "_wc_shipment_tracking_number"].includes(m.key)
    );
    const trackingNumber = trackingMeta?.value || null;
    let shipment = null;
    if (trackingNumber) {
      try {
        const { data } = await axios.get(`https://api.envia.com/ship/tracking/${trackingNumber}`, {
          headers: { Authorization: `Bearer ${process.env.ENVIA_API_KEY}` }
        });
        shipment = data;
      } catch (e) { console.error("[ENVIA]", e.message); }
    }
    return { order, shipment, trackingNumber };
  } catch (err) { return { order: null, shipment: null, trackingNumber: null }; }
}

// ── Tools para Claude ──
const tools = [
  {
    name: "buscar_productos",
    description: "Busca perfumes y productos en The Alchemia Lab. Úsalo cuando el cliente pregunta por fragancias, precios, stock, notas olfativas o características.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
  },
  {
    name: "consultar_pedido",
    description: "Consulta el estatus de un pedido y su rastreo en Envía.com. Úsalo cuando el cliente menciona un número de pedido o problema de envío.",
    input_schema: { type: "object", properties: { numero_pedido: { type: "string" } }, required: ["numero_pedido"] }
  },
];

async function executeTool(name, input, session, phone) {
  if (name === "buscar_productos") {
    const productos = await searchProducts(input.query);
    if (!productos.length) return JSON.stringify({ resultado: "No encontré ese perfume. ¿Puedes describirlo diferente?" });
    return JSON.stringify({ productos });
  }
  if (name === "consultar_pedido") {
    const { order, shipment, trackingNumber } = await getShipmentByOrderId(input.numero_pedido);
    if (!order) return JSON.stringify({ resultado: `No encontré el pedido #${input.numero_pedido}. Verifica el número e intenta de nuevo.` });
    const statusMap = {
      pending: "Pendiente de pago", processing: "En proceso", "on-hold": "En espera",
      completed: "Completado", cancelled: "Cancelado", refunded: "Reembolsado", failed: "Fallido"
    };
    if (order.customer_name && session) session.clientName = order.customer_name;
    if (!trackingNumber && phone) registerIncident({ phone, orderNumber: input.numero_pedido, type: "SIN_RASTREO", detail: "Sin número de rastreo.", clientName: session?.clientName });
    if (["cancelled", "on-hold", "failed"].includes(order.status) && phone) {
      registerIncident({ phone, orderNumber: input.numero_pedido, type: "CANCELADO", detail: `Estatus: ${statusMap[order.status]}`, clientName: session?.clientName });
    }
    return JSON.stringify({
      pedido: {
        numero: order.number, estatus_woo: statusMap[order.status] || order.status,
        cliente: order.customer_name, productos: order.items,
        total: `${order.total} ${order.currency}`, metodo_envio: order.shipping_method, fecha: order.date_created
      },
      envio: trackingNumber ? {
        numero_rastreo: trackingNumber,
        datos_envia: shipment ? { estatus: shipment.status || shipment.data?.status, descripcion: shipment.description || shipment.data?.description, carrier: shipment.carrier || shipment.data?.carrier } : "Sin datos de Envía.com"
      } : { numero_rastreo: null, nota: "Pedido en preparación — sin rastreo aún." }
    });
  }
}

async function detectAndRegisterIncident(phone, message, session) {
  const incidentType = detectIncidentType(message);
  const orderNumber = extractOrderNumber(message) || session.knownOrder;
  session.contactCount += 1;
  if (session.contactCount >= 2 && orderNumber) {
    registerIncident({ phone, orderNumber, type: "REINCIDENTE", detail: `Ha contactado ${session.contactCount} veces.`, clientName: session.clientName });
  }
  if (incidentType) {
    registerIncident({ phone, orderNumber: orderNumber || "PENDIENTE", type: incidentType, detail: message.slice(0, 200), clientName: session.clientName });
    return true;
  }
  return false;
}

const SYSTEM_PROMPT = `Eres *Alma*, la asistente virtual de *The Alchemia Lab* — perfumería de autor mexicana.
Eres elegante, cálida y conocedora del mundo de la perfumería artesanal.
Siempre respondes en español, de forma concisa y escaneables para WhatsApp.

CAPACIDADES:
1. Consultar pedidos y rastreo (herramienta: consultar_pedido)
2. Buscar perfumes: precios, stock, notas olfativas (herramienta: buscar_productos)

REGLAS:
- Si el cliente menciona un número de pedido, SIEMPRE usa consultar_pedido inmediatamente.
- Si hay problema grave (producto dañado, incorrecto, reembolso), responde: "He registrado tu caso para que nuestro equipo te contacte personalmente. 🌸"
- Destaca el número de rastreo con *número*.
- Si no hay rastreo, explica que el pedido está en preparación artesanal.
- Usa *negritas* para información importante, emojis con moderación.
- Respuestas cortas y directas — máximo 3-4 líneas por párrafo.
- Si preguntan por perfumes, destaca las notas olfativas, la inspiración mexicana y la duración.
- Cierra siempre con calidez: "¿En qué más te puedo ayudar? 🌿"`;

async function processMessage(phone, userMessage) {
  const session = getSession(phone);
  await detectAndRegisterIncident(phone, userMessage, session);
  const mentionedOrder = extractOrderNumber(userMessage);
  if (mentionedOrder) session.knownOrder = mentionedOrder;
  session.history.push({ role: "user", content: userMessage });
  if (session.history.length > 20) session.history = session.history.slice(-20);
  let messages = [...session.history];
  let finalResponse = "";
  for (let i = 0; i < 5; i++) {
    const response = await callClaude({
      system: SYSTEM_PROMPT, tools, messages
    });
    if (response.stop_reason === "end_turn") {
      finalResponse = response.content.filter(b => b.type === "text").map(b => b.text).join("");
      break;
    }
    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          console.log(`[TOOL] ${block.name}`, block.input);
          const result = await executeTool(block.name, block.input, session, phone);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }
      messages.push({ role: "user", content: toolResults });
    }
  }
  if (finalResponse) session.history.push({ role: "assistant", content: finalResponse });
  return finalResponse || "Lo siento, no pude procesar tu mensaje. Intenta de nuevo 🌿";
}

// ── Webhook WhatsApp ──
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === (process.env.WHATSAPP_VERIFY_TOKEN || "alchemia2024")) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message?.type === "text") {
      const phone = message.from;
      const text = message.text.body;
      console.log(`[MSG IN] ${phone}: ${text}`);
      res.sendStatus(200);
      const reply = await processMessage(phone, text);
      await sendWhatsAppMessage(phone, reply);
      return;
    }
    res.sendStatus(200);
  } catch (err) { console.error("[WEBHOOK ERROR]", err); res.sendStatus(500); }
});

async function sendWhatsAppMessage(to, text) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      messaging_product: "whatsapp", to, type: "text", text: { body: text }
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
  } catch (err) { console.error("[WA SEND]", err.response?.data || err.message); }
}

// ── API Panel ──
app.post("/api/demo/chat", async (req, res) => {
  try {
    const { phone = "demo_user", message } = req.body;
    if (!message) return res.status(400).json({ error: "Mensaje requerido" });
    const reply = await processMessage(phone, message);
    res.json({ reply });
  } catch (err) { 
    console.error('[DEMO CHAT ERROR]', err.message, err.status);
    res.status(500).json({ error: err.message, type: err.constructor.name }); 
  }
});

app.get("/api/diagnostics", async (req, res) => {
  const results = {};
  try {
    const https = require('https');
    await new Promise((resolve) => {
      const r = https.get('https://api.anthropic.com', (resp) => { results.anthropic_reach = `HTTP ${resp.statusCode}`; resolve(); });
      r.on('error', (e) => { results.anthropic_reach = `ERROR: ${e.message}`; resolve(); });
      r.setTimeout(5000, () => { results.anthropic_reach = 'TIMEOUT'; r.destroy(); resolve(); });
    });
  } catch(e) { results.anthropic_reach = `EXCEPTION: ${e.message}`; }
  const key = process.env.ANTHROPIC_API_KEY || '';
  results.key_prefix = key ? key.substring(0,15) + '...' : 'NOT SET';
  results.key_length = key.length;
  results.key_has_spaces = key !== key.trim();
  results.model = "claude-sonnet-4-5";
  res.json(results);
});

app.get("/api/incidents", (req, res) => {
  const incidents = getTodayIncidents();
  res.json({ incidents, total: incidents.length });
});

app.get("/api/incidents/all", (req, res) => {
  const data = readData();
  let incidents = data.incidents || [];
  if (req.query.date) incidents = incidents.filter(i => i.date === req.query.date);
  if (req.query.status) incidents = incidents.filter(i => i.status === req.query.status);
  res.json({ incidents, total: incidents.length, lastReport: data.lastReport });
});

app.patch("/api/incidents/:id/resolve", (req, res) => {
  const ok = resolveIncident(req.params.id);
  res.json({ ok });
});

app.post("/api/report/send", async (req, res) => {
  try {
    const result = await runDailyReport();
    res.json({ ok: true, total: result.incidents.length, sentWhatsApp: result.waOk, sentEmail: result.emailOk });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete("/api/demo/session/:phone", (req, res) => {
  sessions.delete(req.params.phone);
  res.json({ ok: true });
});

app.get("/api/health", (req, res) => {
  const data = readData();
  res.json({
    status: "ok", sessions: sessions.size,
    todayIncidents: getTodayIncidents().length, lastReport: data.lastReport,
    env: {
      claude: !!process.env.ANTHROPIC_API_KEY, woocommerce: !!process.env.WOO_KEY,
      envia: !!process.env.ENVIA_API_KEY, whatsapp: !!process.env.WHATSAPP_TOKEN,
      adminPhone: !!process.env.ADMIN_WHATSAPP_PHONE
    }
  });
});

startScheduler();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  🌿 The Alchemia Lab — Chatbot WA v2.0   ║`);
  console.log(`║  Puerto: ${PORT}                              ║`);
  console.log(`║  Panel: http://localhost:${PORT}              ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
