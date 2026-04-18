const crypto = require('crypto');

// Cargamos los helpers puros de server.js. Gracias al guard
// `if (require.main === module)` ya no inicia listeners ni intervals.
const {
  detectRejection,
  generateCouponCode,
  verifyMetaSignature,
  mapProduct,
  formatOrder,
  buildFollowupMessage1,
  buildFollowupMessage2,
  normalizePhoneLast10,
} = require('../src/server');

describe('detectRejection', () => {
  test.each([
    'no',
    'No',
    'NO',
    'nop',
    'nope',
    'nel',
    'na',
    'nah',
    'no.',
  ])('acepta negación corta: "%s"', (m) => {
    expect(detectRejection(m)).toBe(true);
  });

  test.each([
    'no me interesa',
    'no gracias',
    'ya no',
    'ahorita no',
    'después',
    'despues',
    'otro día',
    'otro dia',
    'más tarde',
    'mas tarde',
    'gracias pero no',
    'paso',
    'paso por ahora',
    'ya compré',
    'ya compre',
  ])('detecta frase de rechazo: "%s"', (m) => {
    expect(detectRejection(m)).toBe(true);
  });

  test.each([
    'sí',
    'me interesa mucho',
    'claro que sí',
    'cuéntame más',
    'quiero comprar',
    'hola',
    '',
  ])('NO marca como rechazo mensajes positivos/neutros: "%s"', (m) => {
    expect(detectRejection(m)).toBe(false);
  });

  test('trimea y normaliza mayúsculas', () => {
    expect(detectRejection('   NO   ')).toBe(true);
    expect(detectRejection('  Ya Compré  ')).toBe(true);
  });
});

describe('generateCouponCode', () => {
  test('formato ALMA-XXXX-YYYYYY', () => {
    const code = generateCouponCode('5215551234567');
    expect(code).toMatch(/^ALMA-\d{4}-[0-9A-F]{6}$/);
  });

  test('usa últimos 4 dígitos del teléfono', () => {
    expect(generateCouponCode('5215551234567')).toMatch(/^ALMA-4567-/);
    expect(generateCouponCode('+52 (555) 123-4567')).toMatch(/^ALMA-4567-/);
    expect(generateCouponCode('  5555000011119999  ')).toMatch(/^ALMA-9999-/);
  });

  test('usa 0000 si no hay dígitos suficientes', () => {
    expect(generateCouponCode('')).toMatch(/^ALMA-0000-/);
    expect(generateCouponCode('abc')).toMatch(/^ALMA-0000-/);
  });

  test('genera valores distintos (aleatoriedad)', () => {
    const a = generateCouponCode('5551234567');
    const b = generateCouponCode('5551234567');
    // prefijo idéntico, sufijo aleatorio distinto (colisión es de 1 en 16^6)
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    expect(a).not.toBe(b);
  });
});

describe('verifyMetaSignature', () => {
  const ORIGINAL = process.env.WHATSAPP_APP_SECRET;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.WHATSAPP_APP_SECRET;
    else process.env.WHATSAPP_APP_SECRET = ORIGINAL;
  });

  test('devuelve true cuando no hay secret configurado (HMAC opcional)', () => {
    delete process.env.WHATSAPP_APP_SECRET;
    expect(verifyMetaSignature({ headers: {}, rawBody: Buffer.from('{}') })).toBe(true);
  });

  test('acepta firma válida', () => {
    process.env.WHATSAPP_APP_SECRET = 'super-secret';
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const sig = 'sha256=' + crypto.createHmac('sha256', 'super-secret').update(body).digest('hex');
    expect(verifyMetaSignature({
      headers: { 'x-hub-signature-256': sig },
      rawBody: body,
    })).toBe(true);
  });

  test('rechaza firma con secret incorrecto', () => {
    process.env.WHATSAPP_APP_SECRET = 'super-secret';
    const body = Buffer.from('{}');
    const badSig = 'sha256=' + crypto.createHmac('sha256', 'otro-secret').update(body).digest('hex');
    expect(verifyMetaSignature({
      headers: { 'x-hub-signature-256': badSig },
      rawBody: body,
    })).toBe(false);
  });

  test('rechaza cuando falta header', () => {
    process.env.WHATSAPP_APP_SECRET = 'super-secret';
    expect(verifyMetaSignature({
      headers: {},
      rawBody: Buffer.from('{}'),
    })).toBe(false);
  });

  test('rechaza cuando falta rawBody', () => {
    process.env.WHATSAPP_APP_SECRET = 'super-secret';
    expect(verifyMetaSignature({
      headers: { 'x-hub-signature-256': 'sha256=abc' },
    })).toBe(false);
  });

  test('rechaza sin romper cuando longitudes no coinciden (timingSafeEqual)', () => {
    process.env.WHATSAPP_APP_SECRET = 'super-secret';
    expect(verifyMetaSignature({
      headers: { 'x-hub-signature-256': 'sha256=short' },
      rawBody: Buffer.from('{}'),
    })).toBe(false);
  });
});

describe('mapProduct', () => {
  test('normaliza todos los campos esperados', () => {
    const raw = {
      id: 42,
      slug: 'cenote-azul',
      name: 'Cenote Azul',
      price: '499',
      regular_price: '599',
      sale_price: '499',
      on_sale: 1,
      stock_status: 'instock',
      stock_quantity: 10,
      short_description: '<p>Perfume inspirado en <b>cenotes</b>.</p>',
      description: '<p>Descripción larga con <em>html</em>.</p>' + 'X'.repeat(700),
      categories: [{ name: 'Mujer' }, { name: 'Unisex' }],
      tags: [{ name: 'bergamota' }, { name: 'jazmín' }],
      images: [{ src: 'https://img/1.jpg' }, { src: 'https://img/2.jpg' }],
      permalink: 'https://shop/product/cenote-azul',
    };
    const mapped = mapProduct(raw);
    expect(mapped).toEqual({
      id: 42,
      slug: 'cenote-azul',
      name: 'Cenote Azul',
      price: '499',
      regular_price: '599',
      sale_price: '499',
      on_sale: true, // coerce a boolean
      stock_status: 'instock',
      stock_quantity: 10,
      short_description: 'Perfume inspirado en cenotes.',
      description: expect.any(String),
      categories: ['Mujer', 'Unisex'],
      tags: ['bergamota', 'jazmín'],
      image_url: 'https://img/1.jpg',
      permalink: 'https://shop/product/cenote-azul',
    });
    // Strip HTML y trunca a 600 chars
    expect(mapped.description).not.toMatch(/<[^>]+>/);
    expect(mapped.description.length).toBeLessThanOrEqual(600);
  });

  test('maneja campos ausentes sin romper', () => {
    const mapped = mapProduct({ id: 1, slug: 's', name: 'n', stock_status: 'outofstock' });
    expect(mapped.categories).toEqual([]);
    expect(mapped.tags).toEqual([]);
    expect(mapped.image_url).toBeNull();
    expect(mapped.short_description).toBe('');
    expect(mapped.description).toBe('');
    expect(mapped.on_sale).toBe(false);
  });
});

describe('formatOrder', () => {
  test('extrae campos desde el shape de WooCommerce', () => {
    const order = {
      id: 1521,
      number: '1521',
      status: 'processing',
      date_created: '2025-01-15T10:00:00',
      billing: {
        first_name: 'Juan',
        last_name: 'Pérez',
        email: 'j@e.com',
        phone: '5215551234567',
      },
      total: '499.00',
      currency: 'MXN',
      line_items: [
        { name: 'Cenote Azul', quantity: 1 },
        { name: 'Oud Sagrado', quantity: 2 },
      ],
      shipping_lines: [{ method_title: 'DHL Express' }],
      meta_data: [{ key: '_envia_tracking_number', value: 'ABC123' }],
    };
    expect(formatOrder(order)).toEqual({
      id: 1521,
      number: '1521',
      status: 'processing',
      date_created: '2025-01-15T10:00:00',
      customer_name: 'Juan Pérez',
      customer_email: 'j@e.com',
      customer_phone: '5215551234567',
      total: '499.00',
      currency: 'MXN',
      items: 'Cenote Azul x1, Oud Sagrado x2',
      shipping_method: 'DHL Express',
      meta_data: [{ key: '_envia_tracking_number', value: 'ABC123' }],
    });
  });

  test('tolera ausencia de line_items y shipping_lines', () => {
    const order = {
      id: 1, number: '1', status: 'completed', date_created: 'd',
      billing: { first_name: 'A', last_name: 'B', email: 'e', phone: 'p' },
      total: '0', currency: 'MXN',
    };
    const f = formatOrder(order);
    expect(f.items).toBeUndefined();
    expect(f.shipping_method).toBeUndefined();
  });
});

describe('normalizePhoneLast10 (fix de matching de pedidos por teléfono)', () => {
  test('toma los últimos 10 dígitos de un número MX con prefijo 521', () => {
    expect(normalizePhoneLast10('5215551234567')).toBe('5551234567');
  });

  test('toma los últimos 10 dígitos de un número MX con prefijo 52', () => {
    expect(normalizePhoneLast10('525551234567')).toBe('5551234567');
  });

  test('regresión: tolera espacios, paréntesis y guiones', () => {
    expect(normalizePhoneLast10('+52 (555) 123-4567')).toBe('5551234567');
    expect(normalizePhoneLast10('+52 1 555 123 4567')).toBe('5551234567');
  });

  test('regresión: funciona con números no-MX (US)', () => {
    // Previo: el strip de ^\+?52 no aplicaba y luego slice(-10) sobre string
    // con espacios/guiones producía mezclas de chars. Ahora solo dígitos.
    expect(normalizePhoneLast10('+1 (415) 555-1234')).toBe('4155551234');
    expect(normalizePhoneLast10('14155551234')).toBe('4155551234');
  });

  test('devuelve string vacío para entrada vacía / nullish', () => {
    expect(normalizePhoneLast10('')).toBe('');
    expect(normalizePhoneLast10(null)).toBe('');
    expect(normalizePhoneLast10(undefined)).toBe('');
  });

  test('coerce a string', () => {
    expect(normalizePhoneLast10(5551234567)).toBe('5551234567');
  });
});

describe('buildFollowupMessage1 / buildFollowupMessage2', () => {
  const coupon = { code: 'ALMA-4567-ABCDEF', expiresAt: '2025-01-20T00:00:00Z' };

  test('msg1 incluye código de cupón y saludo', () => {
    const text = buildFollowupMessage1({
      session: { lastShownProducts: [{ name: 'Cenote Azul', link: 'https://shop/x' }] },
      coupon,
    });
    expect(text).toContain('ALMA-4567-ABCDEF');
    expect(text).toContain('Cenote Azul');
    expect(text).toContain('https://shop/x');
    expect(text).toMatch(/hola/i);
  });

  test('msg1 usa fallback cuando no hay productos mostrados', () => {
    const text = buildFollowupMessage1({
      session: { lastShownProducts: [] },
      coupon,
    });
    expect(text).toContain('ALMA-4567-ABCDEF');
    expect(text).toContain('saludarte');
  });

  test('msg2 marca última llamada e incluye cupón', () => {
    const text = buildFollowupMessage2({
      session: { lastShownProducts: [{ name: 'Xibalba', link: 'https://shop/x' }] },
      coupon,
    });
    expect(text).toContain('Última llamada');
    expect(text).toContain('ALMA-4567-ABCDEF');
    expect(text).toContain('Xibalba');
  });

  test('msg2 sin productos omite bloque de producto pero conserva cupón', () => {
    const text = buildFollowupMessage2({
      session: { lastShownProducts: [] },
      coupon,
    });
    expect(text).toContain('Última llamada');
    expect(text).toContain('ALMA-4567-ABCDEF');
  });
});
