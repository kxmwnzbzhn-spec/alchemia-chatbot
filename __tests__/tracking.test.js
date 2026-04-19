const {
  findTrackingInMeta,
  extractTrackingFromValue,
  isFakeTrackingValue,
} = require('../src/server');

describe('isFakeTrackingValue', () => {
  test.each([
    null,
    undefined,
    '',
    '   ',
    'ENV-123-MEX',
    'env-456-mex',
    'ENV-99999-MEX',
  ])('detecta placeholder: %s', (v) => {
    expect(isFakeTrackingValue(v)).toBe(true);
  });

  test.each([
    'DHL123456789',
    '7705098765',
    'MX123ABC',
    'ENV-123-USA', // no es el placeholder MX
    '999',
  ])('acepta tracking real: %s', (v) => {
    expect(isFakeTrackingValue(v)).toBe(false);
  });
});

describe('extractTrackingFromValue (con validación de shape)', () => {
  test('string plano válido', () => {
    expect(extractTrackingFromValue('DHL123456')).toBe('DHL123456');
    expect(extractTrackingFromValue('  DHL123456  ')).toBe('DHL123456');
  });

  test('rechaza strings que no parecen tracking', () => {
    // URL
    expect(extractTrackingFromValue('https://track.example.com/x')).toBeNull();
    // Demasiado corto
    expect(extractTrackingFromValue('A1')).toBeNull();
    // Demasiado largo (UUID sin guiones, hashes de sesión, etc.)
    expect(extractTrackingFromValue('a'.repeat(50))).toBeNull();
    // Sin dígitos (palabra suelta)
    expect(extractTrackingFromValue('Preparando')).toBeNull();
    // Chars raros (HTML/JSON suelto)
    expect(extractTrackingFromValue('abc<script>')).toBeNull();
  });

  test('string vacío o placeholder devuelve null', () => {
    expect(extractTrackingFromValue('')).toBeNull();
    expect(extractTrackingFromValue('ENV-42-MEX')).toBeNull();
  });

  test('JSON-string que contiene array (WC Shipment Tracking)', () => {
    const serialized = JSON.stringify([
      { tracking_number: 'DHL789012', tracking_provider: 'DHL' },
    ]);
    expect(extractTrackingFromValue(serialized)).toBe('DHL789012');
  });

  test('JSON-string con objeto suelto', () => {
    const serialized = JSON.stringify({ trackingNumber: 'FEDEX007' });
    expect(extractTrackingFromValue(serialized)).toBe('FEDEX007');
  });

  test('array de items (shape del plugin WC Shipment Tracking)', () => {
    const items = [
      { tracking_number: 'DHL123456', tracking_provider: 'dhl' },
      { tracking_number: 'DHL456789' },
    ];
    expect(extractTrackingFromValue(items)).toBe('DHL123456');
  });

  test('array donde el primer item es placeholder, toma el siguiente', () => {
    const items = [
      { tracking_number: 'ENV-1-MEX' },
      { tracking_number: 'REAL-TRACK-789' },
    ];
    expect(extractTrackingFromValue(items)).toBe('REAL-TRACK-789');
  });

  test('objeto suelto con varias propiedades candidatas', () => {
    expect(extractTrackingFromValue({ tracking_number: 'AAA111' })).toBe('AAA111');
    expect(extractTrackingFromValue({ trackingNumber: 'BBB222' })).toBe('BBB222');
    expect(extractTrackingFromValue({ tracking: 'CCC333' })).toBe('CCC333');
    expect(extractTrackingFromValue({ guide_number: 'DDD444' })).toBe('DDD444');
    expect(extractTrackingFromValue({ tracking_code: 'EEE555' })).toBe('EEE555');
  });

  test('null/undefined', () => {
    expect(extractTrackingFromValue(null)).toBeNull();
    expect(extractTrackingFromValue(undefined)).toBeNull();
  });
});

describe('findTrackingInMeta', () => {
  test('encuentra en _envia_tracking_number (canónica, mayor prioridad)', () => {
    const meta = [
      { key: 'otro', value: 'ignorado' },
      { key: '_envia_tracking_number', value: 'DHL999888' },
    ];
    const r = findTrackingInMeta(meta);
    expect(r.value).toBe('DHL999888');
    expect(r.matchedKey).toBe('_envia_tracking_number');
    expect(r.viaFuzzy).toBe(false);
  });

  test('encuentra en _wc_shipment_tracking_items (array JSON serializado)', () => {
    const meta = [
      {
        key: '_wc_shipment_tracking_items',
        value: JSON.stringify([
          { tracking_number: 'SH123456', tracking_provider: 'dhl' },
        ]),
      },
    ];
    const r = findTrackingInMeta(meta);
    expect(r.value).toBe('SH123456');
    expect(r.viaFuzzy).toBe(false);
  });

  test('encuentra en _wc_shipment_tracking_items cuando el valor ya es array', () => {
    const meta = [
      {
        key: '_wc_shipment_tracking_items',
        value: [{ tracking_number: 'SH456789', tracking_provider: 'fedex' }],
      },
    ];
    expect(findTrackingInMeta(meta).value).toBe('SH456789');
  });

  test('encuentra en _aftership_tracking_number', () => {
    const meta = [{ key: '_aftership_tracking_number', value: 'AFTER999111' }];
    expect(findTrackingInMeta(meta).value).toBe('AFTER999111');
  });

  test('fallback fuzzy encuentra keys no canónicas que combinan tracking+number/code/id', () => {
    const meta = [
      { key: '_custom_tracking_code', value: 'CUSTOM-4242' },
    ];
    const r = findTrackingInMeta(meta);
    expect(r.value).toBe('CUSTOM-4242');
    expect(r.viaFuzzy).toBe(true);
    expect(r.matchedKey).toBe('_custom_tracking_code');
  });

  test('respeta prioridad: canónica > fuzzy', () => {
    const meta = [
      { key: '_custom_tracking_code', value: 'CUSTOM-FALL123' },
      { key: '_envia_tracking_number', value: 'REAL-TRACK-999' },
    ];
    const r = findTrackingInMeta(meta);
    expect(r.value).toBe('REAL-TRACK-999');
    expect(r.viaFuzzy).toBe(false);
  });

  test('ignora placeholder ENV-X-MEX y sigue buscando', () => {
    const meta = [
      { key: '_envia_tracking_number', value: 'ENV-555-MEX' },
      { key: '_wc_shipment_tracking_number', value: 'REAL-999123' },
    ];
    expect(findTrackingInMeta(meta).value).toBe('REAL-999123');
  });

  test('devuelve {value:null,...} si no hay meta_data', () => {
    expect(findTrackingInMeta(null).value).toBeNull();
    expect(findTrackingInMeta(undefined).value).toBeNull();
    expect(findTrackingInMeta([]).value).toBeNull();
  });

  test('tolera entradas malformadas sin romperse', () => {
    const meta = [
      null,
      undefined,
      { key: null, value: 'x' },
      { value: 'sin key' },
      { key: '_envia_tracking_number', value: 'DHL-OK-123' },
    ];
    expect(findTrackingInMeta(meta).value).toBe('DHL-OK-123');
  });
});

describe('findTrackingInMeta — regresión de falsos positivos analíticos', () => {
  // Bug reportado: el bot daba SIEMPRE el mismo tracking en todos los pedidos
  // porque el fuzzy fallback encontraba keys de analytics/pixel/conversion
  // cuyos valores son constantes (ID de pixel, cookie de sesión, etc.).

  test('NO matchea key de analytics con "track" en el nombre', () => {
    const meta = [
      { key: '_woocommerce_analytics_tracking_id', value: 'GA-123456-1' },
    ];
    expect(findTrackingInMeta(meta).value).toBeNull();
  });

  test('NO matchea key de Facebook pixel', () => {
    const meta = [
      { key: '_fb_pixel_tracking_id', value: '987654321' },
      { key: '_fbp_tracking_code', value: 'fb.1.123.456' },
    ];
    expect(findTrackingInMeta(meta).value).toBeNull();
  });

  test('NO matchea UTM / GTM / conversion tracking', () => {
    expect(findTrackingInMeta([
      { key: '_utm_tracking_code', value: 'cmp_123' },
    ]).value).toBeNull();
    expect(findTrackingInMeta([
      { key: '_gtm_tracking_id', value: 'GTM-ABC123' },
    ]).value).toBeNull();
    expect(findTrackingInMeta([
      { key: '_conversion_tracking_code', value: 'AW-12345' },
    ]).value).toBeNull();
  });

  test('NO matchea keys de sesión/visitor/cookie', () => {
    expect(findTrackingInMeta([
      { key: '_visitor_tracking_id', value: 'abcdef123' },
    ]).value).toBeNull();
    expect(findTrackingInMeta([
      { key: '_session_tracking_code', value: 'sess_xyz' },
    ]).value).toBeNull();
  });

  test('regresión: key "_track_url" sin number/code/id NO matchea', () => {
    // Antes, el fuzzy /track/i matcheaba cualquier key con "track" — incluyendo
    // strings sueltos. Ahora requiere combinar con number/num/code/id.
    const meta = [
      { key: '_track_url', value: 'https://tracker.example.com/xyz' },
    ];
    expect(findTrackingInMeta(meta).value).toBeNull();
  });

  test('rechaza valores que no parecen tracking (URLs, UUIDs largos, palabras)', () => {
    // Aunque la key tenga shape correcta, el valor debe validar.
    expect(findTrackingInMeta([
      { key: '_shipment_tracking_number', value: 'https://evil.com/x' },
    ]).value).toBeNull();
    expect(findTrackingInMeta([
      { key: '_tracking_code', value: 'PendingShipment' }, // sin dígitos
    ]).value).toBeNull();
    expect(findTrackingInMeta([
      { key: '_tracking_id', value: 'a'.repeat(50) }, // demasiado largo
    ]).value).toBeNull();
  });

  test('después de filtrar basura, sí encuentra el tracking real', () => {
    const meta = [
      { key: '_woocommerce_analytics_tracking_id', value: 'GA-1' },
      { key: '_fb_pixel_tracking_code', value: 'fb.1.123' },
      { key: '_utm_tracking_id', value: 'utm_xyz' },
      { key: '_wc_shipment_tracking_items', value: JSON.stringify([
        { tracking_number: 'REAL-DHL-987' },
      ]) },
    ];
    const r = findTrackingInMeta(meta);
    expect(r.value).toBe('REAL-DHL-987');
    expect(r.viaFuzzy).toBe(false);
  });
});
