# nyburger-caja

Pantalla de caja (cashier screen) de New York Burger: lista de pedidos `Completado` pendientes de pago, acción "Pagada" y cierre de día ("cierre de día"), desde una tablet, mediante sondeo (polling) al mismo backend que usan el comensal y la cocina. Sitio estático puro (sin framework, sin bundler), publicado por GitHub Pages.

El backend (Google Apps Script) vive en el repositorio privado de New York Burger (la [NYBurger backend repository](https://github.com/MelvinRamirez/NYBurger)). Este repositorio no duplica ningún archivo de ese backend; solo consume sus endpoints HTTP documentados en sus specs (`caja-pin-api`, `order-payment-status`, `day-close-archival`, `api-transport`).

## Desarrollo local

Requiere Node.js >= 22.

```bash
npm test
```

## Tailwind CSS

El CSS se genera una vez con el CLI standalone de Tailwind v4 y se commitea (no hay build en el deploy). Binario fijado para este proyecto:

- Versión: **v4.3.3**
- Binario: `tailwindcss-macos-x64` (ajustar a la arquitectura de quien regenere el CSS)
- Descarga:

```bash
mkdir -p bin
curl -sSLo bin/tailwindcss https://github.com/tailwindlabs/tailwindcss/releases/download/v4.3.3/tailwindcss-macos-x64
chmod +x bin/tailwindcss
```

Regenerar el CSS tras cambiar clases en `index.html` o `js/`:

```bash
npm run build:css
```

## Estado actual

Este repositorio está en construcción, en orden (mismo patrón que `nyburger-kds`):

- **K1 (completo)**: scaffold y módulos puros de dominio (`store`, `api`, `pin`, `time`, `config`, `messages`, `queue`, `payment`, `close`, `actions`, `persistence`), sin DOM, sin service worker, sin nada desplegado.
- **K2 (completo)**: `js/effects.js` — polling, runner de marcado Pagada, orquestación del cierre de día.
- **K3, parte A (completo)**: vistas (`js/views/*`), `js/main.js` (raíz de composición), `index.html`, CSS de Tailwind, íconos, `manifest.webmanifest` y `sw.js` instalables. Todo probado localmente (`npm test`, smoke de servidor estático) y **desplegado** en GitHub Pages.
- **K3, parte B (completo)**: repositorio público remoto creado, GitHub Pages habilitado, verificación manual hecha en la tablet real.

El backend necesario (`verifyCajaPin`, `getCajaOrders`, `markOrderPaid`, `closeDay`) está implementado, probado y **desplegado a producción** en `NYBurger` (trabajo B1-B3 de `openspec/changes/archive/foodc-caja`). El `API_URL` en `js/config.js` apunta al `/exec` real de producción.

## Deploy

**En línea:** `https://melvinramirez.github.io/nyburger-caja/`.

### Procedimiento de bump de `CACHE_VERSION`

`sw.js` precachea el app shell completo (HTML, CSS, JS, manifest, íconos) bajo `CACHE_VERSION`. Cada vez que cambie cualquier archivo del shell, `CACHE_VERSION` debe incrementarse **en el mismo commit** (p. ej. `foodc-caja-shell-v1` → `foodc-caja-shell-v2`). El flujo, idéntico a `nyburger-kds`:

1. `install` precachea la lista con `{cache: 'reload'}` (bypassea la caché HTTP) y llama `self.skipWaiting()`.
2. `activate` borra toda caché cuyo nombre empiece con `CACHE_PREFIX` (`foodc-caja-shell-`) y no sea la versión actual, luego llama `self.clients.claim()`.
3. Como la caja corre horas en una sola pestaña de la tablet, el shell nuevo recién se aplica en la próxima navegación — no hay recarga automática. El checklist de deploy (Phase 16) incluye recargar manualmente la tablet una vez después de cada deploy que toque archivos del shell.
