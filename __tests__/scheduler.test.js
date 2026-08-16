// Guardamos y restauramos process.env para no contaminar otras suites.
const ORIGINAL_ENV = { ...process.env };

// Estado del harness: recargamos el módulo en cada test para resetear mocks,
// y devolvemos las MISMAS referencias de mock que ve el módulo bajo prueba.
let scheduler;
let axios;
let nodemailer;
let cron;

function freshScheduler() {
  jest.resetModules();
  jest.doMock('node-cron', () => ({ schedule: jest.fn() }));
  jest.doMock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
  jest.doMock('nodemailer', () => ({ createTransport: jest.fn() }));
  jest.doMock('../src/incidents', () => ({
    getTodayIncidents: jest.fn(() => []),
    getOpenIncidents: jest.fn(() => []),
    readData: jest.fn(() => ({ incidents: [], lastReport: null })),
  }));
  axios = require('axios');
  nodemailer = require('nodemailer');
  cron = require('node-cron');
  return require('../src/scheduler');
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  // Limpieza agresiva de variables que afectan las funciones bajo prueba.
  delete process.env.WHATSAPP_TOKEN;
  delete process.env.ADMIN_WHATSAPP_PHONE;
  delete process.env.WHATSAPP_PHONE_ID;
  delete process.env.RESEND_API_KEY;
  delete process.env.REPORT_EMAIL;
  delete process.env.RESEND_FROM;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_SECURE;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.PUBLIC_URL;
  delete process.env.REPORT_TIME;
  scheduler = freshScheduler();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('scheduler.js — buildEmailHTML', () => {
  test('renderiza tabla HTML con filas por incidente', () => {
    const html = scheduler.buildEmailHTML([
      { orderNumber: '1521', type: 'PRODUCTO_DANADO', clientName: 'Juan', phone: '555', detail: 'La caja llegó rota' },
      { orderNumber: '999',  type: 'DEFECTO',         clientName: 'Ana',  phone: '777', detail: 'Atomizador defectuoso' },
    ]);
    expect(html).toContain('Total de problemas abiertos: <strong>2</strong>');
    expect(html).toContain('<strong>1521</strong>');
    expect(html).toContain('Producto dañado');
    expect(html).toContain('<td>Juan</td>');
    expect(html).toContain('<td>555</td>');
    expect(html).toContain('<strong>999</strong>');
    expect(html).toContain('<td>Ana</td>');
    expect(html).toContain('La caja llegó rota');
  });

  test('maneja lista vacía sin errores', () => {
    const html = scheduler.buildEmailHTML([]);
    expect(html).toContain('Total de problemas abiertos: <strong>0</strong>');
  });

  test('escapa contenido enviado por clientes', () => {
    const html = scheduler.buildEmailHTML([
      { orderNumber: '1', type: 'DEFECTO', clientName: '<b>Ana</b>', phone: '777', detail: '<script>alert(1)</script>' },
    ]);
    expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('scheduler.js — sendWhatsAppReport', () => {
  test('devuelve false si no hay WHATSAPP_TOKEN', async () => {
    process.env.ADMIN_WHATSAPP_PHONE = '5215551234567';
    const ok = await scheduler.sendWhatsAppReport([
      { orderNumber: '1', type: 'DEFECTO', clientName: 'x', phone: 'y', status: 'open' },
    ]);
    expect(ok).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('devuelve false si no hay ADMIN_WHATSAPP_PHONE', async () => {
    process.env.WHATSAPP_TOKEN = 'tok';
    const ok = await scheduler.sendWhatsAppReport([
      { orderNumber: '1', type: 'DEFECTO', clientName: 'x', phone: 'y', status: 'open' },
    ]);
    expect(ok).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('devuelve true sin llamar API cuando no hay incidentes "open"', async () => {
    process.env.WHATSAPP_TOKEN = 'tok';
    process.env.ADMIN_WHATSAPP_PHONE = '52555';
    process.env.WHATSAPP_PHONE_ID = 'PID';
    const ok = await scheduler.sendWhatsAppReport([
      { status: 'resolved', orderNumber: '1', type: 'X', clientName: 'x', phone: 'y' },
    ]);
    expect(ok).toBe(true);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('envía a Graph API y filtra por status=open', async () => {
    process.env.WHATSAPP_TOKEN = 'tok';
    process.env.ADMIN_WHATSAPP_PHONE = '52555';
    process.env.WHATSAPP_PHONE_ID = 'PID';
    axios.post.mockResolvedValue({ data: { messages: [{ id: 'wamid.1' }] } });

    const ok = await scheduler.sendWhatsAppReport([
      { status: 'open',     orderNumber: '1', type: 'PRODUCTO_DANADO', clientName: 'Juan', phone: '111' },
      { status: 'resolved', orderNumber: '2', type: 'DEFECTO',         clientName: 'Ana',  phone: '222' },
    ]);
    expect(ok).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = axios.post.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v22.0/PID/messages');
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe('52555');
    expect(body.type).toBe('text');
    // El cuerpo sólo contiene el abierto
    expect(body.text.body).toContain('Total problemas abiertos: *1*');
    expect(body.text.body).toContain('#1');
    expect(body.text.body).not.toContain('#2');
    expect(config.headers.Authorization).toBe('Bearer tok');
  });

  test('devuelve false cuando axios falla', async () => {
    process.env.WHATSAPP_TOKEN = 'tok';
    process.env.ADMIN_WHATSAPP_PHONE = '52555';
    process.env.WHATSAPP_PHONE_ID = 'PID';
    axios.post.mockRejectedValue(new Error('network down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ok = await scheduler.sendWhatsAppReport([
      { status: 'open', orderNumber: '1', type: 'X', clientName: 'x', phone: 'y' },
    ]);
    expect(ok).toBe(false);
    spy.mockRestore();
  });
});

describe('scheduler.js — sendEmailReport (routing)', () => {
  test('devuelve true sin enviar cuando no hay incidentes abiertos', async () => {
    const ok = await scheduler.sendEmailReport([
      { status: 'resolved', orderNumber: '1', type: 'X', clientName: 'x', phone: 'y' },
    ]);
    expect(ok).toBe(true);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('usa Resend cuando RESEND_API_KEY está definido', async () => {
    process.env.RESEND_API_KEY = 'resend-key';
    process.env.REPORT_EMAIL = 'admin@example.com';
    axios.post.mockResolvedValue({ data: { id: 'em_1' } });

    const ok = await scheduler.sendEmailReport([
      { status: 'open', orderNumber: '1', type: 'X', clientName: 'x', phone: 'y' },
    ]);
    expect(ok).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post.mock.calls[0][0]).toBe('https://api.resend.com/emails');
  });

  test('devuelve false si no hay proveedor configurado', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await scheduler.sendEmailReport([
      { status: 'open', orderNumber: '1', type: 'X', clientName: 'x', phone: 'y' },
    ]);
    expect(ok).toBe(false);
    spy.mockRestore();
  });

  test('cae a SMTP si Resend no está pero SMTP_HOST sí', async () => {
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
    process.env.REPORT_EMAIL = 'a@b.c';
    const sendMail = jest.fn().mockResolvedValue({});
    nodemailer.createTransport.mockReturnValue({ sendMail });

    const ok = await scheduler.sendEmailReport([
      { status: 'open', orderNumber: '1', type: 'X', clientName: 'x', phone: 'y' },
    ]);
    expect(ok).toBe(true);
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.test' }),
    );
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('scheduler.js — sendEmailViaResend', () => {
  test('devuelve false sin apiKey o destinatario', async () => {
    expect(await scheduler.sendEmailViaResend([])).toBe(false);
    process.env.RESEND_API_KEY = 'k';
    expect(await scheduler.sendEmailViaResend([])).toBe(false); // falta REPORT_EMAIL
  });

  test('POSTea con el header Authorization correcto', async () => {
    process.env.RESEND_API_KEY = 'secret-key';
    process.env.REPORT_EMAIL = 'report@example.com';
    axios.post.mockResolvedValue({ data: { id: 'em_abc' } });

    const ok = await scheduler.sendEmailViaResend([
      { orderNumber: '1', type: 'X', clientName: 'x', phone: 'y' },
    ]);
    expect(ok).toBe(true);
    const [url, body, config] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(body.to).toEqual(['report@example.com']);
    expect(body.from).toBe('onboarding@resend.dev'); // default
    expect(config.headers.Authorization).toBe('Bearer secret-key');
    expect(config.timeout).toBe(15000);
  });

  test('usa RESEND_FROM cuando está definido', async () => {
    process.env.RESEND_API_KEY = 'k';
    process.env.REPORT_EMAIL = 'r@e.com';
    process.env.RESEND_FROM = 'alma@alchemialab.com';
    axios.post.mockResolvedValue({ data: { id: '1' } });
    await scheduler.sendEmailViaResend([{ orderNumber: '1', type: 'X', clientName: 'x', phone: 'y' }]);
    expect(axios.post.mock.calls[0][1].from).toBe('alma@alchemialab.com');
  });

  test('devuelve false si Resend falla', async () => {
    process.env.RESEND_API_KEY = 'k';
    process.env.REPORT_EMAIL = 'r@e.com';
    axios.post.mockRejectedValue({ response: { status: 500, data: 'boom' } });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ok = await scheduler.sendEmailViaResend([{ orderNumber: '1', type: 'X', clientName: 'x', phone: 'y' }]);
    expect(ok).toBe(false);
    spy.mockRestore();
  });
});

describe('scheduler.js — sendEmailViaSMTP', () => {
  test('devuelve false sin SMTP_HOST', async () => {
    expect(await scheduler.sendEmailViaSMTP([])).toBe(false);
  });

  test('crea transport con valores derivados del entorno', async () => {
    process.env.SMTP_HOST = 'mail.example.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_SECURE = 'true';
    process.env.SMTP_USER = 'u@e.com';
    process.env.SMTP_PASS = 'pw';
    process.env.REPORT_EMAIL = 'admin@e.com';
    const sendMail = jest.fn().mockResolvedValue({});
    nodemailer.createTransport.mockReturnValue({ sendMail });

    const ok = await scheduler.sendEmailViaSMTP([{ orderNumber: '1', type: 'X', clientName: 'x', phone: 'y' }]);
    expect(ok).toBe(true);
    const cfg = nodemailer.createTransport.mock.calls[0][0];
    expect(cfg).toMatchObject({
      host: 'mail.example.com',
      port: 465,
      secure: true,
      auth: { user: 'u@e.com', pass: 'pw' },
    });
    expect(sendMail.mock.calls[0][0]).toMatchObject({
      from: 'u@e.com',
      to: 'admin@e.com',
    });
  });

  test('puerto por defecto 587 y secure=false', async () => {
    process.env.SMTP_HOST = 'm';
    process.env.SMTP_USER = 'u';
    nodemailer.createTransport.mockReturnValue({ sendMail: jest.fn().mockResolvedValue({}) });
    await scheduler.sendEmailViaSMTP([{ orderNumber: '1', type: 'X', clientName: 'x', phone: 'y' }]);
    const cfg = nodemailer.createTransport.mock.calls[0][0];
    expect(cfg.port).toBe(587);
    expect(cfg.secure).toBe(false);
  });
});

describe('scheduler.js — startScheduler', () => {
  test('programa cron con REPORT_TIME por defecto 09:00 en CDMX', () => {
    scheduler.startScheduler();
    expect(cron.schedule).toHaveBeenCalledTimes(1);
    const [expr, , opts] = cron.schedule.mock.calls[0];
    expect(expr).toBe('00 09 * * *');
    expect(opts).toEqual({ timezone: 'America/Mexico_City' });
  });

  test('usa REPORT_TIME cuando se define', () => {
    process.env.REPORT_TIME = '18:30';
    scheduler = freshScheduler();
    scheduler.startScheduler();
    expect(cron.schedule.mock.calls[0][0]).toBe('30 18 * * *');
  });
});
