/**
 * ═══════════════════════════════════════════════════════
 * CHATBOT WHATSAPP — The Alchemia Lab
 * v2.1 — Productos con link directo de compra + alternativas si agotado
 * ═══════════════════════════════════════════════════════
 *
 * Cambios v2.1 (Fase A + Fase B):
 * - searchProducts ahora devuelve image_url y stock real.
 * - Nueva tool obtener_detalle_producto (ficha completa por id/slug).
 * - Búsqueda fallback por categoría/tag cuando ?search= no devuelve nada.
 * - findAlternatives: si todos los matches están agotados, sugiere similares en stock.
 * - sendWhatsAppProductMessage: envío de imagen + caption + link.
 * - SYSTEM_PROMPT ahora exige incluir el permalink del Woo (link de compra) en cada respuesta.
 * - Productos agotados se muestran con etiqueta "AGOTADO" + sugerencia.
 * - Fix extractOrderNumber: requiere contexto (#, "pedido", "orden").
 * - Verificación HMAC opcional del webhook (X-Hub-Signature-256).
 * - /api/diagnostics reporta el modelo real.
 */
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");
const crypto = require("crypto");
const { registerIncident, resolveIncident, getTodayIncidents, detectIncidentType, extractOrderNumber, readData } = require("./incidents");
const { startScheduler, runDailyReport } = require("./scheduler");

const app = express();

// ── Constantes ──
const CLAUDE_MODEL = "claude-haiku-4-5";
const WOO_PUBLIC_BASE = (process.env.WOO_URL || "https://thealchemialab.com").replace(/\/$/, "");

// ── Llamada directa a Anthropic ──
async function callClaude({ system, messages, tools, max_tokens = 1024 }) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  const body = { model: CLAUDE_MODEL, max_tokens, system, messages };
  if (tools && tools.length) body.tools = tools;
  const response = await axios.post("https://api.anthropic.com/v1/messages", body, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    timeout: 30000,
  });
  return response.data;
}

// ── Body parser que conserva raw body para HMAC del webhook ──
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.static(path.join(__dirname, "../public")));

// ── Sesiones por número de WhatsApp ──
const sessions = new Map();
function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      history: [],
      lastActivity: Date.now(),
      contactCount: 0,
      knownOrder: null,
      clientName: null,
      lastShownProducts: [], // para "el primero", "más info del último"
    });
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
  baseURL: `${WOO_PUBLIC_BASE}/wp-json/wc/v3`,
  auth: { username: process.env.WOO_KEY, password: process.env.WOO_SECRET },
  timeout: 15000,
});

// Cache simple de productos (TTL 10 min) para reducir round-trips
const productCache = { byId: new Map(), bySlug: new Map(), byTermAt: new Map() };
const CACHE_TTL = 10 * 60 * 1000;

function mapProduct(p) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    price: p.price,
    regular_price: p.regular_price,
    sale_price: p.sale_price,
    on_sale: !!p.on_sale,
    stock_status: p.stock_status,           // "instock" | "outofstock" | "onbackorder"
    stock_quantity: p.stock_quantity,
    short_description: (p.short_description || "").replace(/<[^>]+>/g, "").trim(),
    description: (p.description || "").replace(/<[^>]+>/g, "").trim().slice(0, 600),
    categories: (p.categories || []).map(c => c.name),
    tags: (p.tags || []).map(t => t.name),
    image_url: p.images?.[0]?.src || null,
    permalink: p.permalink,                 // ← LINK DE COMPRA
  };
}

async function searchProducts(query, { includeOutOfStock = true, perPage = 5 } = {}) {
  const cacheKey = `q:${query}:${includeOutOfStock}:${perPage}`;
  const cached = productCache.byTermAt.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data;

  let results = [];
  try {
    // 1) Búsqueda literal
    const { data } = await woo.get("/products", {
      params: { search: query, per_page: perPage, status: "publish" }
    });
    results = data.map(mapProduct);

    // 2) Fallback: si no hay nada, intentar buscar por TAG (notas olfativas, familias)
    if (!results.length) {
      const tagsResp = await woo.get("/products/tags", { params: { search: query, per_page: 5 } });
      if (tagsResp.data?.length) {
        const tagIds = tagsResp.data.map(t => t.id).join(",");
        const byTag = await woo.get("/products", {
          params: { tag: tagIds, per_page: perPage, status: "publish" }
        });
        results = byTag.data.map(mapProduct);
      }
    }

    // 3) Fallback: por CATEGORÍA
    if (!results.length) {
      const catResp = await woo.get("/products/categories", { params: { search: query, per_page: 5 } });
      if (catResp.data?.length) {
        const catIds = catResp.data.map(c => c.id).join(",");
        const byCat = await woo.get("/products", {
          params: { category: catIds, per_page: perPage, status: "publish" }
        });
        results = byCat.data.map(mapProduct);
      }
    }
  } catch (err) {
    console.error("[WOO SEARCH]", err.message);
    return [];
  }

  // Cachear
  results.forEach(p => {
    productCache.byId.set(p.id, { data: p, at: Date.now() });
    productCache.bySlug.set(p.slug, { data: p, at: Date.now() });
  });
  productCache.byTermAt.set(cacheKey, { data: results, at: Date.now() });
  return results;
}

async function getProductByIdOrSlug(idOrSlug) {
  // Cache hit
  const cKey = String(idOrSlug);
  const byIdHit = productCache.byId.get(Number(cKey));
  if (byIdHit && Date.now() - byIdHit.at < CACHE_TTL) return byIdHit.data;
  const bySlugHit = productCache.bySlug.get(cKey);
  if (bySlugHit && Date.now() - bySlugHit.at < CACHE_TTL) return bySlugHit.data;

  try {
    if (/^\d+$/.test(cKey)) {
      const { data } = await woo.get(`/products/${cKey}`);
      const p = mapProduct(data);
      productCache.byId.set(p.id, { data: p, at: Date.now() });
      productCache.bySlug.set(p.slug, { data: p, at: Date.now() });
      return p;
    }
    const { data } = await woo.get("/products", { params: { slug: cKey, per_page: 1 } });
    if (!data?.length) return null;
    const p = mapProduct(data[0]);
    productCache.byId.set(p.id, { data: p, at: Date.now() });
    productCache.bySlug.set(p.slug, { data: p, at: Date.now() });
    return p;
  } catch (err) {
    console.error("[WOO DETAIL]", err.message);
    return null;
  }
}

// Si el producto está agotado, sugerir alternativas en stock por overlap de tags/categorías
async function findAlternatives(product, max = 2) {
  if (!product) return [];
  try {
    const tagNames = product.tags || [];
    const cats = product.categories || [];
    const params = { per_page: 10, status: "publish", stock_status: "instock" };
    let pool = [];

    // por tag
    if (tagNames.length) {
      const tagsResp = await woo.get("/products/tags", { params: { search: tagNames[0], per_page: 3 } });
      if (tagsResp.data?.length) {
        const { data } = await woo.get("/products", { params: { ...params, tag: tagsResp.data.map(t => t.id).join(",") } });
        pool = pool.concat(data.map(mapProduct));
      }
    }
    // por categoría
    if (!pool.length && cats.length) {
      const catResp = await woo.get("/products/categories", { params: { search: cats[0], per_page: 3 } });
      if (catResp.data?.length) {
        const { data } = await woo.get("/products", { params: { ...params, category: catResp.data.map(c => c.id).join(",") } });
        pool = pool.concat(data.map(mapProduct));
      }
    }

    // Excluir el mismo producto, dedupe, solo en stock
    const seen = new Set([product.id]);
    return pool
      .filter(p => p.stock_status === "instock" && !seen.has(p.id) && (seen.add(p.id), true))
      .slice(0, max);
  } catch (err) {
    console.error("[ALT]", err.message);
    return [];
  }
}

// ── Pedidos & Envia ─────────────────────────────────────
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
    const { data } = await woo.get("/orders", { params: { per_page: 20, orderby: "date", order: "desc" } });
    const match = data.find(o => String(o.number) === target || String(o.id) === target);
    if (!match) return null;
    return formatOrder(match);
  } catch (err) { console.error("[WOO ORDER]", err.message); return null; }
}

async function getOrdersByPhone(phone) {
  try {
    const localPhone = phone.replace(/^\+?52/, "").slice(-10);
    const { data } = await woo.get("/orders", { params: { per_page: 50, orderby: "date", order: "desc" } });
    const matches = data.filter(o => {
      const bp = (o.billing.phone || "").replace(/\D/g, "").slice(-10);
      return bp === localPhone;
    });
    return matches.length ? matches.map(formatOrder) : null;
  } catch (err) { console.error("[WOO PHONE]", err.message); return null; }
}

async function getTrackingFromEnvia(order) {
  try {
    const { data } = await axios.get("https://api.envia.com/ship/", {
      headers: { Authorization: `Bearer ${process.env.ENVIA_API_KEY}`, "Content-Type": "application/json" },
      params: { limit: 50, status: "delivered,transit,pending" }
    });
    const shipments = data?.data || data || [];
    const orderPhone = (order.customer_phone || "").replace(/\D/g, "").slice(-10);
    const orderName = (order.customer_name || "").toLowerCase().trim();
    const orderId = String(order.number || order.id);

    let matched = shipments.find(s => {
      const ref = String(s.reference || s.order_id || s.externalId || "");
      return ref === orderId || ref.includes(orderId);
    });
    if (!matched && orderPhone) {
      matched = shipments.find(s => {
        const dp = (s.address_to?.phone || s.recipient?.phone || "").replace(/\D/g, "").slice(-10);
        return dp === orderPhone;
      });
    }
    if (!matched && orderName) {
      matched = shipments.find(s => {
        const dn = (s.address_to?.name || s.recipient?.name || "").toLowerCase().trim();
        return dn && dn.includes(orderName.split(" ")[0]);
      });
    }
    if (!matched) return { trackingNumber: null, trackUrl: null };
    return {
      trackingNumber: matched.trackingNumber || matched.tracking || matched.guide_number || null,
      trackUrl: matched.trackUrl || matched.tracking_url || null,
    };
  } catch (e) {
    console.error("[ENVIA SHIPMENTS]", e.response?.status, e.response?.data || e.message);
    return { trackingNumber: null, trackUrl: null };
  }
}

async function getShipmentByOrderId(orderId) {
  try {
    const order = await getOrderByNumber(orderId);
    if (!order) return { order: null, shipment: null, trackingNumber: null };

    const trackingMeta = order.meta_data?.find(m => [
      "_envia_tracking_number", "tracking_number", "_wc_shipment_tracking_number",
      "envia_tracking", "trackingNumber", "_envia_track_number", "envia_guia_tracking"
    ].includes(m.key));
    const rawTracking = trackingMeta?.value || null;
    const isFakeTracking = rawTracking && /^ENV-\d+-MEX$/i.test(rawTracking);
    const trackingNumber = isFakeTracking ? null : rawTracking;

    let shipment = null;
    if (trackingNumber) {
      try {
        const { data } = await axios.post("https://api.envia.com/ship/generaltrack/",
          { trackingNumbers: [String(trackingNumber)] },
          { headers: { Authorization: `Bearer ${process.env.ENVIA_API_KEY}`, "Content-Type": "application/json" } });
        shipment = data;
      } catch (e) { console.error("[ENVIA TRACK]", e.response?.data || e.message); }
    } else {
      const enviaResult = await getTrackingFromEnvia(order);
      if (enviaResult.trackingNumber) {
        try {
          const { data } = await axios.post("https://api.envia.com/ship/generaltrack/",
            { trackingNumbers: [String(enviaResult.trackingNumber)] },
            { headers: { Authorization: `Bearer ${process.env.ENVIA_API_KEY}`, "Content-Type": "application/json" } });
          shipment = data;
        } catch (e) { console.error("[ENVIA TRACK]", e.response?.data || e.message); }
        return { order, shipment, trackingNumber: enviaResult.trackingNumber };
      }
    }
    return { order, shipment, trackingNumber };
  } catch (err) {
    console.error("[SHIPMENT]", err.message);
    return { order: null, shipment: null, trackingNumber: null };
  }
}

// ── Tools para Claude ──
const tools = [
  {
    name: "buscar_productos",
    description: "Busca perfumes en The Alchemia Lab por nombre, notas olfativas, familia (amaderado, floral, oud, acuático, oriental, etc.) o categoría (mujer, hombre, unisex). Devuelve nombre, precio, disponibilidad, descripción corta, imagen y permalink (URL de compra). Si un perfume está agotado, devuelve también 'alternativas' en stock similares.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto libre: nombre del perfume o descripción olfativa." }
      },
      required: ["query"]
    }
  },
  {
    name: "obtener_detalle_producto",
    description: "Devuelve la ficha completa de un perfume específico (notas de salida/corazón/fondo, descripción larga, imagen, link de compra). Úsalo cuando el cliente pide más información de un producto que ya se mencionó, o dice 'el primero', 'el de hasta arriba', 'el Xibalba', etc. Acepta el id numérico o el slug del producto.",
    input_schema: {
      type: "object",
      properties: {
        id_o_slug: { type: "string", description: "ID numérico o slug del producto (ej: 4934 o 'cenote-azul-eau-de-parfum')." }
      },
      required: ["id_o_slug"]
    }
  },
  {
    name: "consultar_pedido",
    description: "Consulta el estatus de pedido(s) y rastreo en Envía.com. Úsalo cuando el cliente menciona un número de pedido o pregunta por sus pedidos.",
    input_schema: {
      type: "object",
      properties: {
        numero_pedido: { type: "string", description: "Número de pedido (ej: 1521)" },
        telefono_cliente: { type: "string", description: "Teléfono para buscar pedidos si no hay número" }
      }
    }
  },
];

async function executeTool(name, input, session, phone) {
  if (name === "buscar_productos") {
    const productos = await searchProducts(input.query);
    if (!productos.length) {
      return JSON.stringify({ resultado: "No encontré ese perfume. ¿Puedes describirlo diferente (notas, familia, ocasión)?" });
    }

    // Recordar lo mostrado para "el primero", "más info del último"
    if (session) session.lastShownProducts = productos.map(p => ({ id: p.id, slug: p.slug, name: p.name }));

    // Adjuntar alternativas si hay agotados
    const enriched = await Promise.all(productos.map(async (p) => {
      const base = {
        id: p.id, name: p.name, slug: p.slug,
        precio: p.price ? `$${p.price} MXN` : null,
        precio_regular: p.regular_price ? `$${p.regular_price} MXN` : null,
        en_oferta: p.on_sale,
        disponibilidad: p.stock_status === "instock"
          ? "EN STOCK"
          : (p.stock_status === "onbackorder" ? "POR PEDIDO" : "AGOTADO"),
        descripcion: p.short_description,
        notas: p.tags,
        imagen: p.image_url,
        link_compra: p.permalink,        // ← Permalink Woo
      };
      if (p.stock_status !== "instock") {
        const alts = await findAlternatives(p, 2);
        base.alternativas_en_stock = alts.map(a => ({
          name: a.name, precio: a.price ? `$${a.price} MXN` : null, link_compra: a.permalink
        }));
      }
      return base;
    }));

    return JSON.stringify({ productos: enriched });
  }

  if (name === "obtener_detalle_producto") {
    const p = await getProductByIdOrSlug(input.id_o_slug);
    if (!p) return JSON.stringify({ resultado: `No encontré el producto ${input.id_o_slug}.` });
    const out = {
      id: p.id, name: p.name, slug: p.slug,
      precio: p.price ? `$${p.price} MXN` : null,
      precio_regular: p.regular_price ? `$${p.regular_price} MXN` : null,
      en_oferta: p.on_sale,
      disponibilidad: p.stock_status === "instock"
        ? "EN STOCK"
        : (p.stock_status === "onbackorder" ? "POR PEDIDO" : "AGOTADO"),
      descripcion_corta: p.short_description,
      descripcion: p.description,
      notas: p.tags,
      categorias: p.categories,
      imagen: p.image_url,
      link_compra: p.permalink,
    };
    if (p.stock_status !== "instock") {
      const alts = await findAlternatives(p, 2);
      out.alternativas_en_stock = alts.map(a => ({
        name: a.name, precio: a.price ? `$${a.price} MXN` : null, link_compra: a.permalink
      }));
    }
    return JSON.stringify({ producto: out });
  }

  if (name === "consultar_pedido") {
    const statusMap = {
      pending: "Pendiente de pago", processing: "En proceso", "on-hold": "En espera",
      completed: "Completado", cancelled: "Cancelado", refunded: "Reembolsado", failed: "Fallido"
    };

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

    if (input.telefono_cliente) {
      const orders = await getOrdersByPhone(input.telefono_cliente);
      if (!orders || !orders.length) return JSON.stringify({ resultado: `No encontré pedidos asociados al teléfono ${input.telefono_cliente}.` });
      if (orders[0].customer_name && session) session.clientName = orders[0].customer_name;
      const topOrders = orders.slice(0, 3);
      return JSON.stringify({
        total_pedidos: orders.length,
        mostrando: topOrders.length,
        pedidos_recientes: topOrders.map((o, i) => ({
          posicion: i + 1, numero: o.number, estatus: statusMap[o.status] || o.status,
          productos: o.items, total: `${o.total} ${o.currency}`, fecha: o.date_created.slice(0, 10)
        })),
        pregunta: "¿Quieres ver el detalle de alguno?"
      });
    }

    const autoOrders = await getOrdersByPhone(phone);
    if (!autoOrders || !autoOrders.length)
      return JSON.stringify({ resultado: "No encontré pedidos asociados a tu número de WhatsApp. ¿Tienes el número de pedido?" });
    if (autoOrders[0].customer_name && session) session.clientName = autoOrders[0].customer_name;
    if (autoOrders.length === 1) {
      const o = autoOrders[0];
      return JSON.stringify({ pedido: { numero: o.number, estatus: statusMap[o.status] || o.status, productos: o.items, total: `${o.total} ${o.currency}`, fecha: o.date_created.slice(0, 10) } });
    }
    const autoTop = autoOrders.slice(0, 3);
    return JSON.stringify({
      total_pedidos: autoOrders.length,
      mostrando: autoTop.length,
      pedidos_recientes: autoTop.map((o, i) => ({
        posicion: i + 1, numero: o.number, estatus: statusMap[o.status] || o.status,
        productos: o.items, total: `${o.total} ${o.currency}`, fecha: o.date_created.slice(0, 10)
      })),
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
Siempre respondes en español, de forma concisa y escaneable para WhatsApp.

CAPACIDADES:
1. Buscar perfumes (herramienta: buscar_productos)
2. Ficha detallada de un perfume (herramienta: obtener_detalle_producto) — úsala cuando el cliente quiere más info, dice "el primero", "el Xibalba", etc.
3. Consultar pedidos y rastreo (herramienta: consultar_pedido)

═══════════════════════════════════════════════════
REGLA CRÍTICA — INFORMACIÓN DE PRODUCTO  ⚠️ OBLIGATORIA
═══════════════════════════════════════════════════
Cuando la herramienta buscar_productos u obtener_detalle_producto devuelva
productos, SIEMPRE incluye en tu respuesta, por cada perfume mencionado:

1. *Nombre* del perfume en negritas.
2. Precio en MXN. Si "en_oferta" es true, indica precio con descuento y tacha el regular.
3. Disponibilidad — solo menciónala si el campo "disponibilidad" NO es "EN STOCK".
   - Si dice "AGOTADO": añade "❌ Agotado por ahora" y sugiere las "alternativas_en_stock" que vengan en el JSON.
   - Si dice "POR PEDIDO": añade "📦 Disponible por pedido — pregúntame por tiempos".
4. 1-2 líneas con notas olfativas o inspiración (campo "descripcion").
5. 🛒 Link de compra: usa EXACTAMENTE el valor del campo "link_compra" tal cual viene
   del JSON. NUNCA inventes URLs, NUNCA acortes el link, NUNCA uses
   thealchemialab.com/shop u otra URL genérica.

Formato recomendado para WhatsApp (UN producto):

*Cenote Azul* — Eau de Parfum 100 ml
💰 $499 MXN
🌿 Bergamota, jazmín de agua y cedro blanco. Inspirado en los cenotes mexicanos.
🛒 https://thealchemialab.com/product/cenote-azul-eau-de-parfum/

Formato cuando son VARIOS productos:
1. *Nombre* — $XXX MXN — 1 línea — 🛒 link
2. *Nombre* — $XXX MXN — 1 línea — 🛒 link
(uno por línea, máximo 3-4)

Cuando un producto está AGOTADO:
"❌ *Xibalba Royal* está agotado por ahora.
Te recomiendo opciones similares en stock:
1. *Nombre alternativa* — $XXX MXN — 🛒 link
2. *Nombre alternativa* — $XXX MXN — 🛒 link"

═══════════════════════════════════════════════════
REGLA — MÚLTIPLES PEDIDOS:
═══════════════════════════════════════════════════
Cuando consultar_pedido devuelva varios pedidos (array pedidos_recientes):
- Mostrar TODOS, enumerados.
- No resumir al primero.

Formato:
Encontré X pedidos asociados a tu número:
1. Pedido #ID — estado — total
2. Pedido #ID — estado — total

═══════════════════════════════════════════════════
OTRAS REGLAS:
═══════════════════════════════════════════════════
- Si el cliente menciona un número de pedido (ej. "pedido #1521"), usa consultar_pedido inmediatamente.
- Si no tiene número y quiere ver sus pedidos, llama a consultar_pedido SIN parámetros (el sistema usa el teléfono del remitente). NUNCA pidas el teléfono.
- Si hay problema grave (producto dañado, incorrecto, reembolso), responde:
  "He registrado tu caso para que nuestro equipo te contacte personalmente. 🌸"
- Destaca el número de rastreo con *negritas*.
- Usa *negritas* para info importante; emojis con moderación.
- Respuestas cortas — máximo 4 líneas por párrafo.
- Cierra con calidez: "¿En qué más te puedo ayudar? 🌿"`;

async function processMessage(phone, userMessage) {
  const session = getSession(phone);
  await detectAndRegisterIncident(phone, userMessage, session);
  const mentionedOrder = extractOrderNumber(userMessage);
  if (mentionedOrder) session.knownOrder = mentionedOrder;
  session.history.push({ role: "user", content: userMessage });
  if (session.history.length > 20) session.history = session.history.slice(-20);

  let messages = [...session.history];
  let finalResponse = "";
  let lastProductImageMessage = null; // para mandar imagen separada si hay 1 solo

  for (let i = 0; i < 5; i++) {
    const response = await callClaude({ system: SYSTEM_PROMPT, tools, messages });
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

          // Si la tool devuelve UN solo producto, guardamos la imagen para mandarla aparte
          try {
            const parsed = JSON.parse(result);
            const single =
              (parsed.productos?.length === 1 && parsed.productos[0]) ||
              parsed.producto || null;
            if (single?.imagen && single?.link_compra) {
              lastProductImageMessage = { imageUrl: single.imagen, caption: `*${single.name}* — ${single.link_compra}` };
            }
          } catch (_) { /* ignore */ }
        }
      }
      messages.push({ role: "user", content: toolResults });
    }
  }
  if (finalResponse) session.history.push({ role: "assistant", content: finalResponse });
  return {
    text: finalResponse || "Lo siento, no pude procesar tu mensaje. Intenta de nuevo 🌿",
    productImage: lastProductImageMessage
  };
}

// ── HMAC opcional del webhook (Meta firma con WHATSAPP_APP_SECRET) ──
function verifyMetaSignature(req) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true; // si no hay secreto configurado, no validamos
  const sigHeader = req.headers["x-hub-signature-256"];
  if (!sigHeader || !req.rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected)); }
  catch { return false; }
}

// ── Webhook WhatsApp ──
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" &&
      req.query["hub.verify_token"] === (process.env.WHATSAPP_VERIFY_TOKEN || "alchemia2024")) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Meta requiere < 5s
  if (!verifyMetaSignature(req)) {
    console.warn("[WEBHOOK] firma inválida — ignorado");
    return;
  }
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message?.type === "text") {
      const phone = message.from;
      const text = message.text.body;
      console.log(`[MSG IN] ${phone}: ${text}`);
      const reply = await processMessage(phone, text);
      await sendWhatsAppMessage(phone, reply.text);
      if (reply.productImage) {
        await sendWhatsAppImage(phone, reply.productImage.imageUrl, reply.productImage.caption);
      }
      return;
    }
  } catch (err) { console.error("[WEBHOOK ERROR]", err); }
});

async function sendWhatsAppMessage(to, text) {
  try {
    const cleanTo = String(to).replace(/\D/g, "").replace(/^521(\d{10})$/, "52$1");
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    const response = await axios.post(`https://graph.facebook.com/v22.0/${phoneId}/messages`, {
      messaging_product: "whatsapp", to: cleanTo, type: "text", text: { body: text }
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" } });
    console.log(`[WA SEND] OK | msgId: ${response.data?.messages?.[0]?.id}`);
  } catch (err) { console.error("[WA SEND]", err.response?.data || err.message); }
}

async function sendWhatsAppImage(to, imageUrl, caption) {
  try {
    const cleanTo = String(to).replace(/\D/g, "").replace(/^521(\d{10})$/, "52$1");
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    const response = await axios.post(`https://graph.facebook.com/v22.0/${phoneId}/messages`, {
      messaging_product: "whatsapp", to: cleanTo, type: "image",
      image: { link: imageUrl, caption: caption?.slice(0, 1024) }
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" } });
    console.log(`[WA IMG] OK | msgId: ${response.data?.messages?.[0]?.id}`);
  } catch (err) { console.error("[WA IMG]", err.response?.data || err.message); }
}

// ── API Panel ──
app.post("/api/demo/chat", async (req, res) => {
  try {
    const { phone = "demo_user", message } = req.body;
    if (!message) return res.status(400).json({ error: "Mensaje requerido" });
    const reply = await processMessage(phone, message);
    res.json({ reply: reply.text, productImage: reply.productImage || null });
  } catch (err) {
    console.error("[DEMO CHAT ERROR]", err.message, err.status);
    res.status(500).json({ error: err.message, type: err.constructor.name });
  }
});

app.get("/api/diagnostics", async (req, res) => {
  const results = {};
  try {
    const https = require("https");
    await new Promise((resolve) => {
      const r = https.get("https://api.anthropic.com", (resp) => { results.anthropic_reach = `HTTP ${resp.statusCode}`; resolve(); });
      r.on("error", (e) => { results.anthropic_reach = `ERROR: ${e.message}`; resolve(); });
      r.setTimeout(5000, () => { results.anthropic_reach = "TIMEOUT"; r.destroy(); resolve(); });
    });
  } catch (e) { results.anthropic_reach = `EXCEPTION: ${e.message}`; }
  const key = process.env.ANTHROPIC_API_KEY || "";
  results.key_prefix = key ? key.substring(0, 15) + "..." : "NOT SET";
  results.key_length = key.length;
  results.key_has_spaces = key !== key.trim();
  results.model = CLAUDE_MODEL;
  results.woo_url = WOO_PUBLIC_BASE;
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
      adminPhone: !!process.env.ADMIN_WHATSAPP_PHONE,
      hmac: !!process.env.WHATSAPP_APP_SECRET
    }
  });
});

startScheduler();
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  🌿 The Alchemia Lab — Chatbot WA v2.1   ║`);
  console.log(`║  Puerto: ${PORT}                              ║`);
  console.log(`║  Modelo: ${CLAUDE_MODEL}              ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
