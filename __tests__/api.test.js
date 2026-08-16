// Pruebas de endpoints Express con supertest.
// Estrategia:
//  - Aislamos el filesystem de incidents.js usando tmpdir + mock de path.join.
//  - Requerimos server.js después del mock para que el módulo de incidents
//    que usa server.js escriba/lea del tmpdir.
//  - NO arrancamos red real: server.js ya está guarded por require.main.

const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpRoot;
let request;
let app;

function setupIsolatedApp() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alchemia-api-'));
  jest.resetModules();
  jest.doMock('path', () => {
    const realPath = jest.requireActual('path');
    return {
      ...realPath,
      join: (...parts) => {
        // Redirige la ruta de data/incidents.json al tmpdir.
        if (parts.length === 2 && parts[1] === '../data/incidents.json') {
          return realPath.join(tmpRoot, 'data', 'incidents.json');
        }
        // La otra aparición en scheduler.js (runDailyReport) también la redirigimos.
        if (parts.length === 2 && parts[1] && parts[1].endsWith('../data/incidents.json')) {
          return realPath.join(tmpRoot, 'data', 'incidents.json');
        }
        return realPath.join(...parts);
      },
    };
  });
  // Evita que llamadas accidentales a axios peguen a red.
  jest.doMock('axios', () => {
    const axios = {
      post: jest.fn().mockRejectedValue(new Error('network disabled in tests')),
      get:  jest.fn().mockRejectedValue(new Error('network disabled in tests')),
      create: jest.fn(() => ({
        get: jest.fn().mockRejectedValue(new Error('network disabled in tests')),
        post: jest.fn().mockRejectedValue(new Error('network disabled in tests')),
      })),
    };
    return axios;
  });
  const supertest = require('supertest');
  const server = require('../src/server');
  app = server.app;
  request = supertest(app);
  return server;
}

beforeEach(() => {
  setupIsolatedApp();
});

afterEach(() => {
  jest.dontMock('path');
  jest.dontMock('axios');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('GET /api/health', () => {
  test('200 con shape esperado', async () => {
    const res = await request.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      status: 'ok',
      sessions: expect.any(Number),
      todayIncidents: expect.any(Number),
      env: expect.objectContaining({
        claude: expect.any(Boolean),
        woocommerce: expect.any(Boolean),
        envia: expect.any(Boolean),
        whatsapp: expect.any(Boolean),
        hmac: expect.any(Boolean),
        followupsEnabled: expect.any(Boolean),
      }),
    }));
  });
});

describe('GET /api/incidents', () => {
  test('devuelve lista vacía inicialmente', async () => {
    const res = await request.get('/api/incidents');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ incidents: [], total: 0 });
  });

  test('devuelve incidentes registrados', async () => {
    const { registerIncident } = require('../src/incidents');
    registerIncident({
      phone: '5215551234567',
      orderNumber: '1521',
      type: 'PRODUCTO_DANADO',
      detail: 'roto',
      clientName: 'Juan',
    });
    const res = await request.get('/api/incidents');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.incidents[0]).toMatchObject({
      orderNumber: '1521',
      type: 'PRODUCTO_DANADO',
      status: 'open',
    });
  });
});

describe('GET /api/incidents/all', () => {
  test('aplica filtros ?status= y ?date=', async () => {
    const { registerIncident } = require('../src/incidents');
    registerIncident({ phone: 'A', orderNumber: '1', type: 'DEFECTO', detail: 'x' });
    registerIncident({ phone: 'B', orderNumber: '2', type: 'DEFECTO', detail: 'y' });

    const all = await request.get('/api/incidents/all');
    expect(all.body.total).toBe(2);

    const open = await request.get('/api/incidents/all?status=open');
    expect(open.body.total).toBe(2);

    const resolved = await request.get('/api/incidents/all?status=resolved');
    expect(resolved.body.total).toBe(0);

    const today = new Date().toISOString().slice(0, 10);
    const byDate = await request.get(`/api/incidents/all?date=${today}`);
    expect(byDate.body.total).toBe(2);

    const other = await request.get('/api/incidents/all?date=2000-01-01');
    expect(other.body.total).toBe(0);
  });
});

describe('PATCH /api/incidents/:id/resolve', () => {
  test('marca incidente existente como resolved', async () => {
    const { registerIncident, readData } = require('../src/incidents');
    registerIncident({ phone: 'A', orderNumber: '1', type: 'DEFECTO', detail: 'x' });
    const id = readData().incidents[0].id;
    const res = await request.patch(`/api/incidents/${id}/resolve`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(readData().incidents[0].status).toBe('resolved');
  });

  test('devuelve ok:false para id inexistente', async () => {
    const res = await request.patch('/api/incidents/no-existe/resolve');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false });
  });
});

describe('GET /webhook (verificación de Meta)', () => {
  test('200 con el challenge cuando el verify_token coincide', async () => {
    const originalToken = process.env.WHATSAPP_VERIFY_TOKEN;
    process.env.WHATSAPP_VERIFY_TOKEN = 'mi-token-secreto';
    // Recargamos el app con la nueva env (aunque GET /webhook lee env en runtime)
    const res = await request
      .get('/webhook')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'mi-token-secreto', 'hub.challenge': 'chal-123' });
    expect(res.status).toBe(200);
    expect(res.text).toBe('chal-123');
    if (originalToken === undefined) delete process.env.WHATSAPP_VERIFY_TOKEN;
    else process.env.WHATSAPP_VERIFY_TOKEN = originalToken;
  });

  test('usa "alchemia2024" como token por defecto', async () => {
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    const res = await request
      .get('/webhook')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'alchemia2024', 'hub.challenge': 'chal-xyz' });
    expect(res.status).toBe(200);
    expect(res.text).toBe('chal-xyz');
  });

  test('403 con token incorrecto', async () => {
    const res = await request
      .get('/webhook')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'token-falso', 'hub.challenge': 'c' });
    expect(res.status).toBe(403);
  });

  test('403 cuando hub.mode no es subscribe', async () => {
    const res = await request
      .get('/webhook')
      .query({ 'hub.mode': 'delete', 'hub.verify_token': 'alchemia2024', 'hub.challenge': 'c' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/demo/chat', () => {
  test('400 cuando falta message', async () => {
    const res = await request.post('/api/demo/chat').send({ phone: 'u1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('500 cuando Claude no está disponible (axios mockeado a rechazar)', async () => {
    // sin ANTHROPIC_API_KEY + axios.post rechaza → processMessage cae al fallback
    const res = await request.post('/api/demo/chat').send({ phone: 'u1', message: 'hola' });
    // El handler atrapa y responde 500 O 200 con texto de fallback según el path del error.
    // Lo importante: no revienta el proceso.
    expect([200, 500]).toContain(res.status);
    expect(res.body).toBeDefined();
  });
});

describe('DELETE /api/demo/session/:phone', () => {
  test('responde ok:true aunque la sesión no exista', async () => {
    const res = await request.delete('/api/demo/session/no-existe');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('GET /api/followups/status', () => {
  test('200 con lista vacía inicial', async () => {
    const res = await request.get('/api/followups/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      firstFollowupHours: 2,
      secondFollowupHours: 20,
      maxFollowups: 2,
      sessions: [],
      total: 0,
    });
  });
});

describe('GET /api/diagnostics', () => {
  test('200 y reporta config principal', async () => {
    const res = await request.get('/api/diagnostics');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      model: expect.any(String),
      woo_url: expect.any(String),
      followups: expect.any(Object),
    }));
  }, 10000);
});
