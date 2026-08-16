const cron = require('node-cron');
const nodemailer = require('nodemailer');
const axios = require('axios');
const { getOpenIncidents, readData } = require('./incidents');
const fs = require('fs');
const path = require('path');

async function sendWhatsAppReport(incidents) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.ADMIN_WHATSAPP_PHONE) return false;
  try {
    const open = incidents.filter(i => i.status === 'open');
    if (!open.length) return true;
    const text = `📊 *Reporte diario — The Alchemia Lab*\n\n` +
      `Total problemas abiertos: *${open.length}*\n\n` +
      open.slice(0, 10).map((i, n) =>
        `${n + 1}. *#${i.orderNumber}* — ${incidentTypeLabel(i.type)}\n   Cliente: ${i.clientName}\n   Tel: ${i.phone}\n   Detalle: ${i.detail || 'Sin detalle'}`
      ).join('\n\n') +
      `\n\nPanel: ${process.env.PUBLIC_URL || 'https://tu-app.railway.app'}`;
    await axios.post(`https://graph.facebook.com/v22.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      messaging_product: 'whatsapp', to: process.env.ADMIN_WHATSAPP_PHONE,
      type: 'text', text: { body: text }
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    return true;
  } catch (e) { console.error('[REPORT WA]', e.message); return false; }
}

const INCIDENT_TYPE_LABELS = {
  PRODUCTO_DANADO: 'Producto dañado',
  NO_ENTREGADO: 'Pedido no entregado',
  PRODUCTO_INCORRECTO: 'Producto incorrecto',
  SOLICITUD_REEMBOLSO: 'Solicitud de reembolso',
  DEFECTO: 'Producto con defecto',
  SIN_RASTREO: 'Pedido sin rastreo',
  CANCELADO: 'Pedido cancelado o detenido',
  REINCIDENTE: 'Cliente con contacto repetido',
};

function incidentTypeLabel(type) {
  return INCIDENT_TYPE_LABELS[type] || String(type || 'Problema sin clasificar').replaceAll('_', ' ');
}

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatIncidentDate(incident) {
  const raw = incident.lastUpdate || incident.createdAt || incident.date;
  if (!raw) return 'Sin fecha';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return String(raw);
  return date.toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'short', timeStyle: 'short' });
}

function buildEmailHTML(open) {
  return `<div style="font-family:Arial,sans-serif;color:#171717;max-width:920px;margin:auto">
    <h2 style="margin-bottom:8px">Problemas abiertos — The Alchemia Lab</h2>
    <p>Este correo reúne las órdenes con quejas o incidencias que requieren seguimiento.</p>
    <p>Total de problemas abiertos: <strong>${open.length}</strong></p>
    <table cellpadding="9" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px">
      <thead><tr style="background:#171717;color:#d4af4c;text-align:left"><th>#Pedido</th><th>Problema</th><th>Cliente</th><th>Teléfono</th><th>Detalle</th><th>Actualizado</th></tr></thead>
      <tbody>${open.map((i, index) => `<tr style="background:${index % 2 ? '#f7f4ec' : '#ffffff'};border-bottom:1px solid #ddd"><td><strong>${escapeHTML(i.orderNumber)}</strong></td><td>${escapeHTML(incidentTypeLabel(i.type))}</td><td>${escapeHTML(i.clientName || 'Desconocido')}</td><td>${escapeHTML(i.phone || 'Sin teléfono')}</td><td>${escapeHTML(i.detail || 'Sin detalle')}</td><td>${escapeHTML(formatIncidentDate(i))}</td></tr>`).join('')}</tbody>
    </table>
    <p style="color:#666;font-size:12px">Los casos abiertos volverán a aparecer en el siguiente reporte hasta que se marquen como resueltos.</p>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────
// Envío vía Resend API (HTTPS — funciona en Railway)
// ─────────────────────────────────────────────────────────────────
async function sendEmailViaResend(open) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.REPORT_EMAIL;
  if (!apiKey || !to) return false;
  const from = process.env.RESEND_FROM || 'onboarding@resend.dev';
  try {
    const resp = await axios.post('https://api.resend.com/emails', {
      from,
      to: [to],
      subject: `⚠️ ${open.length} problema${open.length === 1 ? '' : 's'} abierto${open.length === 1 ? '' : 's'} — The Alchemia Lab`,
      html: buildEmailHTML(open),
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    console.log('[REPORT EMAIL/Resend] OK | id:', resp.data?.id);
    return true;
  } catch (e) {
    console.error('[REPORT EMAIL/Resend]', e.response?.status, e.response?.data || e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────
// Fallback vía SMTP (nodemailer) — para uso fuera de Railway
// ─────────────────────────────────────────────────────────────────
async function sendEmailViaSMTP(open) {
  if (!process.env.SMTP_HOST) return false;
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: String(process.env.SMTP_SECURE || 'false') === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    });
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.REPORT_EMAIL || process.env.SMTP_USER,
      subject: `⚠️ ${open.length} problema${open.length === 1 ? '' : 's'} abierto${open.length === 1 ? '' : 's'} — The Alchemia Lab`,
      html: buildEmailHTML(open),
    });
    console.log('[REPORT EMAIL/SMTP] OK');
    return true;
  } catch (e) {
    console.error('[REPORT EMAIL/SMTP]', e.message);
    return false;
  }
}

async function sendEmailReport(incidents) {
  const open = incidents.filter(i => i.status === 'open');
  if (!open.length) {
    console.log('[REPORT EMAIL] 0 problemas abiertos — no se envía correo');
    return true;
  }
  // Preferir Resend (HTTPS) si está configurado; si no, intentar SMTP.
  if (process.env.RESEND_API_KEY) return await sendEmailViaResend(open);
  if (process.env.SMTP_HOST) return await sendEmailViaSMTP(open);
  console.log('[REPORT EMAIL] sin RESEND_API_KEY ni SMTP_HOST configurados');
  return false;
}

async function runDailyReport() {
  const incidents = getOpenIncidents();
  const waOk = await sendWhatsAppReport(incidents);
  const emailOk = await sendEmailReport(incidents);
  const data = readData();
  data.lastReport = new Date().toISOString();
  const dataFile = path.join(__dirname, '../data/incidents.json');
  try {
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
  } catch (e) { console.error('[REPORT persist]', e.message); }
  console.log(`[REPORT] Enviado — WA: ${waOk}, Email: ${emailOk}, problemas abiertos: ${incidents.length}`);
  return { incidents, waOk, emailOk };
}

function startScheduler() {
  // Hora operativa acordada para el reporte de incidencias. Se mantiene fija para
  // evitar que una variable antigua del proveedor reprograme el correo por error.
  const reportTime = '09:00';
  const [hour, minute] = reportTime.split(':');
  const cronExpr = `${minute} ${hour} * * *`;
  cron.schedule(cronExpr, () => {
    console.log(`[SCHEDULER] Ejecutando reporte diario a las ${reportTime}`);
    runDailyReport();
  }, { timezone: 'America/Mexico_City' });
  console.log(`[SCHEDULER] Reporte programado para las ${reportTime} (CDMX)`);
}

module.exports = {
  startScheduler,
  runDailyReport,
  // Exports adicionales para pruebas — no cambian el comportamiento en runtime.
  sendWhatsAppReport,
  sendEmailReport,
  sendEmailViaResend,
  sendEmailViaSMTP,
  buildEmailHTML,
  incidentTypeLabel,
};
