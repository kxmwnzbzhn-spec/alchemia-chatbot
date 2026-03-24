const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data/incidents.json');

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ incidents: [], lastReport: null }));
}

function readData() {
  ensureDataDir();
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { incidents: [], lastReport: null }; }
}

function writeData(data) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function registerIncident({ phone, orderNumber, type, detail, clientName }) {
  const data = readData();
  const existing = data.incidents.find(i => i.phone === phone && i.orderNumber === orderNumber && i.type === type && i.status === 'open');
  if (existing) { existing.count = (existing.count || 1) + 1; existing.lastUpdate = new Date().toISOString(); }
  else {
    data.incidents.push({
      id: Date.now().toString(),
      phone, orderNumber, type, detail,
      clientName: clientName || 'Desconocido',
      date: new Date().toISOString().split('T')[0],
      createdAt: new Date().toISOString(),
      lastUpdate: new Date().toISOString(),
      status: 'open', count: 1
    });
  }
  writeData(data);
}

function resolveIncident(id) {
  const data = readData();
  const inc = data.incidents.find(i => i.id === id);
  if (inc) { inc.status = 'resolved'; inc.resolvedAt = new Date().toISOString(); writeData(data); return true; }
  return false;
}

function getTodayIncidents() {
  const data = readData();
  const today = new Date().toISOString().split('T')[0];
  return data.incidents.filter(i => i.date === today);
}

function detectIncidentType(message) {
  const m = message.toLowerCase();
  if (m.includes('dañ') || m.includes('roto') || m.includes('danad')) return 'PRODUCTO_DANADO';
  if (m.includes('no llegó') || m.includes('no llego') || m.includes('no ha llegado') || m.includes('perdid')) return 'NO_ENTREGADO';
  if (m.includes('equivocad') || m.includes('incorrecto') || m.includes('mal producto')) return 'PRODUCTO_INCORRECTO';
  if (m.includes('reembolso') || m.includes('devolucion') || m.includes('devolución')) return 'SOLICITUD_REEMBOLSO';
  if (m.includes('no funciona') || m.includes('defecto')) return 'DEFECTO';
  return null;
}

function extractOrderNumber(message) {
  const match = message.match(/#?(\d{3,6})/);
  return match ? match[1] : null;
}

module.exports = { registerIncident, resolveIncident, getTodayIncidents, detectIncidentType, extractOrderNumber, readData };
