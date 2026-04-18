const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislamos el archivo de datos de producción: creamos un tmpdir por suite
// y apuntamos el módulo a un data/incidents.json dentro de ese tmp.
// Como el módulo resuelve DATA_FILE en tiempo de require con __dirname,
// usamos jest.isolateModules() + mock de path.join para reubicar la ruta.

function loadFreshIncidentsModule(tmpRoot) {
  // Forzamos que path.join(__dirname, '../data/incidents.json') → tmpRoot/data/incidents.json
  jest.resetModules();
  jest.doMock('path', () => {
    const realPath = jest.requireActual('path');
    return {
      ...realPath,
      join: (...parts) => {
        // Detectamos la llamada exacta del módulo: [__dirname, '../data/incidents.json']
        if (parts.length === 2 && parts[1] === '../data/incidents.json') {
          return realPath.join(tmpRoot, 'data', 'incidents.json');
        }
        return realPath.join(...parts);
      },
    };
  });
  return require('../src/incidents');
}

describe('incidents.js — detectIncidentType', () => {
  const { detectIncidentType } = require('../src/incidents');

  test.each([
    ['Mi frasco llegó dañado', 'PRODUCTO_DANADO'],
    ['El perfume está roto', 'PRODUCTO_DANADO'],
    ['producto danado en el envio', 'PRODUCTO_DANADO'],
    ['Mi pedido no llegó', 'NO_ENTREGADO'],
    ['no llego nada', 'NO_ENTREGADO'],
    ['El paquete no ha llegado', 'NO_ENTREGADO'],
    ['creo que se perdido el envío', 'NO_ENTREGADO'],
    ['Me mandaron un producto equivocado', 'PRODUCTO_INCORRECTO'],
    ['Es incorrecto lo que recibí', 'PRODUCTO_INCORRECTO'],
    ['Me llegó mal producto', 'PRODUCTO_INCORRECTO'],
    ['Quiero un reembolso', 'SOLICITUD_REEMBOLSO'],
    ['Necesito hacer una devolucion', 'SOLICITUD_REEMBOLSO'],
    ['Solicito devolución', 'SOLICITUD_REEMBOLSO'],
    ['El difusor no funciona', 'DEFECTO'],
    ['Tiene un defecto', 'DEFECTO'],
  ])('clasifica "%s" como %s', (msg, expected) => {
    expect(detectIncidentType(msg)).toBe(expected);
  });

  test('devuelve null para mensajes sin palabras clave', () => {
    expect(detectIncidentType('Hola, ¿tienen perfume de oud?')).toBeNull();
    expect(detectIncidentType('Quiero ver mis pedidos')).toBeNull();
    expect(detectIncidentType('')).toBeNull();
  });

  test('es case-insensitive (usa toLowerCase)', () => {
    expect(detectIncidentType('PRODUCTO DAÑADO')).toBe('PRODUCTO_DANADO');
    expect(detectIncidentType('QUIERO UN REEMBOLSO YA')).toBe('SOLICITUD_REEMBOLSO');
  });

  test('respeta la prioridad (el primer match gana)', () => {
    // "dañ" antes que "reembolso" en el if-chain
    expect(detectIncidentType('dañado, quiero reembolso')).toBe('PRODUCTO_DANADO');
  });
});

describe('incidents.js — extractOrderNumber', () => {
  const { extractOrderNumber } = require('../src/incidents');

  test('extrae número con símbolo #', () => {
    expect(extractOrderNumber('consulta mi #1521')).toBe('1521');
    expect(extractOrderNumber('#999')).toBe('999');
  });

  test('extrae número con palabra "pedido"', () => {
    expect(extractOrderNumber('mi pedido 1521')).toBe('1521');
    expect(extractOrderNumber('Pedido #1234')).toBe('1234');
    expect(extractOrderNumber('pedido   12345')).toBe('12345');
  });

  test('extrae número con palabra "orden"', () => {
    expect(extractOrderNumber('orden 9876')).toBe('9876');
    expect(extractOrderNumber('orden número 4321')).toBe('4321');
    expect(extractOrderNumber('ORDEN NUMERO 4321')).toBe('4321');
  });

  test('NO confunde precios con números de pedido', () => {
    expect(extractOrderNumber('cuesta $499 el perfume')).toBeNull();
    expect(extractOrderNumber('$1200 me parece caro')).toBeNull();
  });

  test('NO confunde volúmenes (100ml) con números de pedido', () => {
    expect(extractOrderNumber('tienen 100ml disponible')).toBeNull();
    expect(extractOrderNumber('quiero 50 ml')).toBeNull();
  });

  test('NO confunde años sueltos con pedidos', () => {
    expect(extractOrderNumber('desde 2024 soy cliente')).toBeNull();
  });

  test('requiere entre 3 y 6 dígitos', () => {
    expect(extractOrderNumber('pedido 12')).toBeNull();         // 2 dígitos: falla
    expect(extractOrderNumber('pedido 123')).toBe('123');       // 3 dígitos: ok
    expect(extractOrderNumber('pedido 123456')).toBe('123456'); // 6 dígitos: ok
    // con 7 dígitos solo captura los primeros 6 (regex \d{3,6} greedy)
    expect(extractOrderNumber('pedido 1234567')).toBe('123456');
  });

  test('devuelve null cuando no hay contexto', () => {
    expect(extractOrderNumber('1234')).toBeNull();
    expect(extractOrderNumber('hola')).toBeNull();
    expect(extractOrderNumber('')).toBeNull();
  });
});

describe('incidents.js — persistencia y lógica de negocio', () => {
  let tmpRoot;
  let incidents;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alchemia-incidents-'));
    incidents = loadFreshIncidentsModule(tmpRoot);
  });

  afterEach(() => {
    jest.dontMock('path');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('readData inicializa archivo vacío si no existe', () => {
    const data = incidents.readData();
    expect(data).toEqual({ incidents: [], lastReport: null });
    expect(fs.existsSync(path.join(tmpRoot, 'data', 'incidents.json'))).toBe(true);
  });

  test('readData devuelve fallback si el JSON es inválido', () => {
    const file = path.join(tmpRoot, 'data', 'incidents.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ json corrupto');
    const data = incidents.readData();
    expect(data).toEqual({ incidents: [], lastReport: null });
  });

  test('registerIncident crea un incidente nuevo con campos correctos', () => {
    incidents.registerIncident({
      phone: '5215551234567',
      orderNumber: '1521',
      type: 'PRODUCTO_DANADO',
      detail: 'Frasco roto',
      clientName: 'Juan',
    });
    const data = incidents.readData();
    expect(data.incidents).toHaveLength(1);
    const inc = data.incidents[0];
    expect(inc).toMatchObject({
      phone: '5215551234567',
      orderNumber: '1521',
      type: 'PRODUCTO_DANADO',
      detail: 'Frasco roto',
      clientName: 'Juan',
      status: 'open',
      count: 1,
    });
    expect(inc.id).toBeDefined();
    expect(inc.createdAt).toBeDefined();
    expect(inc.lastUpdate).toBeDefined();
    expect(inc.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('registerIncident usa "Desconocido" cuando falta clientName', () => {
    incidents.registerIncident({
      phone: '5215551234567',
      orderNumber: '100',
      type: 'NO_ENTREGADO',
      detail: 'x',
    });
    expect(incidents.readData().incidents[0].clientName).toBe('Desconocido');
  });

  test('registerIncident incrementa count en duplicados abiertos', () => {
    const common = {
      phone: '5215551234567',
      orderNumber: '1521',
      type: 'PRODUCTO_DANADO',
      detail: 'primer contacto',
      clientName: 'Juan',
    };
    incidents.registerIncident(common);
    incidents.registerIncident({ ...common, detail: 'segundo contacto' });
    incidents.registerIncident({ ...common, detail: 'tercer contacto' });

    const data = incidents.readData();
    expect(data.incidents).toHaveLength(1);
    expect(data.incidents[0].count).toBe(3);
    // El detail original se conserva (sólo count y lastUpdate cambian)
    expect(data.incidents[0].detail).toBe('primer contacto');
  });

  test('registerIncident crea registros distintos para distintos (phone, orderNumber, type)', () => {
    incidents.registerIncident({ phone: 'A', orderNumber: '1', type: 'PRODUCTO_DANADO', detail: 'x' });
    incidents.registerIncident({ phone: 'A', orderNumber: '2', type: 'PRODUCTO_DANADO', detail: 'x' });
    incidents.registerIncident({ phone: 'B', orderNumber: '1', type: 'PRODUCTO_DANADO', detail: 'x' });
    incidents.registerIncident({ phone: 'A', orderNumber: '1', type: 'NO_ENTREGADO',   detail: 'x' });
    expect(incidents.readData().incidents).toHaveLength(4);
  });

  test('registerIncident NO dedup-a con incidentes resueltos', () => {
    incidents.registerIncident({ phone: 'A', orderNumber: '1', type: 'PRODUCTO_DANADO', detail: 'x' });
    const id = incidents.readData().incidents[0].id;
    incidents.resolveIncident(id);
    // mismo set de claves, pero el anterior ya no está "open" → debe crear uno nuevo
    incidents.registerIncident({ phone: 'A', orderNumber: '1', type: 'PRODUCTO_DANADO', detail: 'x' });
    const all = incidents.readData().incidents;
    expect(all).toHaveLength(2);
    expect(all[0].status).toBe('resolved');
    expect(all[1].status).toBe('open');
  });

  test('resolveIncident marca como resolved y devuelve true', () => {
    incidents.registerIncident({ phone: 'A', orderNumber: '1', type: 'DEFECTO', detail: 'x' });
    const id = incidents.readData().incidents[0].id;
    expect(incidents.resolveIncident(id)).toBe(true);
    const inc = incidents.readData().incidents[0];
    expect(inc.status).toBe('resolved');
    expect(inc.resolvedAt).toBeDefined();
  });

  test('resolveIncident devuelve false si el id no existe', () => {
    expect(incidents.resolveIncident('id-inexistente')).toBe(false);
  });

  test('getTodayIncidents filtra por fecha de hoy', () => {
    incidents.registerIncident({ phone: 'A', orderNumber: '1', type: 'DEFECTO', detail: 'hoy' });
    // Inyectar uno de ayer directamente en el archivo
    const data = incidents.readData();
    data.incidents.push({
      id: '999',
      phone: 'B', orderNumber: '2', type: 'DEFECTO', detail: 'ayer', clientName: 'X',
      date: '2000-01-01',
      createdAt: '2000-01-01T00:00:00.000Z',
      lastUpdate: '2000-01-01T00:00:00.000Z',
      status: 'open', count: 1,
    });
    fs.writeFileSync(
      path.join(tmpRoot, 'data', 'incidents.json'),
      JSON.stringify(data, null, 2),
    );

    const today = incidents.getTodayIncidents();
    expect(today).toHaveLength(1);
    expect(today[0].detail).toBe('hoy');
  });

  test('persistencia sobrevive a múltiples cargas del módulo', () => {
    incidents.registerIncident({ phone: 'A', orderNumber: '1', type: 'DEFECTO', detail: 'x' });
    // Recargar el módulo apuntando al mismo tmpRoot
    const reloaded = loadFreshIncidentsModule(tmpRoot);
    expect(reloaded.readData().incidents).toHaveLength(1);
  });
});
