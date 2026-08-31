# Harness de pruebas

Un segundo backend Nest que se para delante de la API del challenge y la ejercita: manda
órdenes contra un ledger espejo que predice cada una, le mete carga y caos, y reconcilia lo
que la API contestó contra lo que la base guardó. No es parte del enunciado: es la
herramienta con la que probé la entrega.

El harness **nunca escribe en la base**: todo lo que manda pasa por la API. La
reconciliación abre una conexión aparte y es solo `SELECT`.

## Cómo correrlo

Requisitos: la API del challenge corriendo en `:3000` y su base de compose arriba
(`npm install && docker compose up -d --wait && npm run start:dev` en la raíz del repo).

```bash
cd tools
npm install
TARGET_API_URL=http://localhost:3000 npm run start:dev   # http://localhost:3001
```

El panel web va aparte:

```bash
cd tools/web
npm install
npm run dev    # http://localhost:5173 — `/` es trading, `/backoffice` es el panel
```

Vite proxea todo al harness en `:3001` y el navegador nunca le pega directo a la API, así
el harness mide las órdenes del panel igual que las suyas.

`npm test` corre los tests unitarios del harness. Variables, todas con default:
`TARGET_API_URL` (`http://localhost:3000`), `PORT` (`3001`), `CHALLENGE_DATABASE_URL`
(`postgresql://postgres:postgres@localhost:5433/cocos`, la base de compose),
`CHALLENGE_REPO_DIR` (el directorio de arriba, de donde sale el `docker compose pause db`) y
`RUNS_DIR` (`tools/runs`).

### Endpoints de control

| Método  | Ruta                                                              | Qué hace                                                       |
| ------- | ----------------------------------------------------------------- | -------------------------------------------------------------- |
| `POST`  | `/simulation/start` · `/simulation/stop` · `/simulation/reset`     | Prende, para o reinicia el loop de órdenes                      |
| `GET`   | `/simulation/state`                                                | Config, contadores y el snapshot del ledger espejo              |
| `POST`  | `/load/run`                                                        | Dispara una corrida de carga (`burst`, `ramp` o `contention`)   |
| `GET`   | `/load/state` · `/load/runs/:runId`                                | La corrida en curso y el resultado de una corrida               |
| `GET`   | `/chaos/state`                                                     | Modos prendidos, contadores y hasta cuándo está pausada la base |
| `POST`  | `/chaos/config`                                                    | Prende o apaga un modo y le mueve la intensidad                 |
| `GET`   | `/backoffice/stats`                                                | Percentiles, conteos por estado y por endpoint, throughput      |
| `GET`   | `/backoffice/anomalies`                                            | Barre las filas nuevas y devuelve las anomalías                 |
| `PATCH` | `/backoffice/config`                                               | Umbral de latencia y config de la simulación                    |
| `POST`  | `/backoffice/anomalies/clear`                                      | Vacía el ring de anomalías                                      |
| `GET`   | `/history/runs` · `/history/runs/:runId[/attempts]`                | Las corridas en disco y sus filas paginadas                     |
| `GET`   | `/attempts`                                                        | Las últimas llamadas que el recorder vio                        |
| `ALL`   | `/api/*`                                                           | Proxy que graba: todo lo que pasa por acá se mide               |

## Cómo leerlo

### Los módulos

- **`src/gateway`** — el recorder: manda cada llamada a la API, la cronometra, le pone el
  `Idempotency-Key` y guarda la fila que después leen todos los demás.
- **`src/simulation`** — el loop de órdenes con un **ledger espejo** que predice el estado y
  el precio de cada orden *antes* de mandarla, con la plata y las acciones que retiene
  mientras está en vuelo; lo que la API contesta se compara contra esa predicción.
- **`src/backoffice`** — barre las filas del recorder con las reglas de anomalías y
  **reconcilia por `Idempotency-Key`**: la llamada que nunca contestó espera a que se cierre
  la ventana de commit tardío de la API y recién ahí le pregunta a la base si la orden entró.
- **`src/load`** — el motor de carga: tres perfiles (`burst`, `ramp`, `contention`) y
  **cinco invariantes** que se chequean cuando la corrida termina.
- **`src/chaos`** — caos estilo Netflix: latencia inyectada, respuestas perdidas, reintento
  del cliente y pausa de la base (`docker compose pause db`). Todo arranca apagado.
- **`src/history`** — cada ventana —una simulación o una corrida de carga— deja un
  directorio en `runs/` con `manifest.json`, `attempts.jsonl` y `anomalies.jsonl`.
- **`src/store`** — el ring de llamadas en memoria del que leen las reglas y las estadísticas.
- **`web/`** — el panel: `/` opera contra la API por el proxy del harness y `/backoffice`
  muestra anomalías, estadísticas, caos y el historial.

### Las anomalías

`critical` es la API rompiendo algo. `warning` es algo que hay que mirar pero que la API
todavía puede explicar. `info` no alarma.

| Regla                 | Severidad | Qué significa                                                                            |
| --------------------- | --------- | ---------------------------------------------------------------------------------------- |
| `http_5xx`            | critical  | La llamada no contestó o contestó 5xx. El 503 no entra acá: es shedding documentado       |
| `unexpected_status`   | critical  | Las reglas decían que la orden quedaba en un estado y la API contestó otro               |
| `balance_drift`       | critical  | El efectivo del espejo y el de la API no coinciden, con los dos lados quietos            |
| `duplicate_execution` | critical  | Una orden lógica quedó dos veces en la base bajo la misma clave                          |
| `lost_order`          | ambas     | Una llamada que nunca contestó, reconciliada contra la base (abajo)                      |
| `latency_high`        | warning   | La respuesta pasó el umbral configurado                                                  |
| `unexpected_shedding` | warning   | Un 503 sin que la simulación ni una corrida estuvieran empujando                         |

**`lost_order` tiene tres veredictos.** Si la base no tiene ninguna fila para la clave, es
`critical`: la orden salió y nunca se procesó. Si tiene filas y alguna llamada recibió
respuesta por ellas, es `warning` **"recovered, not lost"**: el reintento se topó con la
misma clave y la API le devolvió la orden original. Si tiene filas pero nadie recibió
respuesta, es `warning` "processed but unacknowledged": la orden entró y el cliente nunca se
enteró.

**`duplicate_execution` disparando significaría que la API rompió su garantía de
idempotencia** — una orden lógica mandada dos veces bajo una clave y dos filas en la base.
Hoy da cero.

### Las invariantes

Se chequean sobre las filas que la corrida dejó, leídas al terminar:

1. **`conservation`** — el efectivo que dice la API, el fold de las filas `FILLED` y el
   espejo tienen que dar los tres el mismo número.
2. **`no_overdraft`** — el fold de efectivo corrido orden por orden nunca baja de cero.
3. **`no_oversell`** — ninguna posición queda por debajo del piso que tenía antes de la
   corrida (para el usuario 1 en BMA, el seed ya lo deja en −10).
4. **`response_db_agreement`** — cada orden que la API contestó existe en la base con el
   mismo estado, tamaño y precio, y no hay filas nuevas que nadie haya pedido más allá de
   las llamadas que quedaron sin respuesta.
5. **`cancel_safety`** — toda orden que la API dijo haber cancelado lee `CANCELLED`, y sacar
   las filas `CANCELLED` no mueve ni el fold de efectivo ni el de acciones.

### La evidencia

Con este harness se encontró y se cuantificó la falta de idempotencia que motivó el header
obligatorio: en una ventana de caos con respuestas perdidas y reintentos, 28 órdenes se
ejecutaron dos veces. Con `Idempotency-Key`, la misma ventana da cero.
