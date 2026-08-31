# Cocos — Backend Challenge

API de trading sobre la base de datos del challenge: el **portfolio** de un usuario, la
**búsqueda** de instrumentos y el **envío de órdenes** (MARKET o LIMIT, BUY o SELL) con su
cancelación.

Node 22 · NestJS 11 · TypeScript strict · Prisma 6.19.1 · PostgreSQL 16 · Jest, supertest
y testcontainers.

## Cómo correrlo

```bash
npm install                 # el postinstall corre `prisma generate`
cp .env.example .env        # DATABASE_URL apunta a la base de compose
docker compose up -d --wait # Postgres 16 en :5433, sembrada desde db/init.sql
npm run start:dev           # http://localhost:3000
```

Compose siembra la base: no hay migración que correr ni datos que importar a mano, y
`docker compose down -v` los borra para que el siguiente `up` vuelva a sembrar. Para
correr contra la base hosteada del challenge, apuntá `DATABASE_URL` ahí (la línea está
comentada en `.env.example`) y aplicale antes las migraciones de
[Base de datos](#base-de-datos).

- Documentación interactiva en <http://localhost:3000/docs> (OpenAPI JSON en
  `/docs-json`).
- Colección de requests: [`requests.http`](requests.http) — 40 casos, cada endpoint con su
  camino feliz y sus errores, para la extensión REST Client de VS Code.
- Los mismos 40 casos como colección de Bruno en [`bruno/`](bruno): abrila con la app o
  corrélos enteros con `cd bruno && npx @usebruno/cli run --env local`.
- `npm run start:prod` sirve el build compilado; `PORT` cambia el puerto.

### Tests

```bash
npm test         # 38 unit + 49 e2e
npm run test:unit
npm run test:e2e # necesita el daemon de Docker corriendo
```

Los unit tests cubren las conversiones de dinero, las reglas puras de la orden y el
`Idempotency-Key`. Los e2e corren contra un Postgres 16 descartable que
`@testcontainers/postgresql` levanta y siembra desde `db/init.sql`: ningún test toca una
base compartida. Seis fijan la concurrencia: compras y ventas simultáneas, dos
cancelaciones de la misma orden, una orden esperando el lock, un cancel al lado de una
orden y un reintento al lado del original.

`npm run lint` corre Prettier y después ESLint. El CI
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) corre `npm ci`, lint, build y la
suite completa en cada push y pull request.

## Herramientas

[`tools/`](tools) trae el simulador con el que probé la API: carga, caos, reconciliación
contra la base y un panel web para mirarlo. No es parte del enunciado y queda afuera del
lint, del build y de los tests de la API; cómo correrlo y cómo leerlo está en
[`tools/README.md`](tools/README.md).

## Endpoints

| Método  | Ruta                   | Qué hace                                    | Códigos                 |
| ------- | ---------------------- | ------------------------------------------- | ----------------------- |
| `GET`   | `/health`              | Chequeo de vida                             | 200                     |
| `GET`   | `/instruments?q=`      | Busca por ticker o nombre, hasta 20 filas   | 200, 400                |
| `GET`   | `/users/:id/portfolio` | Valor total, pesos disponibles y posiciones | 200, 400, 404           |
| `POST`  | `/orders`              | Envía una orden BUY/SELL, MARKET/LIMIT      | 201, 200, 400, 404, 503 |
| `PATCH` | `/orders/:id/cancel`   | Cancela una orden que todavía está en `NEW` | 200, 400, 404, 409      |

**400** entrada mal formada o imposible de cumplir, **404** usuario, instrumento u orden
que no existe, **409** una orden cuyo estado no admite la transición, **503** una orden
que no llegó a ejecutarse por saturación (reintentable). Los errores usan el formato por
defecto de Nest (`{ statusCode, error, message }`) y el dinero sale siempre como string de
dos decimales.

**`GET /users/1/portfolio`**

```json
{
  "totalValue": "889756.00",
  "availableCash": "753000.00",
  "positions": [
    { "instrumentId": 31, "ticker": "BMA", "name": "Banco Macro S.A.", "quantity": -10, "marketValue": "-15028.00", "avgCost": "1540.00", "totalReturnPct": null },
    { "instrumentId": 54, "ticker": "METR", "name": "MetroGAS S.A.", "quantity": 500, "marketValue": "114750.00", "avgCost": "250.00", "totalReturnPct": "-8.20" },
    { "instrumentId": 47, "ticker": "PAMP", "name": "Pampa Holding S.A.", "quantity": 40, "marketValue": "37034.00", "avgCost": "930.00", "totalReturnPct": "-0.45" }
  ]
}
```

`totalValue` es el efectivo más cada posición a su último close: 753000 + 37034 + 114750 −
15028 = 889756.

**`POST /orders`** lleva `size` **o** `amount` (en pesos), nunca los dos, y el header
`Idempotency-Key`. La respuesta es la fila de `orders` que quedó guardada.

```json
{ "userId": 1, "instrumentId": 47, "side": "BUY", "type": "MARKET", "size": 10 }
```

## Decisiones

**Los saldos salen solo de las órdenes `FILLED`**, como pide el challenge: `availableCash`
es `CASH_IN + ventas − CASH_OUT − compras` y cada posición es `BUY − SELL`. Una orden
`NEW` no reserva nada, así que con 100.000 pesos se pueden dejar dos compras límite
abiertas de 100.000. Reservar exigiría un saldo propio de la API en vez de uno derivado
del log de órdenes.

**El rendimiento se mide contra el costo de la posición**:
`(close − avgCost) / avgCost × 100`, con `avgCost` el promedio ponderado de las compras
`FILLED`. Es `null` donde no significaría nada: posición negativa, sin compras, o sin
precio. El par `close`/`previousClose` del enunciado es el rendimiento diario, otra cifra.

**MARKET ejecuta al último close** (vista `latest_closes`) y **LIMIT queda como `NEW`** en
su precio hasta que se cancele; no hay mercado que simular. Mandar precio en una MARKET es
400: aceptarlo e ignorarlo ejecutaría a un número que el cliente no pidió.

**Una orden `REJECTED` se persiste y devuelve 201.** Si los pesos o las acciones no
alcanzan, el request igual salió bien y el veredicto del mercado es el payload; un 4xx
diría que estaba mal formado, y no lo estaba.

**Un lock consultivo serializa el envío de órdenes.** La transacción abre con
`SELECT pg_advisory_xact_lock(PLACEMENTS_LOCK, userId)`, así las órdenes de un usuario se
serializan sin que compitan usuarios distintos, y el lock se libera con la transacción. Va
en `READ COMMITTED` porque el saldo tiene que leerse *después* de la espera: un snapshot
repetible mostraría la plata que el anterior ya gastó. Descartado `SERIALIZABLE`, que
convierte un conflicto evitable en un error que todos los clientes tienen que reintentar.

**Cancelar no necesita lock.** La transición es el predicado del UPDATE
(`... WHERE id = $1 AND status IN ('NEW')`): de dos cancelaciones simultáneas solo una toca
una fila y la otra responde 409. Enviar solo hace INSERT, y una orden `NEW` no reservó
plata.

**Al saturarse responde 503, no 500.** El presupuesto de la transacción —5 s de conexión,
10 s de ejecución— acota la cola, no el trabajo; cuando se agota, Prisma tira `P2028`. Es
carga y no un bug, y la orden se puede reenviar sin duplicarla.

**El dinero es una cantidad entera de centavos.** El precio llega validado con dos
decimales, se pasa a `bigint` de centavos por su string decimal y todo el cálculo es
aritmética entera (`src/money.ts` tiene las únicas tres conversiones). `bigint` y no
`number` porque un `size` máximo al tope de `NUMERIC(10, 2)` pasa los 2⁵³ que un double
cuenta exacto.

**La posición corta de −10 BMA del seed se muestra como está.** El usuario 1 vendió 30 BMA
contra 20 compradas; taparlo dejaría al endpoint en desacuerdo con el ledger. Órdenes
nuevas no pueden agrandarla: vender más de lo que se tiene es `REJECTED`.

**Un instrumento sin precio vale 0 y no se puede operar.** `marketValue` es
`ROUND(quantity × COALESCE(close, 0), 2)`, así que una tenencia sin fila en `marketdata`
(PGR e IRCP en el seed) aparece con su cantidad y su costo pero `0.00` de valor. Sacarla
del total rompería la suma de las posiciones listadas, y `null` cambiaría el tipo de un
campo de dinero.

**El efectivo es el instrumento `MONEDA`; `CASH_IN`/`CASH_OUT` son datos, no un
endpoint.** ARS es el instrumento 66 y las transferencias son filas de `orders` con
`price = 1`; las dos puntas entran en `availableCash`. `MONEDA` no se lista ni se puede
operar. `POST /orders` acepta solo `BUY` y `SELL`: exponer un depósito sin autenticación
dejaría a cualquiera emitir pesos.

**`size` o `amount`, y sin fracciones de acción.** Los dos, o ninguno, es 400. Un `amount`
se vuelve `floor(amount / price)` acciones, y si no llega a una acción entera es 400 sin
guardar nada: a diferencia de un rechazo, no hay orden que registrar. La regla vive en el
DTO, antes de abrir transacción.

**La entrada se acota a la forma real de las columnas**: enteros en `[1, 2147483647]` para
los ids y `size`, dinero entre `0.01` y `99999999.99` para los `NUMERIC(10, 2)`. Fuera de
rango es 400 en el borde y no un overflow; un id válido que no existe sigue siendo 404. El
término de búsqueda se compara como string, nunca como patrón.

**Los defaults de Nest, a propósito.** Sin envelope de error propio ni interfaz de
repositorio con una sola implementación. Cada sentencia vive en un repositorio, uno por
módulo; las lecturas de una sola forma y las dos escrituras son SQL crudo y el resto pasa
por Prisma. El portfolio se lee en `REPEATABLE READ`, así que efectivo y posiciones salen
del mismo snapshot.

## Idempotencia

`POST /orders` exige el header `Idempotency-Key`: 1 a 64 caracteres de `[A-Za-z0-9_-]`. Si
se reenvía la misma clave, la API devuelve la **misma** orden con un **200** en vez de
ejecutarla de nuevo: mismo id, mismo estado, mismo precio. Sin clave, o con una fuera de
ese alfabeto, es **400** y no se guarda nada.

**Por qué no alcanza el id de la orden.** El id lo genera el servidor recién cuando la
orden existe. Si la respuesta se pierde, el cliente no tiene id y lo único que puede hacer
es reenviar. La clave la pone el cliente *antes* de mandar, así el reintento y el original
se reconocen como la misma orden.

**Por qué es obligatorio y no opcional.** Una garantía que el cliente puede declinar no es
una garantía: justo el que no manda el header es el que duplica la orden al reintentar. En
una prueba de caos con respuestas perdidas y reintentos, sin clave 28 órdenes se
ejecutaron dos veces (ARS 34.395,65 de nominal duplicado); con clave, cero.

La clave se busca dentro de la transacción, después del lock y antes de decidir nada: como
las órdenes de un usuario ya están serializadas, entre "la clave no está" y "la clave
quedó escrita" no puede correr otra orden suya. Dos requests simultáneos con la misma
clave dan un 201, un 200 y una sola fila.

El esquema cambió por esto: una columna `idempotencyKey` y un índice único parcial por
usuario + clave (en [`db/init.sql`](db/init.sql); para una base que ya existe,
[`db/idempotency-key.sql`](db/idempotency-key.sql) y
[`db/views-and-indexes.sql`](db/views-and-indexes.sql)).

## Base de datos

`db/init.sql` es el `database.sql` del challenge más la columna, las vistas y los índices
de abajo. Compose lo monta en `/docker-entrypoint-initdb.d/` y los containers de test lo
copian igual, así que local y CI ven los mismos datos (4 usuarios, 66 instrumentos, 11
órdenes, 126 filas de marketdata). Lo agregado no toca ninguna tabla existente:

- **`orders.idempotencyKey`** y su índice único sobre
  `(userId, idempotencyKey) WHERE idempotencyKey IS NOT NULL`. Parcial, así las 11 filas
  del seed que no tienen clave quedan como están.
- **Tres vistas** — `cash_balances`, `holdings` y `latest_closes` — con las tres cuentas
  que lee la API: el efectivo neto, el neto y costo promedio por instrumento, y el último
  close por instrumento. Como `holdings` responde tanto las posiciones del portfolio como
  el control de acciones al vender, el número que acepta una operación y el que se muestra
  son la misma definición.
- **Dos índices**: uno parcial de cobertura,
  `orders(userid, instrumentid, side) INCLUDE (size, price) WHERE status = 'FILLED'`, que
  resuelve las tres cuentas sin tocar la tabla, y `marketdata(instrumentid, date DESC)`,
  que con las 126 filas del seed el planner ignora pero sirve cuando entren datos reales.
  Medido sobre 35.013 órdenes, `GET /users/1/portfolio` bajó de 7,44 ms a 3,95 ms de p50
  sobre 250 requests.

Dos notas sobre el esquema provisto: el DDL viene sin comillas, así que Postgres bajó los
nombres a minúscula (`instrumentid`, `userid`, `previousclose`, `accountnumber`) y los
modelos de Prisma los mapean con `@map`; y `marketdata` tiene `date DATE`, no `datetime`
como dice el enunciado — seguí a la base.

Una base creada desde `db/init.sql` (compose, los containers de test, CI) ya tiene todo.
Una que ya existe necesita los dos archivos de migración, que usan `IF NOT EXISTS` y
`CREATE OR REPLACE`, así que aplicarlos dos veces no hace nada. Son DDL: aplicalos a una
base propia, **nunca a la base compartida del challenge** — yo no lo hice.

```bash
docker compose exec -T db psql -U postgres -d cocos -f /dev/stdin < db/idempotency-key.sql
docker compose exec -T db psql -U postgres -d cocos -f /dev/stdin < db/views-and-indexes.sql
```

Prisma está pineado en 6.19.1 sin caret, porque Prisma 7 rechaza `url` dentro del bloque
`datasource`. `npm audit` reporta 4 advisories high que cuelgan de `@prisma/config`,
dependencia del CLI que solo se usa en desarrollo; `@prisma/client`, lo único que corre en
producción, no tiene dependencias propias.

## Limitaciones conocidas

- Una orden `NEW` no reserva plata ni acciones.
- El saldo se pliega sobre todo el historial `FILLED` del usuario en cada operación: a 10×
  de historial, 10× de trabajo adentro del lock.
- `POST /orders` pide un header que el endpoint del challenge no especifica, y rechaza el
  request si falta.
- Una clave repetida con un cuerpo distinto devuelve la orden guardada en vez de avisar.
- La búsqueda no pagina: devuelve las 20 mejores coincidencias y corta.
- A volumen real de `marketdata`, la consulta de posiciones escanea la tabla entera (el
  pushdown no atraviesa ese join); el fix conocido es volver al LATERAL por posición.
- No hay autenticación (el challenge la deja fuera de alcance): `userId` es entrada
  confiada y el cancel no recibe dueño — con auth real haría falta el predicado, no solo un
  parámetro.
- Tampoco hay rate limiting ni headers de seguridad, y el body JSON usa el límite default
  de Express (100 kb).
- Sin auth ni rate limit, un solo caller puede saturar el pool encolándose detrás del lock
  de un usuario y provocar 503 ajenos; en producción, `connection_limit` explícito o un
  try-lock con reintento.

## Qué haría después

1. **Reservar plata y acciones** al aceptar una orden y liberarlas al ejecutarse o
   cancelarse: es lo único que separa esto de un libro de órdenes real.
2. **409 cuando un `Idempotency-Key` vuelve con otra orden**, guardando una huella del
   request al lado de la clave.
3. **Paginación y un índice GIN con `pg_trgm`** para la búsqueda, que hoy recorre todos
   los instrumentos.
