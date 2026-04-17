# Alchemia Chatbot WhatsApp — v2.1

Chatbot de **WhatsApp Cloud API** para *The Alchemia Lab* (perfumería de autor mexicana).
"Alma" responde a clientes en español: muestra productos con **link directo de compra al WooCommerce**, sugiere alternativas si un perfume está agotado, y consulta estado y rastreo de pedidos en Envía.com.

## Stack

- Node.js 18+ / Express
- Anthropic Claude (Haiku 4.5) vía API directa
- WooCommerce REST v3
- Envia.com tracking API
- WhatsApp Cloud API (Meta Graph v22)
- Despliegue: Railway (Nixpacks, healthcheck en `/api/health`)

## Variables de entorno

Ver [`.env.example`](.env.example). Mínimas para arrancar:
`ANTHROPIC_API_KEY`, `WOO_URL`, `WOO_KEY`, `WOO_SECRET`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_VERIFY_TOKEN`.

## Cómo corre

```bash
npm install
cp .env.example .env   # rellenar valores
npm start              # producción
npm run dev            # con nodemon
```

## Endpoints

- `GET  /webhook` — verificación de Meta
- `POST /webhook` — entrada de mensajes WhatsApp (con HMAC opcional)
- `POST /api/demo/chat` — chat de prueba sin WhatsApp `{ phone, message }`
- `GET  /api/health` — healthcheck (Railway)
- `GET  /api/diagnostics` — estado de la API key, modelo, etc.
- `GET  /api/incidents` — incidencias del día
- `GET  /api/incidents/all` — todas con filtros `?date=YYYY-MM-DD&status=open`
- `PATCH /api/incidents/:id/resolve`
- `POST /api/report/send` — disparar reporte manual

## Tools que tiene el bot

| Tool | Para qué |
|------|----------|
| `buscar_productos(query)` | Búsqueda por nombre, notas o familia. Devuelve **link de compra** y, si está agotado, **alternativas en stock**. |
| `obtener_detalle_producto(id_o_slug)` | Ficha completa de un perfume puntual ("dame más info del Xibalba"). |
| `consultar_pedido(numero_pedido | telefono_cliente)` | Estado y tracking. Si el cliente no da nada, usa el teléfono del remitente automáticamente. |

## Despliegue Railway

Push a `main` → Railway redeploya automáticamente.

> ⚠️ El filesystem de Railway es efímero: `data/incidents.json` se pierde en cada redeploy.
> Para producción seria, mover incidencias a Postgres (servicio Railway de DB) o a notas de pedido en Woo.

## Cambios v2.1

Ver [`CHANGES.md`](CHANGES.md).
