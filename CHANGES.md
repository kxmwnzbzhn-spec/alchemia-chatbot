# CHANGES v2.1 — Productos con link directo + alternativas si agotado

## Resumen

El problema raíz: cuando un cliente preguntaba por un perfume, Alma (bot) podía responder sin incluir el **link exacto de compra** del producto en WooCommerce. La tool `buscar_productos` ya devolvía `permalink`, pero el SYSTEM_PROMPT no exigía usarlo, así que el modelo a veces lo omitía o inventaba URLs.

Esta versión:

1. **Refuerza el prompt** con una regla crítica que obliga a incluir `link_compra` tal cual viene del Woo.
2. **Amplía la respuesta** con imagen, precio, oferta, notas y disponibilidad clara.
3. **Si está agotado, sugiere alternativas** en stock (por tags/categorías similares).
4. Arregla bugs colaterales que afectaban email diario y detección de pedidos.

---

## Archivos modificados

### `src/server.js` — reescrito (Fase A + Fase B)

**Nuevas funciones:**
- `mapProduct(p)` — normaliza un producto Woo (incluye `image_url`, `slug`, `on_sale`, tags, categorías).
- `getProductByIdOrSlug(idOrSlug)` — lookup puntual con cache.
- `findAlternatives(product, max)` — 2 candidatos en stock con overlap de tag/categoría.
- `sendWhatsAppImage(to, imageUrl, caption)` — mensaje tipo `image` de WA Graph.
- `verifyMetaSignature(req)` — HMAC `X-Hub-Signature-256` si `WHATSAPP_APP_SECRET` está definido.

**`searchProducts` ahora:**
- Devuelve `image_url`, `permalink`, `stock_status`, tags, categorías.
- Hace 3 niveles de fallback: por `search`, por `tag`, por `category`.
- Cachea por 10 min para reducir round-trips al Woo.

**Tools expuestas a Claude:**
- `buscar_productos` → devuelve objetos con `link_compra`, `disponibilidad` ("EN STOCK" / "POR PEDIDO" / "AGOTADO"), y, cuando aplica, `alternativas_en_stock`.
- **NUEVA** `obtener_detalle_producto(id_o_slug)` — ficha completa (descripción larga, notas, imagen, link).
- `consultar_pedido` — sin cambios funcionales.

**`SYSTEM_PROMPT`:**
Bloque nuevo "REGLA CRÍTICA — INFORMACIÓN DE PRODUCTO" que exige:
1. Nombre en *negritas*
2. Precio MXN (marcar si hay oferta)
3. Disponibilidad solo si NO está en stock
4. 1-2 líneas de notas/inspiración
5. **Link de compra usando exactamente `link_compra` del JSON — prohibido inventar URLs**

Añade plantilla Markdown específica para WhatsApp (1 producto, varios, agotado con alternativas).

**Flujo de respuesta:**
- Si la tool devuelve 1 solo producto con imagen, el bot manda 2 mensajes: (1) texto con detalle+link, (2) imagen con caption corto. Si son varios, solo texto.
- Para eso `processMessage` ahora retorna `{ text, productImage }` en lugar de string.

**Otros fixes:**
- `/api/diagnostics` reporta `model: "claude-haiku-4-5"` (antes mentía "sonnet-4-5").
- `/api/health` expone flag `hmac` para saber si la verificación de firma está activa.
- Body parser conserva `rawBody` para HMAC.

### `src/scheduler.js`

**Bug crítico:** `nodemailer.createTransporter(…)` → `createTransport(…)` (el método correcto). El envío por email del reporte diario **estaba roto silenciosamente**.

También:
- Soporte para `SMTP_SECURE` (port 465 con TLS).
- Try/catch en la escritura del `lastReport` para no tirar el cron si el filesystem es de solo lectura.

### `src/incidents.js`

Fix de `extractOrderNumber`: antes capturaba cualquier número de 3-6 dígitos (incluía "$499", "100ml", años). Ahora exige contexto explícito:

```
/(?:#|pedido|orden|orden\s*n[uú]mero)\s*#?\s*(\d{3,6})/i
```

### `.env.example` — NUEVO

Documenta todas las vars, incluida la nueva opcional `WHATSAPP_APP_SECRET`.

### `README.md` — NUEVO

Stack, endpoints, tools, deploy Railway, advertencia sobre filesystem efímero.

---

## Cómo aplicar los cambios al repo

### Opción A — editar vía GitHub web (rápido, sin clonar)

1. Abre el repo: https://github.com/kxmwnzbzhn-spec/alchemia-chatbot
2. Para cada archivo, abre el archivo en GitHub → botón lápiz (Edit) → pega el contenido nuevo → Commit:
   - `src/server.js`
   - `src/scheduler.js`
   - `src/incidents.js`
3. Crea archivos nuevos (botón Add file → Create new file):
   - `.env.example`
   - `README.md`
   - `CHANGES.md`
4. Railway detecta el push y redeploya solo.

### Opción B — clonar y pushear

```bash
git clone https://github.com/kxmwnzbzhn-spec/alchemia-chatbot.git
cd alchemia-chatbot

# Copiar los archivos nuevos desde la carpeta:
# /Users/luisvargas/Documents/Claude/Projects/Pagina Alchemia/alchemia-chatbot-updated/
cp ~/Documents/Claude/Projects/Pagina\ Alchemia/alchemia-chatbot-updated/src/server.js    src/server.js
cp ~/Documents/Claude/Projects/Pagina\ Alchemia/alchemia-chatbot-updated/src/scheduler.js src/scheduler.js
cp ~/Documents/Claude/Projects/Pagina\ Alchemia/alchemia-chatbot-updated/src/incidents.js src/incidents.js
cp ~/Documents/Claude/Projects/Pagina\ Alchemia/alchemia-chatbot-updated/.env.example     .env.example
cp ~/Documents/Claude/Projects/Pagina\ Alchemia/alchemia-chatbot-updated/README.md        README.md
cp ~/Documents/Claude/Projects/Pagina\ Alchemia/alchemia-chatbot-updated/CHANGES.md       CHANGES.md

git checkout -b feat/producto-link-directo
git add -A
git commit -m "feat(bot): productos con link directo de compra + alternativas si agotado

- SYSTEM_PROMPT: regla crítica que obliga a incluir permalink Woo
- searchProducts: image, stock, fallback por tag/categoría, cache
- NUEVA tool obtener_detalle_producto (ficha completa)
- findAlternatives: sugiere perfumes en stock si hay agotados
- sendWhatsAppImage: mensaje tipo image con caption
- Fix scheduler.js: createTransporter -> createTransport (email roto)
- Fix incidents.js: extractOrderNumber requiere contexto (# o 'pedido')
- Fix /api/diagnostics: reporta modelo real
- HMAC opcional del webhook (X-Hub-Signature-256)
- .env.example + README.md"
git push origin feat/producto-link-directo
# Abrir PR en GitHub y mergear
```

---

## Checklist antes de mergear a main

- [ ] Probar en `/api/demo/chat` con mensajes:
  - `{ "message": "¿Tienes Cenote Azul?" }` → respuesta debe contener `https://thealchemialab.com/product/cenote-azul-eau-de-parfum/`
  - `{ "message": "Quiero un perfume amaderado" }` → lista con 2-3 productos, cada uno con su link
  - `{ "message": "Precio del Xibalba" }` → si está agotado, debe decir "Agotado" + sugerir alternativas
  - `{ "message": "Mándame el link para comprar Tláloc" }` → URL exacta del slug
  - `{ "message": "Más info del primero" }` → debería disparar `obtener_detalle_producto`
- [ ] Confirmar que `WOO_URL`, `WOO_KEY`, `WOO_SECRET` están en Railway.
- [ ] (Opcional) Agregar `WHATSAPP_APP_SECRET` en Railway para que el webhook valide firma.
- [ ] Monitorear primeros logs en Railway tras el deploy.

---

## Fase C — mejoras futuras (no en este PR)

- Persistencia de `incidents.json` en Postgres de Railway (hoy se pierde en cada redeploy).
- Intent router mínimo (saludo, horario, ubicación) para bajar tokens antes de llamar a Claude.
- Endpoint `/api/catalog/refresh` para invalidar cache a mano.
- Logs estructurados (pino) con trace-id por conversación.
