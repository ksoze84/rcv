# Arquitectura propuesta

Estado: aprobado el 2026-09-29. Periodo unico: febrero de 2026 (`2026-02`).
Base: [investigacion](01-investigacion.md) y [prompt inicial](../initialPrompt.md).

## Alcance

Aplicacion local de un usuario en WSL/Debian. Obtener el RCV del RUT autenticado,
descargar Compras y Ventas del periodo indicado, procesar sus CSV y mostrar dos
tablas. No modificar documentos ni declaraciones del SII. Sin base de datos,
historial tributario, exportacion XLSX, representacion de otros contribuyentes
ni despliegue publico en esta entrega.

El formulario tendra usuario/RUT, contrasena, dos radios (Clave Tributaria y
Clave Unica) y un unico boton: Obtener registro. El periodo sera visible como
dato fijo, no como un control adicional.

## Componentes y responsabilidades

| Componente | Responsabilidad |
| --- | --- |
| React + Vite | Formulario, peticion, estado de carga, errores y dos tablas |
| Express | Validacion HTTP, limites, politica de origen y traduccion de errores |
| GetRcv | Orquestar una consulta y garantizar cierre y limpieza |
| RcvProvider | Puerto pequeno para obtener los dos registros desde el SII |
| StagehandRcvProvider | Navegador local, autenticacion, periodo y descargas |
| TributariaAuth / ClaveUnicaAuth | Dos flujos explicitos, sin mezclar credenciales |
| AuthAttemptGuard | Serializar envios, espera minima y bloqueo preventivo |
| CsvParser | Decodificar y validar CSV sin perder valores ni columnas |
| Contratos compartidos | Tipos y esquemas de entrada/salida, sin secretos ni Node |

La logica de aplicacion depende de un puerto, no de Express ni de Stagehand.
Inyeccion manual al arrancar; sin contenedor DI, buses, colas externas o jerarquia
de clases para funciones simples. El adaptador de OpenRouter solo se agrega
si se demuestra una necesidad real de IA.

## Estructura prevista

```text
rcv/
  docs/
    01-investigacion.md
    02-arquitectura.md
    03-plan-implementacion.md
    prompts/
  shared/
    rcv.ts
  server/
    src/
      domain/rcvProvider.ts
      application/getRcv.ts
      infrastructure/config/environment.ts
      infrastructure/sii/stagehandRcvProvider.ts
      infrastructure/sii/tributariaAuth.ts
      infrastructure/sii/claveUnicaAuth.ts
      infrastructure/sii/authAttemptGuard.ts
      infrastructure/csv/parseRcvCsv.ts
      http/app.ts
      http/rcvRoute.ts
      index.ts
    test/
  web/
    src/
      components/CredentialsForm.tsx
      components/RcvTable.tsx
      api/rcv.ts
      App.tsx
      styles.css
    test/
  tests/e2e/
  .local/
  .env.example
  .gitignore
  package.json
  package-lock.json
  tsconfig.base.json
```

Es una propuesta de responsabilidades, no una orden de crear archivos vacios.
Crear cada modulo cuando tenga comportamiento y prueba. Workspaces npm `server`
y `web`; `shared` contiene exclusivamente contratos utilizables por ambos.
`.local` queda ignorado y solo puede contener marcas temporales del limitador,
sin RUT, credenciales, cookies ni CSV. Descargas y perfiles son temporales.

## Dependencias

| Area | Dependencias propuestas | Motivo |
| --- | --- | --- |
| Runtime | Node 24, TypeScript en modo estricto, npm workspaces | Entorno disponible, tipos y ejecucion local |
| HTTP | Express 5, Zod, Helmet | API sencilla, validacion y cabeceras |
| Navegacion | `@browserbasehq/stagehand` v4, Chromium | Requisito; operaciones deterministas locales |
| CSV | `csv-parse`, `TextDecoder` de Node | Parser probado; UTF-8 y Windows-1252 |
| Interfaz | React, React DOM, Vite, plugin React, `lucide-react` | Formulario y tablas accesibles |
| Desarrollo | `tsx`, ESLint, tipos de Node/React/Express, `concurrently` | Iteracion y comprobaciones |
| Pruebas | Vitest, Supertest, Testing Library, jsdom, `@playwright/test` | Unidad, HTTP, UI y navegador |
| IA opcional | SDK compatible con OpenRouter, solo si es necesario | Callback de generacion de Stagehand v4 |

Verificar engines y tipos, fijar versiones compatibles y generar lockfile tras
la aprobacion. Playwright se usa para pruebas e instalacion de Chromium; no
reemplaza a Stagehand como adaptador de navegacion al SII. No se supone que las
APIs de Page sean intercambiables. No instalar parsers XLSX ni una base de datos.

## Contrato HTTP

Una sola operacion `POST /api/rcv`, con JSON `{ rut, password, authMode }`.
`authMode` acepta `tributaria` o `clave-unica`. Validar esquema estricto, RUT y
digito verificador antes de abrir un navegador. La contrasena no se recorta ni
transforma. El periodo lo fija el servidor a `{ year: 2026, month: 2 }`.

Respuesta exitosa: `{ period, status, compras, ventas }`, donde cada registro
incluye `status`, `columns: string[]` y `rows: string[][]`. Preservar encabezados,
orden, columnas duplicadas y celdas originales; no usar el texto del encabezado
como clave unica. Estados por registro: `ok`, `empty`, `error`. Estado global:
`complete` o `partial`. Los errores parciales incluyen codigo y mensaje seguro.

### Reglas de agregación y estados sin movimientos (empty)
Un contribuyente puede no registrar movimientos en compras, en ventas o en ambos
para cualquier período tributario (por ejemplo, RUT sin ventas en febrero de 2026).
El estado `empty` se gestiona de forma estrictamente independiente por registro:
- Ambas vacías (`empty` + `empty`): resultado global `complete`, ambas tablas en estado neutral sin movimientos.
- Una vacía y otra con movimientos (`empty` + `ok` o `ok` + `empty`): resultado global `complete`, preservando íntegramente los datos de la pestaña con movimientos (ej. Compras conservado).
- Una con movimientos/vacía y otra con fallo (`empty`/`ok` + `error`): resultado global `partial`. Un error técnico NUNCA debe convertirse en `empty`.
- Ambas con fallo (`error` + `error`): fallo global HTTP 502 (`RCV_FETCH_FAILED`).

Una ausencia de movimientos sólo se declara `empty` bajo dos condiciones confirmadas:
1. Confirmación explícita por portal: circunscrita estrictamente al contenedor de la pestaña ACTIVA y al período confirmado (año y mes coincidentes en controles), sin aceptar texto global o paneles inactivos de la otra pestaña. Si los controles reales son desconocidos, se opera bajo fail-closed sin inventar selectores.
2. Descarga de CSV válido con sólo encabezados: archivo CSV decodificado y parseado exitosamente que contiene fila de encabezados válida y cero filas de datos.
Una descarga fallida, timeout, archivo de 0 bytes, HTML de login o botón ausente/deshabilitado sin confirmación explícita constituyen error técnico y no deben asumirse como registro vacío. Un desacuerdo de identidad aborta toda la consulta, sin devolver datos mezclados.

### Flujo de consulta y captura en SPA RCV (/consdcvinternetui/#/index)
1. **Pantalla inicial autenticada**: contiene selectores de RUT (`rut`), mes (`#periodoMes`) y año (`periodoAnho`), junto al botón `Consultar` (`type="submit"`). Antes de pulsar dicho botón, no existen pestañas Compras/Ventas ni tablas (`tableCount: 0`).
2. **Sincronización Angular y consulta**: se selecciona el período objetivo (2026-02), se disparan eventos estándar `input`/`change` con bubbling y manejadores de AngularJS (`triggerHandler('change')` y `$apply`), se hace click en `Consultar` UNA vez y se espera el renderizado de resultados (aparición de pestañas, tablas o mensaje explícito de sin movimientos) antes de intentar seleccionar pestañas o descargar.
3. **Captura secuencial sin reconsultas innecesarias**: entre Compras y Ventas, si la UI ya está cargada para el período, se evita pulsar `Consultar` nuevamente; se re-verifica el período y la pestaña activa antes de cada descarga.
4. **Clasificación segura de errores y etapas (stage)**: ante fallos en cualquier paso de la captura, se clasifica el error en códigos enumerados estables (`PERIOD_SELECT_FAILED`, `ANGULAR_NOT_AVAILABLE`, `QUERY_BUTTON_MISSING`, `RESULTS_NOT_RENDERED`, `TAB_NOT_FOUND`, `DOWNLOAD_TRIGGER_FAILED`, `EVALUATE_FAILED`, `TIMEOUT`, `RCV_DOWNLOAD_UNAVAILABLE`) acompañados del campo seguro `stage` (`period_selection`, `query_button`, `results_render`, `verify_period`, `tab_selection`, `tab_inspection`, `download_trigger`, `download_capture`). NUNCA se interpolan mensajes externos ni URLs/tokens en los mensajes reportados. Fail-closed: ante la ausencia de botón de descarga sin mensaje explícito de sin movimientos, se retorna `RCV_DOWNLOAD_UNAVAILABLE`.

### Limitación de verificación sin login real
De acuerdo con las políticas de seguridad y uso responsable del SII, no se ejecutan autenticaciones reales ni conexiones a red privada para esta verificación. Todo el comportamiento se valida rigurosamente mediante fixtures sintéticas, simulación DOM de pestañas activas/inactivas (JSDOM) y pruebas unitarias/integración aisladas.

Errores HTTP: 400 entrada invalida; 401 credenciales rechazadas/sesion invalida;
403 acceso denegado; 409 operacion en curso; 429 enfriamiento o bloqueo, con
`Retry-After`; 502 respuesta/navegacion/CSV invalido; 504 timeout; 500 error interno.
Formato `{ error: { code, message, retryAfterSeconds? } }`, sin stack ni contenido
del portal. Timeout global inicial de 240 segundos, ajustable con evidencia.

Una peticion en curso por instancia local. Una desconexion del cliente o timeout
cancela el trabajo y cierra recursos. No crear una cola que retenga contrasenas.
El frontend muestra carga indeterminada, sin inventar porcentajes ni etapas
que la API no comunique. No se necesita polling, SSE ni un almacen de trabajos.

## Flujo de navegador

1. Abrir Chromium local con Stagehand v4, perfil efimero y descargas aisladas.
   Visitar `https://sii.cl` y comprobar si ya existe una sesion valida en ese
   contexto. No importar cookies ni conectarse al Chrome personal del usuario.
2. Si falta sesion, seguir el acceso oficial correspondiente. Para Clave Unica,
   conservar las redirecciones, estado y retorno oficiales. Verificar el origen
   exacto antes de introducir credenciales; no deducir confianza solo del titulo.
3. Aplicar el limitador inmediatamente antes del envio y verificar el resultado
   con evidencia positiva de identidad. No equiparar redireccion o ausencia del
   formulario a login exitoso. No continuar de forma anonima si falla el acceso.
4. Navegar en el mismo contexto a `https://www4.sii.cl/consdcvinternetui/#/index`.
   Confirmar RUT autenticado y contribuyente activo; ambos deben corresponder
   al solicitado. No elegir otro representado para hacer pasar la prueba.
5. Seleccionar anio 2026 y mes febrero, activar la consulta si el portal lo pide
   y esperar controles/resultados listos. No usar solamente `networkidle`.
6. Seleccionar Compras, verificar periodo y tipo, preparar la captura y pulsar
   Descargar detalles. Esperar finalizacion y validar el archivo de ese clic.
7. Repetir para Ventas, verificando otra vez periodo y tipo. No recoger el CSV
   anterior por ser el primer archivo de un directorio compartido.
8. Procesar ambos resultados. En `finally`, cerrar Stagehand y navegador por
   separado, eliminar archivos y perfil, y liberar el bloqueo de concurrencia.

El mecanismo de descarga se verifica en la version fijada: preferir un evento
soportado y, si no existe, un directorio vacio por captura con comprobacion de
finalizacion y timeout. Nunca considerar `.crdownload` un CSV terminado.
Verificar tambien metadata del archivo si contiene RUT/periodo; si no la tiene,
correlacionarlo con el estado del portal comprobado inmediatamente antes del clic.

## Seguridad y operacion

- Solo loopback (`127.0.0.1`), API y web del mismo origen mediante proxy Vite en
  desarrollo; validar Host/Origin y JSON, sin CORS abierto. Un despliegue remoto
  requiere otro diseno con HTTPS y autenticacion propia, fuera de este alcance.
- No logs de cuerpos, contrasenas, RUT, cookies, tokens, CSV, DOM autenticado ni
  URLs con tokens. Errores y telemetria de Stagehand tambien deben pasar por una
  politica de datos permitidos. Sin grabaciones o capturas reales por defecto.
- Secretos solo en servidor; nunca variables `VITE_*`, bundle, localStorage,
  historial o parametros URL. `Cache-Control: no-store` para respuestas sensibles.
  Vaciar la contrasena del formulario tras su envio y soltar referencias al cerrar.
- Credenciales del formulario para la app; variables de prueba solo para el
  ejecutor de smoke tests. Nunca usar credenciales de entorno como fallback de
  una peticion incompleta. Compatibilidad con `TIBUTARIA_USER` sin renombrar valores.
- Restriccion a `600` del archivo de secretos al implementar; ejemplo de entorno
  sin valores reales y exclusiones de Git antes de crear artefactos sensibles.
- Intervalo global minimo de 15 segundos entre envios de autenticacion, tambien
  al cambiar de mecanismo. Nunca reenviar automaticamente credenciales rechazadas
  ni repetir un envio cuyo resultado sea ambiguo.
- Ante bloqueo del portal, detener intentos durante al menos 30 minutos y mostrar
  ese plazo. Respetar plazos mayores informados por el portal; no prometer que
  la cuenta estara desbloqueada exactamente al terminar el contador.
- Servidor y pruebas reales usan el mismo limitador. Persistir solo las marcas
  de proximo intento/bloqueo, con permisos privados, para que un reinicio no borre
  la proteccion. No ejecutar instancias de automatizacion simultaneas.
- Esperas por estado, pausas variables acotadas y scroll/hover ordinarios cuando
  proceda; user-agent nativo coherente con Chromium. Sin proxies, VPN, plugins
  de ocultamiento ni garantia de evitar deteccion. CAPTCHA/MFA o desafio de
  seguridad detienen el flujo y se informan; no se intentan eludir.
- Diagnosticar DNS/TLS en WSL. Reintentos acotados solo para navegaciones seguras,
  nunca para el envio de login. Sin IP persistente, cambios globales de DNS,
  certificados ignorados, `--disable-web-security` ni sandbox desactivado por defecto.
- Limites explicitos de descarga y registros: inicialmente 10 MiB y 20.000 filas
  por CSV. Si se exceden, devolver error claro, sin truncar silenciosamente.

## CSV e interfaz

Verificar delimitador y encabezados con muestras controladas antes de fijar el
contrato del adaptador. Probar punto y coma/coma, comillas, saltos de linea
embebidos, BOM UTF-8, Windows-1252, caracteres acentuados y archivos solo con
encabezados. Rechazar HTML, CSV incompleto y filas inconsistentes. Mantener RUT,
folios, fechas e importes como texto, sin conversiones numericas destructivas.

Dos tablas con todos los campos, recuento de registros, encabezado fijo y scroll
horizontal propio. Estado sin movimientos y error parcial por separado. React
renderiza texto, nunca HTML del CSV ni formulas ejecutables. Interfaz sobria,
legible y adaptable a movil, sin landing page ni paneles decorativos. Probar
volumen alto; si el render lo requiere, virtualizar filas con una biblioteca
probada, conservando acceso a todos los registros y el unico boton de accion.

## Decision de IA

Iniciar sin IA: pagina y locators de Stagehand v4, sin recuperacion con LLM.
Verificar cero llamadas de inferencia y ninguna dependencia de token para ese
flujo. Si se demuestra una necesidad en navegacion publica, evaluar primero
`OPENROUTER_MODEL` por disponibilidad, salida estructurada, precision, latencia
y costo; comparar un modelo economico compatible antes de escalar. No escoger
el modelo por la recomendacion de subagentes de desarrollo, que es otro contexto.

Solo entonces implementar el callback de OpenRouter con la clave en servidor,
timeout y presupuesto acotados. Nunca utilizarlo sobre login, sesion autenticada
o datos tributarios. No activar IA ni cambiar modelo silenciosamente si falla
un selector; documentar necesidad y someter cualquier cambio de alcance a revision.