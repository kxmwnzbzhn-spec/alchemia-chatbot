const cron = require('node-cron');
const nodemailer = require('nodemailer');
const axios = require('axios');
const { getTodayIncidents, readData } = require('./incidents');
const fs = require('fs');
const path = require('path');

async function sendWhatsAppReport(incidents) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.ADMIN_WHATSAPP_PHONE) return false;
  try {
    const open = incidents.filter(i => i.status === 'open');
    if (!open.length) return true;
    const text = `📊 *Reporte diario — The Alchemia Lab*\n\n` +
      `Total incidencias hoy: *${open.length}*\n\n` +
      open.slice(0, 10).map((i, n) =>
        `${n + 1}. *#${i.orderNumber}* — ${i.type}\n   Cliente: ${i.clientName}\n   Tel: ${i.phone}`
      ).join('\n\n') +
      `\n\nPanel: ${process.env.PUBLIC_URL || 'https://tu-app.railway.app'}`;
    await axios.post(`https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      messaging_product: 'whatsapp', to: process.env.ADMIN_WHATSAPP_PHONE,
      type: 'text', text: { body: text }
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    return true;
  } catch (e) { console.error('[REPORT WA]', e.message); return false; }
}

async function sendEmailReport(incidents) {
  if (!process.env.SMTP_HOST) return false;
  try {
    const transporter = nodemailer.createTransporter({
      host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587'),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    const open = incidents.filter(i => i.status === 'open');
    const html = `<h2>Reporte diario — The Alchemia Lab</h2>
      <p>Total incidencias abiertas: <strong>${open.length}</strong></p>
      <table border="1" cellpadding="8" style="border-collapse:collapse">
        <tr><th>#Pedido</th><th>Tipo</th><th>Cliente</th><th>Teléfono</th></tr>
        ${open.map(i => `<tr><td>${i.orderNumber}</td><td>${i.type}</td><td>${i.clientName}</td><td>${i.phone}</td></tr>`).join('')}
      </table>`;
    await transporter.sendMail({
      from: process.env.SMTP_USER, to: process.env.REPORT_EMAIL || process.env.SMTP_USER,
      subject: `📊 Reporte diario chatbot — ${new Date().toLocaleDateString('es-MX')}`,
      html
    });
    return true;
  } catch (e) { console.error('[REPORT EMAIL]', e.message); return false; }
}

async function runDailyReport() {
  const incidents = getTodayIncidents();
  const waOk = await sendWhatsAppReport(incidents);
  const emailOk = await sendEmailReport(incidents);
  const data = require('./incidents').readData();
  data.lastReport = new Date().toISOString();
  const fs2 = require('fs');
  const path2 = require('path');
  const dataFile = path2.join(__dirname, '../data/incidents.json');
  fs2.writeFileSync(dataFile, JSON.stringify(data, null, 2));
  console.log(`[REPORT] Enviado — WA: ${waOk}, Email: ${emailOk}, incidencias: ${incidents.length}`);
  return { incidents, waOk, emailOk };
}

function startScheduler() {
  const reportTime = process.env.REPORT_TIME || '09:00';
  const [hour, minute] = reportTime.split(':');
  const cronExpr = `${minute} ${hour} * * *`;
  cron.schedule(cronExpr, () => {
    console.log(`[SCHEDULER] Ejecutando reporte diario a las ${reportTime}`);
    runDailyReport();
  }, { timezone: 'America/Mexico_City' });
  console.log(`[SCHEDULER] Reporte programado para las ${reportTime} (CDMX)`);
}

module.exports = { startScheduler, runDailyReport };
