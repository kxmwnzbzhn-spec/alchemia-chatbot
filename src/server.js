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

function formatOrder(o) {
  return {
    id: o.id, number: o.number, status: o.status, date_created: o.date_created,
    customer_name: `${o.billing.first_name} ${o.billing.last_name}`,
    customer_email: o.billing.email, customer_phone: o.billing.phone,
    total: o.total, currency: o.currency,
    items: o.line_items?.map(i => `${i.name} x${i.quantity}`).join(", "),
    shipping_method: o.shipping_lines?.[0]?.method_title, meta_data: o.meta_data
  };
}

async function getOrderByNumber(orderNumber) {
  try {
    const target = String(orderNumber).replace(/\D/g, "");
    const { data } = await woo.get("/orders", {
      params: { per_page: 20, orderby: "date", order: "desc" }
    });
    const match = data.find(o => String(o.number) === target || String(o.id) === target);
    if (!match) return null;
    return formatOrder(match);
  } catch (err) { console.error("[WOO ORDER]", err.message); return null; }
}

async function getOrdersByPhone(phone) {
  try {
    // Normalizar: quitar +52 o 52 al inicio para obtener número local de 10 dígitos
    const localPhone = phone.replace(/^\+?52/, "").slice(-10);
    const { data } = await woo.get("/orders", { params: { per_page: 50, orderby: "date", order: "desc" } });
    const matches = data.filter(o => {
      const bp = (o.billing.phone || "").replace(/\D/g, "").slice(-10);
      return bp === localPhone;
    });
    return matches.length ? matches.map(formatOrder) : null;
  } catch (err) { console.error("[WOO PHONE]", err.message); return null; }
}

// ── Buscar tracking en Envia usando historial de envíos ──
async function getTrackingFromEnvia(order) {
  try {
    // Envia API: GET /ship/ lista envíos recientes de la cuenta
    const { data } = await axios.get(
      'https://api.envia.com/ship/',
      {
        headers: {
          Authorization: `Bearer ${process.env.ENVIA_API_KEY}`,
          'Content-Type': 'application/json'
        },
        params: { limit: 50, status: 'delivered,transit,pending' }
      }
    );
    const shipments = data?.data || data || [];
    console.log('[ENVIA SHIPMENTS LIST] total:', shipments.length);

    // Normalizar teléfono del pedido para comparar
    const orderPhone = (order.customer_phone || '').replace(/\D/g, '').slice(-10);
    const orderName = (order.customer_name || '').toLowerCase().trim();
    const orderId = String(order.number || order.id);

    // Intentar match por prioridad
    let matched = null;

    // 1. Match exacto por referencia/número de pedido
    matched = shipments.find(s => {
      const ref = String(s.reference || s.order_id || s.externalId || '');
      return ref === orderId || ref.includes(orderId);
    });
    if (matched) console.log('[ENVIA MATCH] por referencia:', matched.trackingNumber || matched.tracking);

    // 2. Si no, match por teléfono del destinatario
    if (!matched && orderPhone) {
      matched = shipments.find(s => {
        const destPhone = (s.address_to?.phone || s.recipient?.phone || '').replace(/\D/g, '').slice(-10);
        return destPhone === orderPhone;
      });
      if (matched) console.log('[ENVIA MATCH] por teléfono:', matched.trackingNumber || matched.tracking);
    }

    // 3. Si no, match por nombre del destinatario
    if (!matched && orderName) {
      matched = shipments.find(s => {
        const destName = (s.address_to?.name || s.recipient?.name || '').toLowerCase().trim();
        return destName && orderName && destName.includes(orderName.split(' ')[0]);
      });
      if (matched) console.log('[ENVIA MATCH] por nombre:', matched.trackingNumber || matched.tracking);
    }

    if (!matched) {
      console.log('[ENVIA TRACK RESOLUTION] No se encontró envío para pedido', orderId);
      return { trackingNumber: null, trackUrl: null };
    }

    const trackingNumber = matched.trackingNumber || matched.tracking || matched.guide_number || null;
    const trackUrl = matched.trackUrl || matched.tracking_url || null;
    console.log('[ENVIA TRACK RESOLUTION] Match encontrado:', { trackingNumber, trackUrl });
    return { trackingNumber, trackUrl };
  } catch (e) {
    console.error('[ENVIA SHIPMENTS]', e.response?.status, e.response?.data || e.message);
    return { trackingNumber: null, trackUrl: null };
  }
}

async function getShipmentByOrderId(orderId) {
  try {
    const order = await getOrderByNumber(orderId);
    if (!order) return { order: null, shipment: null, trackingNumber: null };

    // Buscar el tracking en meta_data con múltiples posibles keys
    const trackingMeta = order.meta_data?.find(m =>
      ["_envia_tracking_number", "tracking_number", "_wc_shipment_tracking_number",
       "envia_tracking", "trackingNumber", "_envia_track_number", "envia_guia_tracking"].includes(m.key)
    );
    // Filtrar tracking falso (ej: ENV-4435-MEX generado como placeholder)
    const rawTracking = trackingMeta?.value || null;
    console.log('[ORDER TRACK META]', { orderId, trackingMeta: trackingMeta?.key, rawTracking });
    const isFakeTracking = rawTracking && /^ENV-\d+-MEX$/i.test(rawTracking);
    const trackingNumber = isFakeTracking ? null : rawTracking;
    if (isFakeTracking) {
      console.log('[ENVIA] Tracking placeholder detectado y descartado:', rawTracking);
    }

    let shipment = null;
    if (trackingNumber) {
      try {
        // Envia usa POST /ship/generaltrack/ con array trackingNumbers
        const { data } = await axios.post(
          'https://api.envia.com/ship/generaltrack/',
          { trackingNumbers: [String(trackingNumber)] },
          {
            headers: {
              Authorization: `Bearer ${process.env.ENVIA_API_KEY}`,
              'Content-Type': 'application/json'
            }
          }
        );
        console.log('[ENVIA TRACK RESPONSE]', JSON.stringify(data).slice(0, 500));
        shipment = data;
      } catch (e) {
        console.error('[ENVIA TRACK]', e.response?.data || e.message);
      }
    } else {
      console.log('[ENVIA] No tracking meta found for order', orderId, '| meta_data keys:', order.meta_data?.map(m => m.key));
      // Intentar obtener tracking desde la API de Envia usando historial de envíos
      const enviaResult = await getTrackingFromEnvia(order);
      if (enviaResult.trackingNumber) {
        try {
          const { data } = await axios.post(
            'https://api.envia.com/ship/generaltrack/',
            { trackingNumbers: [String(enviaResult.trackingNumber)] },
            {
              headers: {
                Authorization: `Bearer ${process.env.ENVIA_API_KEY}`,
                'Content-Type': 'application/json'
              }
            }
          );
          console.log('[ENVIA TRACK RESPONSE]', JSON.stringify(data).slice(0, 300));
          shipment = data;
        } catch (e) {
          console.error('[ENVIA TRACK]', e.response?.data || e.message);
        }
        return { order, shipment, trackingNumber: enviaResult.trackingNumber };
      }
    }

    return { order, shipment, trackingNumber };
  } catch (err) {
    console.error('[SHIPMENT]', err.message);
    return { order: null, shipment: null, trackingNumber: null };
  }
}


// ── Tools para Claude ──
const tools = [
  {
    name: "buscar_productos",
    description: "Busca perfumes y productos en The Alchemia Lab. Úsalo cuando el cliente pregunta por fragancias, precios, stock, notas olfativas o características.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"]
    }
  },
  {
    name: "consultar_pedido",
    description: "Consulta el estatus de pedido(s) y rastreo en Envía.com. Úsalo cuando el cliente menciona un número de pedido o pregunta por sus pedidos. Si no tiene número, usa telefono_cliente para buscar sus pedidos recientes.",
    input_schema: {
      type: "object",
      properties: {
        numero_pedido: { type: "string", description: "Número de pedido específico (ej: 1521)" },
        telefono_cliente: { type: "string", description: "Teléfono del cliente para buscar sus pedidos si no tiene número de pedido" }
      }
    }
  },
];

async function executeTool(name, input, session, phone) {
  if (name === "buscar_productos") {
    const productos = await searchProducts(input.query);
    if (!productos.length) return JSON.stringify({ resultado: "No encontré ese perfume. ¿Puedes describirlo diferente?" });
    return JSON.stringify({ productos });
  }
  if (name === "consultar_pedido") {
    const statusMap = {
      pending: "Pendiente de pago", processing: "En proceso", "on-hold": "En espera",
      completed: "Completado", cancelled: "Cancelado", refunded: "Reembolsado", failed: "Fallido"
    };

    // CASO 1: buscar por número de pedido específico
    if (input.numero_pedido) {
      const { order, shipment, trackingNumber } = await getShipmentByOrderId(input.numero_pedido);
      if (!order) return JSON.stringify({ resultado: `No encontré el pedido #${input.numero_pedido}. Verifica el número e intenta de nuevo.` });
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
          datos_envia: shipment ? (() => {
              const t = shipment.data?.[0] || shipment;
              return {
                estatus: t.status || t.statusCode || "Sin estado",
                descripcion: t.description || t.statusDescription || "Sin descripción",
                carrier: t.carrier || t.service || "Sin carrier",
                url_rastreo: t.trackUrl || t.url || null
              };
            })() : "Sin datos de Envía.com"
        } : { numero_rastreo: null, nota: "Pedido en preparación — sin rastreo aún." }
      });
    }

    // CASO 2: buscar por teléfono del cliente
    if (input.telefono_cliente) {
      const orders = await getOrdersByPhone(input.telefono_cliente);
      if (!orders || !orders.length) return JSON.stringify({ resultado: `No encontré pedidos asociados al teléfono ${input.telefono_cliente}.` });
      if (orders[0].customer_name && session) session.clientName = orders[0].customer_name;
      const topOrders = orders.slice(0, 3);
      const resumen = topOrders.map((o, i) => ({
        posicion: i + 1,
        numero: o.number,
        estatus: statusMap[o.status] || o.status,
        productos: o.items,
        total: `${o.total} ${o.currency}`,
        fecha: o.date_created.slice(0, 10)
      }));
      return JSON.stringify({ total_pedidos: orders.length, mostrando: topOrders.length, pedidos_recientes: resumen, pregunta: "¿Quieres ver el detalle de alguno?" });
    }

    // CASO 3: usar teléfono del remitente automáticamente
    const autoOrders = await getOrdersByPhone(phone);
    if (!autoOrders || !autoOrders.length)
      return JSON.stringify({ resultado: "No encontré pedidos asociados a tu número de WhatsApp. ¿Tienes el número de pedido?" });
    if (autoOrders[0].customer_name && session) session.clientName = autoOrders[0].customer_name;
    if (autoOrders.length === 1) {
      const o = autoOrders[0];
      return JSON.stringify({ pedido: { numero: o.number, estatus: statusMap[o.status] || o.status, productos: o.items, total: `${o.total} ${o.currency}`, fecha: o.date_created.slice(0, 10) } });
    }
    const autoTop = autoOrders.slice(0, 3);
    const autoResumen = autoTop.map((o, i) => ({
      posicion: i + 1,
      numero: o.number,
      estatus: statusMap[o.status] || o.status,
      productos: o.items,
      total: `${o.total} ${o.currency}`,
      fecha: o.date_created.slice(0, 10)
    }));
    return JSON.stringify({
      total_pedidos: autoOrders.length,
      mostrando: autoTop.length,
      pedidos_recientes: autoResumen,
      pregunta: "¿Quieres ver el detalle de alguno?"
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
- Si el cliente no tiene número de pedido pero quiere ver sus pedidos, llama a consultar_pedido SIN parámetros (ni numero_pedido ni telefono_cliente) — el sistema usará automáticamente el teléfono del remitente. NUNCA pidas el teléfono al cliente.
- Si hay varios pedidos, muestra el resumen de los más recientes y pregunta de cuál quiere detalle.
- Si hay problema grave (producto dañado, incorrecto, reembolso), responde: "He registrado tu caso para que nuestro equipo te contacte personalmente. 🌸"
- Destaca el número de rastreo con *número*.
- Si no hay rastreo, explica que el pedido está en preparación artesanal.
- Usa *negritas* para información importante, emojis con moderación.
- Respuestas cortas y directas — máximo 3-4 líneas por párrafo.
- Si preguntan por perfumes, destaca las notas olfativas, la inspiración mexicana y la duración.
- Cierra siempre con calidez: "¿En qué más te puedo ayudar? 🌿"
REGLA CRÍTICA — MÚLTIPLES PEDIDOS:
Cuando la herramienta consultar_pedido devuelva múltiples pedidos (array pedidos_recientes):
- Mostrar TODOS los pedidos recibidos (no solo el primero)
- Enumerarlos en formato lista
- No resumir a un solo pedido
- No seleccionar orders[0]
- No usar solo el primer resultado

Formato obligatorio cuando hay varios pedidos:
Encontré X pedidos asociados a tu número:
1. Pedido #ID — estado — total
2. Pedido #ID — estado — total
(continúa con todos los que vengan en el array)

Si solo hay uno, entonces mostrar solo ese.`;

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
    const cleanTo = String(to).replace(/\D/g, "").replace(/^521(\d{10})$/, "52$1"); // fix MX 521->52
    await axios.post(`https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      messaging_product: "whatsapp", to: cleanTo, type: "text", text: { body: text }
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" } });
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
