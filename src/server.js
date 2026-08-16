/**
 * ═══════════════════════════════════════════════════════
 * CHATBOT WHATSAPP — The Alchemia Lab
 * v2.2 — Productos con link directo + alternativas + FOLLOW-UPS para cerrar venta
 * ═══════════════════════════════════════════════════════
 *
 * NOVEDAD v2.2 (Sales Recovery):
 * - Follow-ups automáticos dentro de la ventana de 24h de WhatsApp.
 * - 1er msj: 2h sin respuesta + cupón único 15% (un solo uso, vence 48h).
 * - 2º msj: ~20h sin respuesta + última llamada con el mismo cupón.
 * - Cupón generado dinámicamente en WooCommerce por cliente (ALMA-XXXXXXXX).
 * - Cancela follow-up si:
 *     · Cliente ya compró (cross-check con WooCommerce por teléfono)
 *     · Cliente reportó queja (incidente abierto)
 *     · Cliente respondió "no", "después", "ya no" (rechazo)
 *     · Cliente respondió cualquier mensaje (reset del ciclo)
 * - Solo manda follow-up si Alma ya mostró al menos 1 producto.
 *
 * Cambios v2.1 previos: SYSTEM_PROMPT con regla de link, obtener_detalle_producto,
 * findAlternatives, fix nodemailer, fix extractOrderNumber, HMAC opcional, etc.
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
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const WOO_PUBLIC_BASE = (process.env.WOO_URL || "https://thealchemialab.com").replace(/\/$/, "");

// ── Config follow-ups ──
const FOLLOWUP_DISCOUNT_PCT = parseInt(process.env.FOLLOWUP_DISCOUNT_PERCENT || "15", 10);
const FOLLOWUP_FIRST_HOURS = parseFloat(process.env.FOLLOWUP_FIRST_HOURS || "2");
const FOLLOWUP_SECOND_HOURS = parseFloat(process.env.FOLLOWUP_SECOND_HOURS || "20");
const FOLLOWUP_COUPON_HOURS = parseInt(process.env.FOLLOWUP_COUPON_HOURS || "48", 10);
const FOLLOWUP_CYCLE_MIN = parseInt(process.env.FOLLOWUP_CYCLE_MIN || "5", 10);
const FOLLOWUP_ENABLED = String(process.env.FOLLOWUP_ENABLED || "true") === "true";

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
      lastUserMessageAt: Date.now(),
      contactCount: 0,
      knownOrder: null,
      clientName: null,
      lastShownProducts: [],     // para "el primero", "más info del último"
      followupsSent: 0,          // contador de follow-ups en este ciclo
      followupCancelled: false,  // si dijo no/después/etc, o ya compró, o tiene queja
      hasIncident: false,        // marcado al detectar incidente
      lastCouponCode: null,      // último cupón generado (para reusar en 2º msj)
      lastCouponExpiresAt: null,
    });
  }
  const s = sessions.get(phone);
  s.lastActivity = Date.now();
  return s;
}
function cleanupStaleSessions() {
  const cutoff = Date.now() - 26 * 60 * 60 * 1000; // limpiar sesiones más viejas de 26h (>ventana WA)
  for (const [p, s] of sessions.entries()) { if (s.lastActivity < cutoff) sessions.delete(p); }
}

// ── WooCommerce ──
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
    id: p.id, slug: p.slug, name: p.name,
    price: p.price, regular_price: p.regular_price, sale_price: p.sale_price,
    on_sale: !!p.on_sale,
    stock_status: p.stock_status,
    stock_quantity: p.stock_quantity,
    short_description: (p.short_description || "").replace(/<[^>]+>/g, "").trim(),
    description: (p.description || "").replace(/<[^>]+>/g, "").trim().slice(0, 600),
    categories: (p.categories || []).map(c => c.name),
    tags: (p.tags || []).map(t => t.name),
    image_url: p.images?.[0]?.src || null,
    permalink: p.permalink,
  };
}

async function searchProducts(query, { perPage = 5 } = {}) {
  const cacheKey = `q:${query}:${perPage}`;
  const cached = productCache.byTermAt.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data;

  let results = [];
  try {
    const { data } = await woo.get("/products", { params: { search: query, per_page: perPage, status: "publish" } });
    results = data.map(mapProduct);

    if (!results.length) {
      const tagsResp = await woo.get("/products/tags", { params: { search: query, per_page: 5 } });
      if (tagsResp.data?.length) {
        const { data: byTag } = await woo.get("/products", {
          params: { tag: tagsResp.data.map(t => t.id).join(","), per_page: perPage, status: "publish" }
        });
        results = byTag.map(mapProduct);
      }
    }
    if (!results.length) {
      const catResp = await woo.get("/products/categories", { params: { search: query, per_page: 5 } });
      if (catResp.data?.length) {
        const { data: byCat } = await woo.get("/products", {
          params: { category: catResp.data.map(c => c.id).join(","), per_page: perPage, status: "publish" }
        });
        results = byCat.map(mapProduct);
      }
    }
  } catch (err) { console.error("[WOO SEARCH]", err.message); return []; }

  results.forEach(p => {
    productCache.byId.set(p.id, { data: p, at: Date.now() });
    productCache.bySlug.set(p.slug, { data: p, at: Date.now() });
  });
  productCache.byTermAt.set(cacheKey, { data: results, at: Date.now() });
  return results;
}

async function getProductByIdOrSlug(idOrSlug) {
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
  } catch (err) { console.error("[WOO DETAIL]", err.message); return null; }
}

async function findAlternatives(product, max = 2) {
  if (!product) return [];
  try {
    const tagNames = product.tags || [];
    const cats = product.categories || [];
    const params = { per_page: 10, status: "publish", stock_status: "instock" };
    let pool = [];

    if (tagNames.length) {
      const tagsResp = await woo.get("/products/tags", { params: { search: tagNames[0], per_page: 3 } });
      if (tagsResp.data?.length) {
        const { data } = await woo.get("/products", { params: { ...params, tag: tagsResp.data.map(t => t.id).join(",") } });
        pool = pool.concat(data.map(mapProduct));
      }
    }
    if (!pool.length && cats.length) {
      const catResp = await woo.get("/products/categories", { params: { search: cats[0], per_page: 3 } });
      if (catResp.data?.length) {
        const { data } = await woo.get("/products", { params: { ...params, category: catResp.data.map(c => c.id).join(",") } });
        pool = pool.concat(data.map(mapProduct));
      }
    }

    const seen = new Set([product.id]);
    return pool
      .filter(p => p.stock_status === "instock" && !seen.has(p.id) && (seen.add(p.id), true))
      .slice(0, max);
  } catch (err) { console.error("[ALT]", err.message); return []; }
}

// ─────────────────────────────────────────────────────────────────
// CUPONES dinámicos para follow-ups (1 uso, vence 48h)
// ─────────────────────────────────────────────────────────────────
function generateCouponCode(phone) {
  const clean = String(phone).replace(/\D/g, "").slice(-4) || "0000";
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `ALMA-${clean}-${rand}`;
}

async function createSingleUseCoupon(phone, percent = FOLLOWUP_DISCOUNT_PCT, hoursValid = FOLLOWUP_COUPON_HOURS) {
  const code = generateCouponCode(phone);
  const expiresAt = new Date(Date.now() + hoursValid * 60 * 60 * 1000);
  // formato YYYY-MM-DD para Woo
  const dateExpires = expiresAt.toISOString().split("T")[0];
  try {
    const { data } = await woo.post("/coupons", {
      code,
      discount_type: "percent",
      amount: String(percent),
      individual_use: true,
      usage_limit: 1,
      usage_limit_per_user: 1,
      date_expires: dateExpires,
      description: `Follow-up automático Alma — cliente ${phone}`,
      free_shipping: false,
      exclude_sale_items: false,
      minimum_amount: "0",
    });
    console.log(`[COUPON] Creado ${code} (${percent}% off, vence ${dateExpires}) para ${phone}`);
    return { code: data.code, expiresAt: expiresAt.toISOString() };
  } catch (err) {
    console.error("[COUPON CREATE]", err.response?.data || err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Cross-check: ¿Ya compró en las últimas 24h?
// ─────────────────────────────────────────────────────────────────
async function hasRecentOrder(phone, hoursWindow = 24) {
  try {
    const orders = await getOrdersByPhone(phone);
    if (!orders || !orders.length) return false;
    const cutoff = Date.now() - hoursWindow * 60 * 60 * 1000;
    return orders.some(o => {
      const t = new Date(o.date_created).getTime();
      return t > cutoff && ["processing", "completed", "on-hold"].includes(o.status);
    });
  } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────
// Detección de RECHAZO en mensaje del cliente
// ─────────────────────────────────────────────────────────────────
function detectRejection(message) {
  const m = message.toLowerCase().trim();
  if (/^(no|nop|nope|nel|nelson|na|nah)\.?$/i.test(m)) return true;
  if (/(no\s*me\s*interesa|no\s*gracias|ya\s*no|ahorita\s*no|despu[eé]s|otro\s*d[ií]a|m[aá]s\s*tarde|gracias\s*pero\s*no|paso|paso\s*por\s*ahora|ya\s*compr[eé])/i.test(m)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────
// Pedidos & Envia (sin cambios)
// ─────────────────────────────────────────────────────────────────
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

// FIX: normalizar a dígitos ANTES de tomar los últimos 10, para tolerar
// formatos con espacios, paréntesis y guiones ("+52 (555) 123-4567").
// También funciona con números internacionales — compara únicamente los
// últimos 10 dígitos, lo que evita sesgo hacia el prefijo mexicano.
function normalizePhoneLast10(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

async function getOrdersByPhone(phone) {
  try {
    const localPhone = normalizePhoneLast10(phone);
    const { data } = await woo.get("/orders", { params: { per_page: 50, orderby: "date", order: "desc" } });
    const matches = data.filter(o => {
      const bp = normalizePhoneLast10(o.billing.phone);
      return bp === localPhone && localPhone.length === 10;
    });
    return matches.length ? matches.map(formatOrder) : null;
  } catch (err) { console.error("[WOO PHONE]", err.message); return null; }
}

function extractTrackingFromShipment(s) {
  return {
    trackingNumber: s.trackingNumber || s.tracking || s.guide_number || s.tracking_number || null,
    trackUrl: s.trackUrl || s.tracking_url || s.trackingUrl || null,
  };
}

async function getTrackingFromEnvia(order) {
  if (!process.env.ENVIA_API_KEY) {
    console.log("[ENVIA] ENVIA_API_KEY no configurada, skip");
    return { trackingNumber: null, trackUrl: null };
  }
  const orderId = String(order.number || order.id);
  const orderPhone = normalizePhoneLast10(order.customer_phone);
  const orderName = (order.customer_name || "").toLowerCase().trim();
  const headers = { Authorization: `Bearer ${process.env.ENVIA_API_KEY}`, "Content-Type": "application/json" };

  // Intento 1: búsqueda directa por referencia. Envia.com documenta varios
  // nombres de parámetro según el endpoint — probamos los 3 más comunes.
  for (const paramName of ["reference", "order_id", "externalId"]) {
    try {
      const { data } = await axios.get("https://api.envia.com/ship/", {
        headers,
        params: { [paramName]: orderId, limit: 10 },
        timeout: 10000,
      });
      const shipments = data?.data || data?.shipments || data || [];
      const matched = Array.isArray(shipments) && shipments.find(s => {
        const ref = String(s.reference || s.order_id || s.externalId || "");
        return ref === orderId;
      });
      if (matched) {
        console.log(`[ENVIA] Match directo pedido=${orderId} vía param=${paramName}`);
        return extractTrackingFromShipment(matched);
      }
    } catch (_) { /* siguiente intento */ }
  }

  // Intento 2: listar hasta 200 envíos sin filtro de status (el anterior era
  // demasiado restrictivo — limit:50 + status:"delivered,transit,pending"
  // filtraba envíos en otros estados y no alcanzaba para tiendas con muchos
  // pedidos) y matchear localmente.
  try {
    const { data } = await axios.get("https://api.envia.com/ship/", {
      headers,
      params: { limit: 200 },
      timeout: 15000,
    });
    const shipments = data?.data || data?.shipments || data || [];
    if (!Array.isArray(shipments)) {
      console.log(`[ENVIA] Respuesta inesperada tipo=${typeof shipments}`);
      return { trackingNumber: null, trackUrl: null };
    }
    console.log(`[ENVIA] ${shipments.length} shipments traídos; busco pedido=${orderId} phone=${orderPhone || "-"}`);

    // Match exacto por referencia (sin substring — evita matchear "4435" dentro de "44351").
    let matched = shipments.find(s => {
      const ref = String(s.reference || s.order_id || s.externalId || "");
      return ref === orderId;
    });

    // Match por teléfono — sólo si tenemos 10 dígitos completos y hay un único
    // shipment con ese teléfono (si hay varios, no podemos saber cuál es).
    if (!matched && orderPhone.length === 10) {
      const byPhone = shipments.filter(s => {
        const dp = normalizePhoneLast10(s.address_to?.phone || s.recipient?.phone);
        return dp.length === 10 && dp === orderPhone;
      });
      if (byPhone.length === 1) {
        matched = byPhone[0];
        console.log(`[ENVIA] Match único por teléfono=${orderPhone}`);
      } else if (byPhone.length > 1) {
        console.log(`[ENVIA] ${byPhone.length} shipments con phone=${orderPhone} — ambiguo, descarto`);
      }
    }

    // Match por nombre — solo como último recurso, exigiendo coincidencia única.
    if (!matched && orderName) {
      const firstName = orderName.split(" ")[0];
      if (firstName.length >= 3) {
        const byName = shipments.filter(s => {
          const dn = (s.address_to?.name || s.recipient?.name || "").toLowerCase().trim();
          return dn && dn.includes(firstName);
        });
        if (byName.length === 1) {
          matched = byName[0];
          console.log(`[ENVIA] Match único por nombre=${firstName}`);
        } else if (byName.length > 1) {
          console.log(`[ENVIA] ${byName.length} shipments con name~${firstName} — ambiguo, descarto`);
        }
      }
    }

    if (!matched) {
      console.log(`[ENVIA] Sin match para pedido=${orderId}`);
      return { trackingNumber: null, trackUrl: null };
    }
    return extractTrackingFromShipment(matched);
  } catch (e) {
    console.error("[ENVIA SHIPMENTS]", e.response?.status, e.response?.data || e.message);
    return { trackingNumber: null, trackUrl: null };
  }
}

// ─────────────────────────────────────────────────────────────────
// Extracción de tracking desde meta_data de WooCommerce
// ─────────────────────────────────────────────────────────────────
// Lista canónica de keys conocidas. Orden = prioridad.
const TRACKING_META_KEYS = [
  "_envia_tracking_number",
  "_envia_track_number",
  "envia_tracking",
  "envia_guia_tracking",
  "_wc_shipment_tracking_number",
  "_wc_shipment_tracking_items",   // plugin WC Shipment Tracking — valor serializado
  "_aftership_tracking_number",
  "_tracking_number",
  "_shipment_tracking_number",
  "tracking_number",
  "trackingNumber",
  "tracking_code",
];

// Placeholders que NO son un tracking real.
function isFakeTrackingValue(v) {
  if (!v) return true;
  const s = String(v).trim();
  if (!s) return true;
  if (/^ENV-\d+-MEX$/i.test(s)) return true;
  return false;
}

// Valida que un valor *parezca* un número de rastreo real.
// Filtra falsos positivos de keys analíticas/pixel/sesión cuyo valor
// suele ser una URL, un UUID largo, un JSON enorme, o tokens de cookies.
function looksLikeTrackingNumber(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (!t) return false;
  // Rango razonable de longitud para un número de guía real.
  if (t.length < 6 || t.length > 40) return false;
  // URLs, paths o HTML → no son tracking.
  if (/^https?:\/\//i.test(t)) return false;
  if (/[<>{}|\\^`"\s]/.test(t)) return false; // espacios u otros chars raros
  // Debe tener al menos un dígito (las guías reales siempre tienen números).
  if (!/\d/.test(t)) return false;
  // Solo alfanumérico + separadores comunes en guías.
  if (!/^[A-Za-z0-9._\-/]+$/.test(t)) return false;
  return true;
}

// Un valor de meta puede ser: string plano, JSON string, array de objetos
// (plugin WC Shipment Tracking), u objeto suelto. Devuelve el primer tracking
// no-fake encontrado o null.
function extractTrackingFromValue(value) {
  if (value == null) return null;

  // Caso simple: ya es string con el tracking.
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // ¿Es JSON que hay que parsear?
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try { return extractTrackingFromValue(JSON.parse(trimmed)); }
      catch { /* no era JSON válido — tratar como string */ }
    }
    if (isFakeTrackingValue(trimmed)) return null;
    if (!looksLikeTrackingNumber(trimmed)) return null;
    return trimmed;
  }

  // Array: WC Shipment Tracking guarda [{tracking_number, tracking_provider, ...}]
  if (Array.isArray(value)) {
    for (const item of value) {
      const t = extractTrackingFromValue(item);
      if (t) return t;
    }
    return null;
  }

  // Objeto suelto: buscar cualquier propiedad que huela a tracking.
  if (typeof value === "object") {
    const candidates = [
      value.tracking_number, value.trackingNumber, value.tracking,
      value.guide_number, value.number, value.code, value.tracking_code,
    ];
    for (const c of candidates) {
      const t = extractTrackingFromValue(c);
      if (t) return t;
    }
  }

  return null;
}

// Regex para reconocer SOLO meta keys que son genuinamente de tracking.
// Evita falsos positivos como _analytics_tracking_id, _fb_pixel_tracking,
// _conversion_tracking, _utm_tracking_code, etc. — que contienen "track"
// pero guardan IDs de sesión/pixel iguales para todos los pedidos.
//
// Requiere que la key combine "track/guia/shipment/envia" con
// "number/num/code/id" y que NO sea de analytics/pixel/conversion.
const FUZZY_TRACKING_KEY = /(track(ing)?|gu[ií]a|shipment|env[ií]a)[_-]?(number|num|code|id)\b/i;
const FUZZY_BLOCKLIST    = /(analytic|pixel|conversion|utm|gtm|ga_|_ga|session|cookie|visitor|fbp|_fb_|clickid|gclid|fbclid)/i;

// Busca el número de rastreo en el meta_data del pedido. Intenta primero las
// keys canónicas en orden de prioridad; si no encuentra, hace un fallback
// fuzzy estricto sobre cualquier meta key que parezca genuina de tracking.
// Devuelve { value, matchedKey, viaFuzzy }.
function findTrackingInMeta(metaData) {
  if (!Array.isArray(metaData) || !metaData.length) {
    return { value: null, matchedKey: null, viaFuzzy: false };
  }

  for (const key of TRACKING_META_KEYS) {
    const entry = metaData.find(m => m && m.key === key);
    if (!entry) continue;
    const t = extractTrackingFromValue(entry.value);
    if (t) return { value: t, matchedKey: key, viaFuzzy: false };
  }

  // Fallback fuzzy (restringido): key debe combinar término de tracking
  // con número/código/id, y NO ser de analytics/pixel/sesión.
  const fuzzy = metaData.filter(m => {
    if (!m || typeof m.key !== "string") return false;
    if (FUZZY_BLOCKLIST.test(m.key)) return false;
    return FUZZY_TRACKING_KEY.test(m.key);
  });
  for (const entry of fuzzy) {
    const t = extractTrackingFromValue(entry.value);
    if (t) return { value: t, matchedKey: entry.key, viaFuzzy: true };
  }

  return { value: null, matchedKey: null, viaFuzzy: false };
}

async function getShipmentByOrderId(orderId) {
  try {
    const order = await getOrderByNumber(orderId);
    if (!order) return { order: null, shipment: null, trackingNumber: null };

    const match = findTrackingInMeta(order.meta_data);
    const trackingNumber = match.value;

    // Log diagnóstico con suficiente info para detectar mismatches:
    // - Si matcheó una key fuzzy, la vemos explícitamente (posible falso positivo).
    // - Si no matcheó nada, mostramos todas las keys para añadir la correcta.
    if (trackingNumber && match.viaFuzzy) {
      console.log(`[TRACKING] Pedido ${orderId} match FUZZY key="${match.matchedKey}" value="${trackingNumber}"`);
    } else if (!trackingNumber && order.meta_data?.length) {
      const keys = order.meta_data.map(m => m?.key).filter(Boolean);
      console.log(`[TRACKING] Pedido ${orderId} sin tracking reconocido. Meta keys: ${keys.join(", ")}`);
    }

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

// ─────────────────────────────────────────────────────────────────
// Tools para Claude
// ─────────────────────────────────────────────────────────────────
const tools = [
  {
    name: "buscar_productos",
    description: "Busca perfumes en The Alchemia Lab por nombre, notas olfativas, familia (amaderado, floral, oud, acuático, oriental, etc.) o categoría (mujer, hombre, unisex). Devuelve nombre, precio, disponibilidad, descripción corta, imagen y permalink (URL de compra). Si un perfume está agotado, devuelve también 'alternativas' en stock similares.",
    input_schema: { type: "object", properties: { query: { type: "string", description: "Texto libre: nombre del perfume o descripción olfativa." } }, required: ["query"] }
  },
  {
    name: "obtener_detalle_producto",
    description: "Devuelve la ficha completa de un perfume específico (notas, descripción larga, imagen, link de compra). Úsalo cuando el cliente pide más información de un producto que ya se mencionó, o dice 'el primero', 'el de hasta arriba', 'el Xibalba', etc.",
    input_schema: { type: "object", properties: { id_o_slug: { type: "string", description: "ID numérico o slug." } }, required: ["id_o_slug"] }
  },
  {
    name: "consultar_pedido",
    description: "Consulta el estatus de pedido(s) y rastreo en Envía.com.",
    input_schema: { type: "object", properties: {
      numero_pedido: { type: "string", description: "Número de pedido (ej: 1521)" },
      telefono_cliente: { type: "string", description: "Teléfono para buscar pedidos si no hay número" }
    } }
  },
];

async function executeTool(name, input, session, phone) {
  if (name === "buscar_productos") {
    const productos = await searchProducts(input.query);
    if (!productos.length) return JSON.stringify({ resultado: "No encontré ese perfume. ¿Puedes describirlo diferente (notas, familia, ocasión)?" });
    if (session) session.lastShownProducts = productos.map(p => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      link: p.permalink,
      price: p.price,
      regularPrice: p.regular_price,
      onSale: !!p.on_sale,
      stockStatus: p.stock_status,
    }));

    const enriched = await Promise.all(productos.map(async (p) => {
      const base = {
        id: p.id, name: p.name, slug: p.slug,
        precio: p.price ? `$${p.price} MXN` : null,
        precio_regular: p.regular_price ? `$${p.regular_price} MXN` : null,
        en_oferta: p.on_sale,
        disponibilidad: p.stock_status === "instock" ? "EN STOCK" : (p.stock_status === "onbackorder" ? "POR PEDIDO" : "AGOTADO"),
        descripcion: p.short_description,
        notas: p.tags,
        imagen: p.image_url,
        link_compra: p.permalink,
      };
      if (p.stock_status !== "instock") {
        const alts = await findAlternatives(p, 2);
        base.alternativas_en_stock = alts.map(a => ({ name: a.name, precio: a.price ? `$${a.price} MXN` : null, link_compra: a.permalink }));
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
      disponibilidad: p.stock_status === "instock" ? "EN STOCK" : (p.stock_status === "onbackorder" ? "POR PEDIDO" : "AGOTADO"),
      descripcion_corta: p.short_description,
      descripcion: p.description,
      notas: p.tags, categorias: p.categories,
      imagen: p.image_url, link_compra: p.permalink,
    };
    if (p.stock_status !== "instock") {
      const alts = await findAlternatives(p, 2);
      out.alternativas_en_stock = alts.map(a => ({ name: a.name, precio: a.price ? `$${a.price} MXN` : null, link_compra: a.permalink }));
    }
    return JSON.stringify({ producto: out });
  }

  if (name === "consultar_pedido") {
    const statusMap = { pending: "Pendiente de pago", processing: "En proceso", "on-hold": "En espera", completed: "Completado", cancelled: "Cancelado", refunded: "Reembolsado", failed: "Fallido" };

    if (input.numero_pedido) {
      const { order, shipment, trackingNumber } = await getShipmentByOrderId(input.numero_pedido);
      if (!order) return JSON.stringify({ resultado: `No encontré el pedido #${input.numero_pedido}. Verifica el número e intenta de nuevo.` });
      if (order.customer_name && session) session.clientName = order.customer_name;
      if (!trackingNumber && phone) registerIncident({ phone, orderNumber: input.numero_pedido, type: "SIN_RASTREO", detail: "Sin número de rastreo.", clientName: session?.clientName });
      if (["cancelled", "on-hold", "failed"].includes(order.status) && phone) {
        registerIncident({ phone, orderNumber: input.numero_pedido, type: "CANCELADO", detail: `Estatus: ${statusMap[order.status]}`, clientName: session?.clientName });
      }
      return JSON.stringify({
        pedido: { numero: order.number, estatus_woo: statusMap[order.status] || order.status, cliente: order.customer_name, productos: order.items, total: `${order.total} ${order.currency}`, metodo_envio: order.shipping_method, fecha: order.date_created },
        envio: trackingNumber ? {
          numero_rastreo: trackingNumber,
          datos_envia: shipment ? (() => {
            const t = shipment.data?.[0] || shipment;
            return { estatus: t.status || t.statusCode || "Sin estado", descripcion: t.description || t.statusDescription || "Sin descripción", carrier: t.carrier || t.service || "Sin carrier", url_rastreo: t.trackUrl || t.url || null };
          })() : "Sin datos de Envía.com"
        } : (
          // Cuando no hay tracking, el mensaje depende del estatus.
          // Decir "en preparación" cuando el pedido YA está completed/shipped
          // es confuso para el cliente (fue el bug que reportamos con #4435).
          ["completed"].includes(order.status) ? {
            numero_rastreo: null,
            nota: "Este pedido aparece como entregado en el sistema, pero no encuentro el número de rastreo registrado. Si no lo recibiste, escalamos tu caso con el equipo."
          } : ["processing"].includes(order.status) ? {
            numero_rastreo: null,
            nota: "Tu pedido está en proceso de preparación. Cuando salga del almacén recibirás el número de rastreo por correo."
          } : {
            numero_rastreo: null,
            nota: `Estatus: ${statusMap[order.status] || order.status}. Sin número de rastreo registrado.`
          }
        )
      });
    }

    if (input.telefono_cliente) {
      const orders = await getOrdersByPhone(input.telefono_cliente);
      if (!orders || !orders.length) return JSON.stringify({ resultado: `No encontré pedidos asociados al teléfono ${input.telefono_cliente}.` });
      if (orders[0].customer_name && session) session.clientName = orders[0].customer_name;
      const topOrders = orders.slice(0, 3);
      return JSON.stringify({ total_pedidos: orders.length, mostrando: topOrders.length, pedidos_recientes: topOrders.map((o, i) => ({ posicion: i + 1, numero: o.number, estatus: statusMap[o.status] || o.status, productos: o.items, total: `${o.total} ${o.currency}`, fecha: o.date_created.slice(0, 10) })), pregunta: "¿Quieres ver el detalle de alguno?" });
    }

    const autoOrders = await getOrdersByPhone(phone);
    if (!autoOrders || !autoOrders.length) return JSON.stringify({ resultado: "No encontré pedidos asociados a tu número de WhatsApp. ¿Tienes el número de pedido?" });
    if (autoOrders[0].customer_name && session) session.clientName = autoOrders[0].customer_name;
    if (autoOrders.length === 1) {
      const o = autoOrders[0];
      return JSON.stringify({ pedido: { numero: o.number, estatus: statusMap[o.status] || o.status, productos: o.items, total: `${o.total} ${o.currency}`, fecha: o.date_created.slice(0, 10) } });
    }
    const autoTop = autoOrders.slice(0, 3);
    return JSON.stringify({ total_pedidos: autoOrders.length, mostrando: autoTop.length, pedidos_recientes: autoTop.map((o, i) => ({ posicion: i + 1, numero: o.number, estatus: statusMap[o.status] || o.status, productos: o.items, total: `${o.total} ${o.currency}`, fecha: o.date_created.slice(0, 10) })), pregunta: "¿Quieres ver el detalle de alguno?" });
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
    session.hasIncident = true;          // ← bloquea follow-ups
    session.followupCancelled = true;
    return true;
  }
  return false;
}

const SYSTEM_PROMPT = `Eres *Alma*, asesora personal y secretaria comercial de *The Alchemia Lab*, una casa mexicana de perfumería de autor.

Tu misión es atender con la precisión de una secretaria profesional y vender con elegancia: entender rápido lo que necesita cada persona, recomendar pocas opciones acertadas, resolver dudas y facilitar que complete su compra. No presionas, no improvisas y no abrumas.

IDENTIDAD Y TONO
- Siempre hablas en español de México, de tú, con calidez, seguridad y excelente ortografía.
- Suenas humana, atenta y conocedora; nunca robótica, desesperada ni excesivamente ceremoniosa.
- Mensajes breves y escaneables para WhatsApp: párrafos de máximo 3 líneas.
- Usa *negritas* para lo decisivo y máximo 2 emojis por mensaje.
- No termines mecánicamente con “¿En qué más te puedo ayudar?”. Cierra con el siguiente paso más útil.

HERRAMIENTAS
1. buscar_productos: búsqueda por nombre, familia, notas, ocasión o género.
2. obtener_detalle_producto: ficha completa de un perfume concreto.
3. consultar_pedido: estado y rastreo de pedidos.

FLUJO COMERCIAL
1. *Recibir y descubrir.* Si solo saluda o su necesidad es vaga, preséntate en una línea y haz UNA pregunta fácil que ayude a recomendar: “¿Lo buscas para ti o para regalo?” o “¿Prefieres algo fresco, dulce o intenso?”. No envíes un interrogatorio ni una lista larga.
2. *Recomendar.* Cuando tengas una preferencia, usa buscar_productos y presenta máximo 3 opciones. Di en una frase por qué cada una encaja con lo que pidió.
3. *Reducir la decisión.* Si duda entre opciones, compara máximo 2 y recomienda una con claridad: “Por lo que me cuentas, elegiría X”.
4. *Cerrar.* Después de una recomendación, formula una sola llamada a la acción concreta: “¿Te comparto el enlace para pedirlo?”, “¿Te preparo esta opción?” o “Puedes pedirlo aquí: [link]”.
5. *Confirmar sin inventar.* Precio, oferta, stock, notas y enlace siempre vienen de las herramientas. Nunca uses recuerdos, ejemplos o información de mensajes anteriores como si fueran datos actuales.

REGLAS DE VENTA Y CONFIANZA
- Antes de afirmar precio, promoción, existencia, notas o características de un producto, usa buscar_productos u obtener_detalle_producto.
- No inventes descuentos, regalos, apartados, escasez, tiempos de entrega ni beneficios.
- No uses urgencia falsa. Solo menciona pocas unidades si la herramienta entrega un dato real que lo sustente.
- No ofrezcas cupones por iniciativa propia; el sistema de seguimiento administra los beneficios autorizados.
- Política vigente de envío: envío gratis al elegir 3 productos o desde $597 MXN. El Dark Oud Cacao Set incluye envío gratis. Si el cliente pregunta por envío, explica la regla en una sola frase.
- Para dudas de confianza, explica brevemente: compra en sitio oficial, pago seguro y envío con rastreo. No hagas promesas no verificadas de fecha exacta.
- Si el cliente pide “todos”, evita arrojar un catálogo enorme. Pregunta primero qué perfil busca o muestra máximo 3 opciones representativas.
- Si dice que algo es caro, reconoce su presupuesto y busca alternativas reales; no desacredites otras marcas ni reduzcas el valor de la casa.

FORMATO OBLIGATORIO DE PRODUCTO
Cuando una herramienta devuelva productos, incluye por cada opción mencionada:
1. *Nombre*.
2. Precio actual en MXN. Si “en_oferta” es true, muestra el regular tachado y el precio de oferta.
3. Una frase corta basada únicamente en “descripcion” o “notas”.
4. 🛒 El valor EXACTO de “link_compra”. Nunca inventes, acortes o sustituyas la URL.

Un producto:
*Nombre del perfume*
💰 Precio actual
Perfil o razón de recomendación en una frase.
🛒 Link exacto

Varias opciones: numera 1, 2 y 3; una línea útil por opción y su link exacto.

DISPONIBILIDAD
- Si está EN STOCK, no necesitas repetirlo salvo que el cliente pregunte.
- Si está AGOTADO: indica “❌ Agotado por ahora” y ofrece únicamente las alternativas_en_stock entregadas por la herramienta.
- Si está POR PEDIDO: indica “📦 Disponible por pedido” sin inventar plazo.

MANEJO DE OBJECIONES
- “No sé cuál”: pregunta por ocasión o perfil y recomienda una opción principal.
- “Está caro”: pregunta presupuesto o presenta opciones reales de menor precio.
- “¿Es confiable?”: responde con sitio oficial, pago seguro y rastreo; luego comparte el enlace exacto.
- “Lo voy a pensar”: responde con respeto, resume en una línea la mejor opción y deja su enlace. No insistas en ese turno.
- “Quiero comprar”: deja de explicar y facilita el enlace directo inmediatamente.

PEDIDOS Y POSTVENTA
- Si menciona un pedido (ej. #1521), usa consultar_pedido de inmediato.
- Si quiere ver sus pedidos sin número, llama consultar_pedido sin pedirle teléfono; el sistema usa el remitente.
- Si hay varios pedidos_recientes, muestra todos los devueltos, enumerados.
- Destaca el número de rastreo con *negritas*.
- Si reporta producto dañado, incorrecto, reembolso o problema grave, prioriza servicio sobre venta y responde: “He registrado tu caso para que nuestro equipo te contacte personalmente.”`;

async function processMessage(phone, userMessage) {
  const session = getSession(phone);

  // 1) Marcar incidente si aplica (bloquea follow-ups internamente)
  await detectAndRegisterIncident(phone, userMessage, session);

  // 2) Detectar rechazo explícito
  if (detectRejection(userMessage)) {
    session.followupCancelled = true;
    console.log(`[FOLLOWUP] ${phone}: rechazo detectado, follow-ups cancelados`);
  } else if (!session.hasIncident) {
    // Cualquier otra respuesta activa resetea el contador (nuevo ciclo)
    session.followupsSent = 0;
    session.followupCancelled = false;
    session.lastCouponCode = null;
    session.lastCouponExpiresAt = null;
  }
  session.lastUserMessageAt = Date.now();

  const mentionedOrder = extractOrderNumber(userMessage);
  if (mentionedOrder) session.knownOrder = mentionedOrder;
  session.history.push({ role: "user", content: userMessage });
  if (session.history.length > 20) session.history = session.history.slice(-20);

  let messages = [...session.history];
  let finalResponse = "";
  let lastProductImageMessage = null;

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

          try {
            const parsed = JSON.parse(result);
            const single = (parsed.productos?.length === 1 && parsed.productos[0]) || parsed.producto || null;
            if (single?.imagen && single?.link_compra) {
              lastProductImageMessage = { imageUrl: single.imagen, caption: `*${single.name}* — ${single.link_compra}` };
            }
          } catch (_) {}
        }
      }
      messages.push({ role: "user", content: toolResults });
    }
  }
  if (finalResponse) session.history.push({ role: "assistant", content: finalResponse });
  return { text: finalResponse || "Lo siento, no pude procesar tu mensaje. Intenta de nuevo 🌿", productImage: lastProductImageMessage };
}

// ─────────────────────────────────────────────────────────────────
// FOLLOW-UP CYCLE — corre cada N min, manda mensajes de venta
// ─────────────────────────────────────────────────────────────────
function buildFollowupMessage1({ session, coupon }) {
  const product = session.lastShownProducts?.[0];
  const productLine = product
    ? `Quedó pendiente tu selección de *${product.name}*.\n${product.link || ""}\n`
    : `Quedó pendiente tu selección.\n`;
  if (!coupon) {
    return (
      `Hola, soy Alma, de The Alchemia Lab.\n\n` +
      `${productLine}\n` +
      `Este producto ya tiene precio especial, por eso no acumula cupones. Si eliges 3 productos o llegas a $597 MXN, el envío es gratis.\n\n` +
      `¿Quieres que te ayude a completar tu combinación?`
    );
  }
  return (
    `Hola, soy Alma, de The Alchemia Lab.\n\n` +
    `${productLine}\n` +
    `Preparé un beneficio de *${FOLLOWUP_DISCOUNT_PCT}% de descuento* para tu compra. Es de un solo uso y vence en ${FOLLOWUP_COUPON_HOURS} horas.\n\n` +
    `Código: *${coupon.code}*\n\n` +
    `¿Quieres que te ayude a finalizar el pedido?`
  );
}

function buildFollowupMessage2({ session, coupon }) {
  const product = session.lastShownProducts?.[0];
  const productLine = product
    ? `Tu selección de *${product.name}* sigue disponible.\n${product.link || ""}\n\n`
    : "";
  if (!coupon) {
    return (
      `Hola de nuevo. Solo doy seguimiento a tu selección.\n\n` +
      `${productLine}` +
      `Si todavía estás comparando opciones, dime qué aroma buscas y te recomiendo la mejor alternativa.`
    );
  }
  return (
    `Hola de nuevo. Solo doy seguimiento a tu selección.\n\n` +
    `${productLine}` +
    `Tu código *${coupon.code}* de ${FOLLOWUP_DISCOUNT_PCT}% continúa disponible por tiempo limitado.\n\n` +
    `Si quieres aprovecharlo, puedo ayudarte a finalizar la compra.`
  );
}

async function followupCycle() {
  if (!FOLLOWUP_ENABLED) return;
  const now = Date.now();
  for (const [phone, s] of sessions.entries()) {
    try {
      // Filtros base
      if (s.followupCancelled || s.hasIncident) continue;
      if (!s.lastShownProducts?.length) continue;          // no mostró productos → no hay venta que cerrar
      if (s.followupsSent >= 2) continue;                  // máximo 2

      const hoursSinceLast = (now - s.lastUserMessageAt) / (60 * 60 * 1000);

      // Ventana de WhatsApp (24h). Margen 0.5h por si la API tarda.
      if (hoursSinceLast > 23.5) {
        s.followupCancelled = true; // ya no se puede mandar
        continue;
      }

      let triggerOk = false;
      if (s.followupsSent === 0 && hoursSinceLast >= FOLLOWUP_FIRST_HOURS) triggerOk = true;
      if (s.followupsSent === 1 && hoursSinceLast >= FOLLOWUP_SECOND_HOURS) triggerOk = true;
      if (!triggerOk) continue;

      // Cross-check WooCommerce: ¿ya compró?
      if (await hasRecentOrder(phone, 24)) {
        console.log(`[FOLLOWUP] ${phone}: ya compró → cancelado`);
        s.followupCancelled = true;
        continue;
      }

      // Los productos ya rebajados no acumulan cupones: preserva margen y evita
      // prometer un descuento que WooCommerce no debería apilar.
      const productOnSale = !!s.lastShownProducts?.[0]?.onSale;

      // Generar / reusar cupón únicamente para productos a precio regular.
      let coupon = s.lastCouponCode ? { code: s.lastCouponCode, expiresAt: s.lastCouponExpiresAt } : null;
      if (!productOnSale && !coupon) {
        const created = await createSingleUseCoupon(phone);
        if (!created) {
          console.error(`[FOLLOWUP] ${phone}: no pude crear cupón, omito`);
          continue;
        }
        coupon = created;
        s.lastCouponCode = coupon.code;
        s.lastCouponExpiresAt = coupon.expiresAt;
      }
      if (productOnSale) coupon = null;

      // Construir mensaje
      const text = s.followupsSent === 0
        ? buildFollowupMessage1({ session: s, coupon })
        : buildFollowupMessage2({ session: s, coupon });

      await sendWhatsAppMessage(phone, text);
      s.followupsSent += 1;
      console.log(`[FOLLOWUP] ${phone}: msg #${s.followupsSent} enviado (${coupon ? `cupón ${coupon.code}` : "producto en oferta, sin cupón"})`);
    } catch (e) {
      console.error(`[FOLLOWUP CYCLE] ${phone}:`, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// HMAC opcional del webhook
// ─────────────────────────────────────────────────────────────────
function verifyMetaSignature(req) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true;
  const sigHeader = req.headers["x-hub-signature-256"];
  if (!sigHeader || !req.rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected)); } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────
// Webhook WhatsApp
// ─────────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === (process.env.WHATSAPP_VERIFY_TOKEN || "alchemia2024")) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  if (!verifyMetaSignature(req)) { console.warn("[WEBHOOK] firma inválida — ignorado"); return; }
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message?.type === "text") {
      const phone = message.from;
      const text = message.text.body;
      console.log(`[MSG IN] ${phone}: ${text}`);
      const reply = await processMessage(phone, text);
      await sendWhatsAppMessage(phone, reply.text);
      if (reply.productImage) await sendWhatsAppImage(phone, reply.productImage.imageUrl, reply.productImage.caption);
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

// ─────────────────────────────────────────────────────────────────
// API Panel
// ─────────────────────────────────────────────────────────────────
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

// Forzar el ciclo de follow-ups manualmente (debug)
app.post("/api/followups/run", async (_req, res) => {
  try { await followupCycle(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Test directo: crear un cupón de prueba (verifica permisos de escritura en Woo)
app.post("/api/followups/test-coupon", async (req, res) => {
  const phone = req.body?.phone || "test_perms_check";
  const result = await createSingleUseCoupon(phone, FOLLOWUP_DISCOUNT_PCT, 1); // 1h, mínimo
  if (!result) return res.status(500).json({ ok: false, error: "No se pudo crear el cupón. Revisa permisos de WOO_KEY/WOO_SECRET en logs." });
  res.json({ ok: true, ...result, note: "Cupón creado en WooCommerce. Vence en 1h. Verifica en Woo → Marketing → Coupons." });
});

// Estado de follow-ups por sesión (debug)
app.get("/api/followups/status", (_req, res) => {
  const out = [];
  for (const [phone, s] of sessions.entries()) {
    out.push({
      phone,
      lastUserMessageAt: new Date(s.lastUserMessageAt).toISOString(),
      hoursSinceLast: ((Date.now() - s.lastUserMessageAt) / (60 * 60 * 1000)).toFixed(2),
      followupsSent: s.followupsSent,
      followupCancelled: s.followupCancelled,
      hasIncident: s.hasIncident,
      hasProductsShown: (s.lastShownProducts?.length || 0) > 0,
      lastCouponCode: s.lastCouponCode,
    });
  }
  res.json({ sessions: out, total: out.length });
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
  results.followups = {
    enabled: FOLLOWUP_ENABLED,
    firstHours: FOLLOWUP_FIRST_HOURS,
    secondHours: FOLLOWUP_SECOND_HOURS,
    discountPct: FOLLOWUP_DISCOUNT_PCT,
    couponHours: FOLLOWUP_COUPON_HOURS
  };
  res.json(results);
});

app.get("/api/incidents", (req, res) => res.json({ incidents: getTodayIncidents(), total: getTodayIncidents().length }));

app.get("/api/incidents/all", (req, res) => {
  const data = readData();
  let incidents = data.incidents || [];
  if (req.query.date) incidents = incidents.filter(i => i.date === req.query.date);
  if (req.query.status) incidents = incidents.filter(i => i.status === req.query.status);
  res.json({ incidents, total: incidents.length, lastReport: data.lastReport });
});

app.patch("/api/incidents/:id/resolve", (req, res) => res.json({ ok: resolveIncident(req.params.id) }));

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

// Diagnóstico: inspecciona la estructura completa de un pedido en WooCommerce
// para identificar la key exacta donde el store guarda el tracking.
// Uso: GET /api/debug/order/4435  →  JSON con meta_data + intento de match.
app.get("/api/debug/order/:id", async (req, res) => {
  try {
    const orderId = req.params.id;
    let orderRaw = null;

    // Intento 1: lookup directo por ID (más robusto que listar los 20 últimos).
    try {
      const { data } = await woo.get(`/orders/${orderId}`);
      orderRaw = data;
    } catch { /* cae al segundo intento */ }

    // Intento 2: lista de los últimos 20 (comportamiento actual de getOrderByNumber).
    if (!orderRaw) {
      try {
        const { data } = await woo.get("/orders", { params: { per_page: 20, orderby: "date", order: "desc" } });
        orderRaw = data.find(o => String(o.number) === String(orderId) || String(o.id) === String(orderId));
      } catch { /* nothing */ }
    }

    if (!orderRaw) {
      return res.status(404).json({ error: `Pedido ${orderId} no encontrado en WooCommerce` });
    }

    // Intento 3: ¿el plugin WC Shipment Tracking tiene su propio endpoint?
    let shipmentTrackingApi = null;
    try {
      const { data } = await woo.get(`/orders/${orderRaw.id}/shipment-trackings`);
      shipmentTrackingApi = data;
    } catch (e) {
      shipmentTrackingApi = { error: e.response?.status || e.message };
    }

    const match = findTrackingInMeta(orderRaw.meta_data);

    res.json({
      orderId: orderRaw.id,
      orderNumber: orderRaw.number,
      status: orderRaw.status,
      meta_data: orderRaw.meta_data, // clave para diagnosticar
      tracking_match: {
        found: match.value,
        matchedKey: match.matchedKey,
        viaFuzzy: match.viaFuzzy,
      },
      shipment_tracking_plugin_api: shipmentTrackingApi,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

// Diagnóstico de Envia: ejecuta la búsqueda real y devuelve qué matcheó,
// por qué camino, y qué traía el listado. Pensado para depurar pedidos
// donde el tracking sólo vive en Envia y no en WooCommerce.
app.get("/api/debug/envia/:orderId", async (req, res) => {
  try {
    const order = await getOrderByNumber(req.params.orderId);
    if (!order) return res.status(404).json({ error: `Pedido ${req.params.orderId} no encontrado en WooCommerce` });

    if (!process.env.ENVIA_API_KEY) return res.status(400).json({ error: "ENVIA_API_KEY no configurada" });

    // Traer listado para inspección manual (primeros 20 para no saturar).
    let sample = [];
    try {
      const { data } = await axios.get("https://api.envia.com/ship/", {
        headers: { Authorization: `Bearer ${process.env.ENVIA_API_KEY}` },
        params: { limit: 200 },
        timeout: 15000,
      });
      const shipments = data?.data || data?.shipments || data || [];
      sample = Array.isArray(shipments) ? shipments.slice(0, 20).map(s => ({
        reference: s.reference,
        order_id: s.order_id,
        externalId: s.externalId,
        trackingNumber: s.trackingNumber || s.tracking || s.guide_number,
        trackUrl: s.trackUrl || s.tracking_url,
        status: s.status || s.statusCode,
        recipient_name: s.address_to?.name || s.recipient?.name,
        recipient_phone: s.address_to?.phone || s.recipient?.phone,
      })) : [];
    } catch (e) {
      return res.status(502).json({ error: "Envia API falló", detail: e.response?.data || e.message });
    }

    const result = await getTrackingFromEnvia(order);

    res.json({
      order: {
        id: order.id,
        number: order.number,
        status: order.status,
        customer_name: order.customer_name,
        customer_phone: order.customer_phone,
      },
      match: result,
      envia_sample_shipments: sample,
      note: "Si 'match' es null, revisa 'envia_sample_shipments': busca uno con reference/order_id igual a " + order.number,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
      hmac: !!process.env.WHATSAPP_APP_SECRET,
      followupsEnabled: FOLLOWUP_ENABLED
    }
  });
});

// Exports para pruebas — no cambian el comportamiento en runtime.
module.exports = {
  app,
  // Pure helpers
  detectRejection,
  generateCouponCode,
  verifyMetaSignature,
  mapProduct,
  formatOrder,
  buildFollowupMessage1,
  buildFollowupMessage2,
  normalizePhoneLast10,
  // Internals útiles para pruebas (sólo lectura / controlables)
  sessions,
  getSession,
  cleanupStaleSessions,
  followupCycle,
  processMessage,
  searchProducts,
  findAlternatives,
  executeTool,
  hasRecentOrder,
  createSingleUseCoupon,
  findTrackingInMeta,
  extractTrackingFromValue,
  isFakeTrackingValue,
  getShipmentByOrderId,
};

// Side effects sólo cuando se ejecuta directamente (node src/server.js),
// no al requerirse desde pruebas.
if (require.main === module) {
  setInterval(cleanupStaleSessions, 15 * 60 * 1000);
  setInterval(followupCycle, FOLLOWUP_CYCLE_MIN * 60 * 1000);
  console.log(`[FOLLOWUP] Habilitado=${FOLLOWUP_ENABLED} | 1er=${FOLLOWUP_FIRST_HOURS}h | 2º=${FOLLOWUP_SECOND_HOURS}h | cupón ${FOLLOWUP_DISCOUNT_PCT}% (vence ${FOLLOWUP_COUPON_HOURS}h) | ciclo cada ${FOLLOWUP_CYCLE_MIN}min`);
  startScheduler();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║  🌿 The Alchemia Lab — Chatbot WA v2.2   ║`);
    console.log(`║  Puerto: ${PORT}                              ║`);
    console.log(`║  Modelo: ${CLAUDE_MODEL}              ║`);
    console.log(`║  Follow-ups: ${FOLLOWUP_ENABLED ? "ON " : "OFF"} (${FOLLOWUP_DISCOUNT_PCT}% off, ${FOLLOWUP_COUPON_HOURS}h)         ║`);
    console.log(`╚══════════════════════════════════════════╝\n`);
  });
}
