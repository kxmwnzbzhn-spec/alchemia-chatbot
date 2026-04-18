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

describe('extractTrackingFromValue', () => {
  test('string plano', () => {
    expect(extractTrackingFromValue('DHL123')).toBe('DHL123');
    expect(extractTrackingFromValue('  DHL123  ')).toBe('DHL123');
  });

  test('string vacío o placeholder devuelve null', () => {
    expect(extractTrackingFromValue('')).toBeNull();
    expect(extractTrackingFromValue('ENV-42-MEX')).toBeNull();
  });

  test('JSON-string que contiene array (WC Shipment Tracking)', () => {
    const serialized = JSON.stringify([
      { tracking_number: 'DHL789', tracking_provider: 'DHL' },
    ]);
    expect(extractTrackingFromValue(serialized)).toBe('DHL789');
  });

  test('JSON-string con objeto suelto', () => {
    const serialized = JSON.stringify({ trackingNumber: 'FEDEX007' });
    expect(extractTrackingFromValue(serialized)).toBe('FEDEX007');
  });

  test('array de items (shape del plugin WC Shipment Tracking)', () => {
    const items = [
      { tracking_number: 'DHL123', tracking_provider: 'dhl' },
      { tracking_number: 'DHL456' },
    ];
    expect(extractTrackingFromValue(items)).toBe('DHL123');
  });

  test('array donde el primer item es placeholder, toma el siguiente', () => {
    const items = [
      { tracking_number: 'ENV-1-MEX' },
      { tracking_number: 'REAL-TRACK-789' },
    ];
    expect(extractTrackingFromValue(items)).toBe('REAL-TRACK-789');
  });

  test('objeto suelto con varias propiedades candidatas', () => {
    expect(extractTrackingFromValue({ tracking_number: 'A1' })).toBe('A1');
    expect(extractTrackingFromValue({ trackingNumber: 'A2' })).toBe('A2');
    expect(extractTrackingFromValue({ tracking: 'A3' })).toBe('A3');
    expect(extractTrackingFromValue({ guide_number: 'A4' })).toBe('A4');
    expect(extractTrackingFromValue({ tracking_code: 'A5' })).toBe('A5');
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
      { key: '_envia_tracking_number', value: 'DHL999' },
    ];
    expect(findTrackingInMeta(meta)).toBe('DHL999');
  });

  test('regresión: encuentra en _wc_shipment_tracking_items (array serializado)', () => {
    // Este es el shape del plugin más popular de WooCommerce — antes NO se leía.
    const meta = [
      {
        key: '_wc_shipment_tracking_items',
        value: JSON.stringify([
          { tracking_number: 'SH123', tracking_provider: 'dhl' },
        ]),
      },
    ];
    expect(findTrackingInMeta(meta)).toBe('SH123');
  });

  test('regresión: encuentra en _wc_shipment_tracking_items cuando el valor ya es array', () => {
    const meta = [
      {
        key: '_wc_shipment_tracking_items',
        value: [{ tracking_number: 'SH456', tracking_provider: 'fedex' }],
      },
    ];
    expect(findTrackingInMeta(meta)).toBe('SH456');
  });

  test('regresión: encuentra en _aftership_tracking_number', () => {
    const meta = [{ key: '_aftership_tracking_number', value: 'AFTER999' }];
    expect(findTrackingInMeta(meta)).toBe('AFTER999');
  });

  test('regresión: fallback fuzzy encuentra keys no canónicas con "track" en el nombre', () => {
    const meta = [
      { key: '_custom_tracking_code', value: 'CUSTOM-42' },
    ];
    expect(findTrackingInMeta(meta)).toBe('CUSTOM-42');
  });

  test('respeta prioridad: canónica > fuzzy', () => {
    const meta = [
      { key: '_custom_tracking_code', value: 'CUSTOM-FALLBACK' },
      { key: '_envia_tracking_number', value: 'REAL-TRACK' },
    ];
    expect(findTrackingInMeta(meta)).toBe('REAL-TRACK');
  });

  test('ignora placeholder ENV-X-MEX y sigue buscando', () => {
    const meta = [
      { key: '_envia_tracking_number', value: 'ENV-555-MEX' },
      { key: '_wc_shipment_tracking_number', value: 'REAL-999' },
    ];
    expect(findTrackingInMeta(meta)).toBe('REAL-999');
  });

  test('devuelve null si no hay meta_data', () => {
    expect(findTrackingInMeta(null)).toBeNull();
    expect(findTrackingInMeta(undefined)).toBeNull();
    expect(findTrackingInMeta([])).toBeNull();
  });

  test('devuelve null si ninguna key tiene tracking válido', () => {
    const meta = [
      { key: '_envia_tracking_number', value: '' },
      { key: '_billing_first_name', value: 'Juan' },
    ];
    expect(findTrackingInMeta(meta)).toBeNull();
  });

  test('tolera entradas malformadas sin romperse', () => {
    const meta = [
      null,
      undefined,
      { key: null, value: 'x' },
      { value: 'sin key' },
      { key: '_envia_tracking_number', value: 'DHL-OK' },
    ];
    expect(findTrackingInMeta(meta)).toBe('DHL-OK');
  });
});
