// Tests para las funciones que llaman a WooCommerce dentro de server.js.
// Mockeamos axios.create() devolviendo un instance controlable con get/post.

let mockWoo;
let server;

function loadServerWithMockedWoo() {
  mockWoo = {
    get: jest.fn(),
    post: jest.fn(),
  };
  jest.resetModules();
  jest.doMock('axios', () => ({
    create: jest.fn(() => mockWoo),
    get: jest.fn().mockRejectedValue(new Error('no network')),
    post: jest.fn().mockRejectedValue(new Error('no network')),
  }));
  server = require('../src/server');
  return server;
}

beforeEach(() => {
  loadServerWithMockedWoo();
});

afterEach(() => {
  jest.dontMock('axios');
});

describe('searchProducts (WooCommerce)', () => {
  test('camino feliz: la búsqueda devuelve productos mapeados', async () => {
    mockWoo.get.mockResolvedValueOnce({
      data: [
        {
          id: 1, slug: 'cenote-azul', name: 'Cenote Azul',
          price: '499', regular_price: '499', sale_price: '',
          on_sale: false, stock_status: 'instock', stock_quantity: 10,
          short_description: '<p>Acuático</p>', description: 'desc',
          categories: [{ name: 'Mujer' }], tags: [{ name: 'acuático' }],
          images: [{ src: 'https://img/1.jpg' }], permalink: 'https://shop/cenote',
        },
      ],
    });
    const results = await server.searchProducts('cenote');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 1, slug: 'cenote-azul', name: 'Cenote Azul',
      short_description: 'Acuático', permalink: 'https://shop/cenote',
    });
    expect(mockWoo.get).toHaveBeenCalledWith('/products', {
      params: { search: 'cenote', per_page: 5, status: 'publish' },
    });
  });

  test('fallback a tags cuando search devuelve vacío', async () => {
    mockWoo.get
      .mockResolvedValueOnce({ data: [] })                              // /products search vacío
      .mockResolvedValueOnce({ data: [{ id: 10, name: 'amaderado' }] }) // /products/tags
      .mockResolvedValueOnce({                                          // /products por tag
        data: [{
          id: 2, slug: 'oud', name: 'Oud Sagrado',
          price: '599', stock_status: 'instock', categories: [], tags: [],
          images: [], permalink: 'https://shop/oud',
        }],
      });
    const results = await server.searchProducts('amaderado');
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe('oud');
    expect(mockWoo.get).toHaveBeenNthCalledWith(2, '/products/tags', {
      params: { search: 'amaderado', per_page: 5 },
    });
    expect(mockWoo.get).toHaveBeenNthCalledWith(3, '/products', {
      params: { tag: '10', per_page: 5, status: 'publish' },
    });
  });

  test('fallback a categorías cuando search + tags vacíos', async () => {
    mockWoo.get
      .mockResolvedValueOnce({ data: [] })                                // search
      .mockResolvedValueOnce({ data: [] })                                // tags
      .mockResolvedValueOnce({ data: [{ id: 99, name: 'Regalos' }] })     // categories
      .mockResolvedValueOnce({                                            // products by cat
        data: [{
          id: 3, slug: 'regalo-x', name: 'Regalo X',
          price: '199', stock_status: 'instock', categories: [], tags: [],
          images: [], permalink: 'https://shop/regalo',
        }],
      });
    const results = await server.searchProducts('regalo');
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe('regalo-x');
  });

  test('devuelve [] cuando todos los fallbacks fallan', async () => {
    mockWoo.get
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    const results = await server.searchProducts('inexistente');
    expect(results).toEqual([]);
  });

  test('devuelve [] sin romper cuando WooCommerce lanza error', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockWoo.get.mockRejectedValue(new Error('503 Service Unavailable'));
    const results = await server.searchProducts('cualquier');
    expect(results).toEqual([]);
    spy.mockRestore();
  });

  test('usa caché TTL en búsquedas consecutivas con la misma query', async () => {
    mockWoo.get.mockResolvedValueOnce({
      data: [{
        id: 1, slug: 'a', name: 'A',
        price: '1', stock_status: 'instock', categories: [], tags: [],
        images: [], permalink: '#',
      }],
    });
    const r1 = await server.searchProducts('oud');
    const callsAfterFirst = mockWoo.get.mock.calls.length;
    const r2 = await server.searchProducts('oud');
    expect(r1).toEqual(r2);
    // El segundo call NO debe haber disparado nuevas llamadas a Woo
    expect(mockWoo.get.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('findAlternatives', () => {
  test('devuelve [] cuando product es null/undefined', async () => {
    expect(await server.findAlternatives(null)).toEqual([]);
    expect(await server.findAlternatives(undefined)).toEqual([]);
  });

  test('filtra productos que están en stock y excluye el producto original', async () => {
    const original = {
      id: 7, tags: ['floral'], categories: [],
    };
    mockWoo.get
      .mockResolvedValueOnce({ data: [{ id: 42, name: 'floral' }] }) // tags
      .mockResolvedValueOnce({                                       // products by tag
        data: [
          {
            id: 7, slug: 'self', name: 'Self', price: '1',
            stock_status: 'instock', categories: [], tags: [],
            images: [], permalink: '#',
          },
          {
            id: 8, slug: 'alt-1', name: 'Alt 1', price: '2',
            stock_status: 'instock', categories: [], tags: [],
            images: [], permalink: '#',
          },
          {
            id: 9, slug: 'alt-2', name: 'Alt 2', price: '3',
            stock_status: 'outofstock', categories: [], tags: [],
            images: [], permalink: '#',
          },
          {
            id: 10, slug: 'alt-3', name: 'Alt 3', price: '4',
            stock_status: 'instock', categories: [], tags: [],
            images: [], permalink: '#',
          },
        ],
      });
    const alts = await server.findAlternatives(original, 2);
    // Excluye id=7 (self) y id=9 (outofstock), corta a max=2
    expect(alts.map(a => a.id)).toEqual([8, 10]);
  });
});

describe('hasRecentOrder', () => {
  test('true cuando hay un pedido en processing dentro de la ventana', async () => {
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    mockWoo.get.mockResolvedValueOnce({
      data: [{
        id: 1, number: '1', status: 'processing', date_created: recent,
        billing: { first_name: 'A', last_name: 'B', email: 'e', phone: '5215551234567' },
        total: '1', currency: 'MXN',
      }],
    });
    expect(await server.hasRecentOrder('5215551234567', 24)).toBe(true);
  });

  test('false cuando el pedido está fuera de la ventana', async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    mockWoo.get.mockResolvedValueOnce({
      data: [{
        id: 1, number: '1', status: 'completed', date_created: old,
        billing: { first_name: 'A', last_name: 'B', email: 'e', phone: '5215551234567' },
        total: '1', currency: 'MXN',
      }],
    });
    expect(await server.hasRecentOrder('5215551234567', 24)).toBe(false);
  });

  test('false cuando no hay pedidos para ese teléfono', async () => {
    mockWoo.get.mockResolvedValueOnce({ data: [] });
    expect(await server.hasRecentOrder('5215559999999', 24)).toBe(false);
  });

  test('false cuando WooCommerce falla (robustez)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockWoo.get.mockRejectedValue(new Error('boom'));
    expect(await server.hasRecentOrder('52555', 24)).toBe(false);
    spy.mockRestore();
  });
});

describe('createSingleUseCoupon', () => {
  test('POST a /coupons con el shape correcto', async () => {
    mockWoo.post.mockResolvedValueOnce({ data: { code: 'ALMA-4567-ABCDEF' } });
    const result = await server.createSingleUseCoupon('5215551234567', 15, 48);
    expect(result).toEqual({
      code: 'ALMA-4567-ABCDEF',
      expiresAt: expect.any(String),
    });
    const [url, body] = mockWoo.post.mock.calls[0];
    expect(url).toBe('/coupons');
    expect(body).toMatchObject({
      discount_type: 'percent',
      amount: '15',
      individual_use: true,
      usage_limit: 1,
      usage_limit_per_user: 1,
      free_shipping: false,
    });
    expect(body.code).toMatch(/^ALMA-4567-[0-9A-F]{6}$/);
    expect(body.date_expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('devuelve null cuando WooCommerce rechaza el POST', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockWoo.post.mockRejectedValue({ response: { data: { code: 'rest_forbidden' } } });
    const result = await server.createSingleUseCoupon('5215551234567', 10, 24);
    expect(result).toBeNull();
    spy.mockRestore();
  });
});
