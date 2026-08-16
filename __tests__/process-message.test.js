// Tests del loop de tool_use en processMessage.
// Mockeamos:
//   - axios.post → Claude API
//   - axios.create() → instance WooCommerce
// Para no tocar red.

const fs = require('fs');
const os = require('os');
const path = require('path');

let mockWoo;
let mockAxiosPost;
let server;
let tmpRoot;

function loadServer() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alchemia-pm-'));
  mockWoo = { get: jest.fn(), post: jest.fn() };
  mockAxiosPost = jest.fn();
  jest.resetModules();
  // Aisla incidents.json en tmpdir para no contaminar data/ de producción.
  jest.doMock('path', () => {
    const realPath = jest.requireActual('path');
    return {
      ...realPath,
      join: (...parts) => {
        if (parts.length === 2 && parts[1] === '../data/incidents.json') {
          return realPath.join(tmpRoot, 'data', 'incidents.json');
        }
        return realPath.join(...parts);
      },
    };
  });
  jest.doMock('axios', () => ({
    create: jest.fn(() => mockWoo),
    post: mockAxiosPost,
    get: jest.fn().mockRejectedValue(new Error('no network')),
  }));
  server = require('../src/server');
  return server;
}

beforeEach(() => {
  loadServer();
  // Limpiamos sesiones residuales entre tests (el Map es el mismo module-level).
  server.sessions.clear();
});

afterEach(() => {
  jest.dontMock('axios');
  jest.dontMock('path');
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('processMessage — loop de Claude', () => {
  test('end_turn inmediato: devuelve el texto de Claude sin tools', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '¡Hola! ¿En qué te ayudo? 🌿' }],
      },
    });
    const result = await server.processMessage('52555', 'hola');
    expect(result.text).toBe('¡Hola! ¿En qué te ayudo? 🌿');
    expect(result.productImage).toBeNull();
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockAxiosPost.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.tools).toBeDefined();
    expect(config.headers['anthropic-version']).toBe('2023-06-01');
  });

  test('tool_use → ejecuta buscar_productos → Claude responde con texto final', async () => {
    // 1er turno: Claude pide usar buscar_productos
    mockAxiosPost
      .mockResolvedValueOnce({
        data: {
          stop_reason: 'tool_use',
          content: [{
            type: 'tool_use', id: 'tu_1', name: 'buscar_productos',
            input: { query: 'cenote' },
          }],
        },
      })
      // 2º turno: Claude, tras ver el tool_result, responde texto final
      .mockResolvedValueOnce({
        data: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '*Cenote Azul* — $499 MXN' }],
        },
      });
    // WooCommerce /products devuelve un resultado
    mockWoo.get.mockResolvedValueOnce({
      data: [{
        id: 1, slug: 'cenote-azul', name: 'Cenote Azul',
        price: '499', regular_price: '499',
        stock_status: 'instock', categories: [], tags: [],
        images: [{ src: 'https://img/1.jpg' }], permalink: 'https://shop/cenote-azul',
      }],
    });

    const result = await server.processMessage('52555', 'busco cenote');
    expect(result.text).toContain('Cenote Azul');
    // Un único producto con imagen → debe proponer productImage
    expect(result.productImage).toEqual({
      imageUrl: 'https://img/1.jpg',
      caption: expect.stringContaining('Cenote Azul'),
    });
    // Verifica que Claude se llamó 2 veces (tool + end_turn)
    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
  });

  test('actualiza session.lastShownProducts al ejecutar buscar_productos', async () => {
    mockAxiosPost
      .mockResolvedValueOnce({
        data: {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'buscar_productos', input: { query: 'oud' } }],
        },
      })
      .mockResolvedValueOnce({
        data: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
      });
    mockWoo.get.mockResolvedValueOnce({
      data: [
        { id: 1, slug: 'oud-1', name: 'Oud 1', price: '1', stock_status: 'instock', categories: [], tags: [], images: [], permalink: 'u1' },
        { id: 2, slug: 'oud-2', name: 'Oud 2', price: '2', stock_status: 'instock', categories: [], tags: [], images: [], permalink: 'u2' },
      ],
    });

    await server.processMessage('52000', 'busco oud');
    const session = server.sessions.get('52000');
    expect(session.lastShownProducts).toEqual([
      {
        id: 1, slug: 'oud-1', name: 'Oud 1', link: 'u1',
        price: '1', regularPrice: undefined, onSale: false, stockStatus: 'instock',
      },
      {
        id: 2, slug: 'oud-2', name: 'Oud 2', link: 'u2',
        price: '2', regularPrice: undefined, onSale: false, stockStatus: 'instock',
      },
    ]);
  });

  test('trunca historial alrededor de 20 mensajes', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
    });
    // Llenamos la sesión con 25 mensajes
    for (let i = 0; i < 25; i++) {
      await server.processMessage('52111', `msg ${i}`);
    }
    const session = server.sessions.get('52111');
    // El trim ocurre tras push del user; luego se agrega assistant → máx 21
    expect(session.history.length).toBeLessThanOrEqual(21);
    expect(session.history.length).toBeGreaterThan(15);
  });

  test('fallback cuando Claude no devuelve texto', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { stop_reason: 'end_turn', content: [] }, // sin texto
    });
    const result = await server.processMessage('52222', 'hola');
    expect(result.text).toMatch(/no pude procesar/i);
  });

  test('detectAndRegisterIncident marca la sesión cuando hay queja', async () => {
    // Mock del writeFileSync para evitar tocar disco real
    mockAxiosPost.mockResolvedValueOnce({
      data: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Registrado.' }] },
    });
    // No queremos que writeData toque disco real: stub path join del módulo incidents
    // Como server.js ya lo requirió, lo hacemos vía escritura a tmp; pero basta
    // con verificar que la sesión quedó marcada con hasIncident=true.
    // El side effect de fs.writeFileSync se ignora (puede fallar silenciosamente).
    try {
      await server.processMessage('52333', 'Mi perfume llegó dañado, pedido #1521');
    } catch (_) { /* tolerar si la escritura falla en sandbox */ }
    const session = server.sessions.get('52333');
    expect(session.hasIncident).toBe(true);
    expect(session.followupCancelled).toBe(true);
    expect(session.knownOrder).toBe('1521');
  });

  test('detectRejection cancela follow-ups', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Entiendo 🌿' }] },
    });
    // Primero: mensaje normal (resetea flags)
    await server.processMessage('52444', 'hola');
    let session = server.sessions.get('52444');
    expect(session.followupCancelled).toBe(false);

    // Luego: rechazo explícito
    await server.processMessage('52444', 'ya no gracias');
    session = server.sessions.get('52444');
    expect(session.followupCancelled).toBe(true);
  });
});
