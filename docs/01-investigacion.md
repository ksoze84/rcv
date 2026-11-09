# Investigacion inicial: RCV del SII

Fecha: 2026-09-29. Estado: IMPLEMENTACIÓN AVANZADA (Identidad verificada real en Clave Tributaria y Clave Única; resuelto paso de click Consultar y espera de renderizado en SPA de RCV; falta validación de descarga de CSV).

## Alcance y evidencia

Se revisaron las instrucciones locales, los nombres y presencia de variables de
entorno y la implementacion de navegacion del proyecto hermano
`../ImpuestoHerenciasSii`. No se imprimieron valores del archivo de secretos,
no se instalaron dependencias y no se enviaron credenciales al SII.

El flujo detallado solicitado descarga CSV, aunque la introduccion menciona
Excel. Se propone implementar CSV de Compras y Ventas para febrero de 2026,
sin agregar conversion a XLSX ni selector de otros periodos en esta etapa.

## Entorno local

- El proyecto contiene las instrucciones y un archivo `.env`; no hay app ni tests.
- Node disponible: `v24.20.0`. El entorno indicado es WSL con Debian.
- Se verifico presencia de valores, NO validez de credenciales, para
  `USER_RUT`, `CLAVE_UNICA_USER`, `CLAVE_UNICA_PASS`, `TIBUTARIA_USER`,
  `TRIBUTARIA_PASS`, `OPENROUTER_KEY` y `OPENROUTER_MODEL`.
- `TIBUTARIA_USER` tiene una errata. Propuesta: aceptar ese alias existente y
  preferir `TRIBUTARIA_USER` si se configura, sin modificar el archivo actual.
- No usar `USER` para el RUT: puede existir como variable del sistema.
- El archivo de secretos tiene permisos `644`. Propuesta para la implementacion:
  restringirlo a `600` y excluirlo de Git, junto con descargas, perfiles y trazas.
- No se verificaron todavia Chromium, bibliotecas de Debian ni conectividad al RCV.

## Referencia reutilizable

Fuentes locales del proyecto hermano:

- `package.json`: workspaces `server` y `web`, Node >=22.18.0 e instalacion
  de Chromium mediante Playwright.
- `server/src/infrastructure/browser/StagehandNavigator.js`: usa
  `localBrowser` y `Stagehand`, resolucion DNS previa, timeouts acotados,
  selectores deterministas y cierre de navegadores activos.
- `server/src/infrastructure/config/environment.js`: configuracion del servidor.
- `server/src/infrastructure/llm/openRouterModel.js`: adaptacion de OpenRouter.

La revision delegada informa Stagehand 4.1.0 en la referencia. La API instalada
y sus tipos se verificaran al fijar dependencias; no copiar ejemplos de v3.
La documentacion oficial ofrece ambas versiones en paralelo.

La referencia resuelve `www.sii.cl` y `zeusr.sii.cl` antes de lanzar Chromium.
Sus comentarios describen fallos DNS intermitentes; esto NO demuestra que el
problema exista actualmente en `www4.sii.cl` o en el portal de Clave Unica.
Se reutilizara la idea de diagnostico, no direcciones IP fijas ni cambios globales
de DNS. Mantener TLS y hostname verification habilitados.

## Autenticacion: diferencia decisiva

En `StagehandNavigator.js`, el resultado de login busca mensajes de rechazo y
la presencia de `#rutcntr` o `#clave`. Si no encuentra esos elementos, devuelve
exito sin evidencia positiva de identidad. Ademas, captura fallos y continua sin
sesion porque el XLSX de herencias es publico. Ese comportamiento no sirve para
un RCV privado. No se atribuye a esto la causa exacta del fallo anterior sin una
prueba real; si es una insuficiencia comprobada del criterio de exito.

La revision del proyecto hermano no encontro un flujo implementado de Clave
Unica. Un comentario que la mencione no acredita soporte ni una prueba exitosa.

Hipotesis de trabajo: ambos mecanismos deben producir una sesion verificada
del RUT solicitado en el mismo contexto de navegador que descarga los CSV.
La ausencia del formulario, una redireccion o un HTTP 200 no prueban login.

Chequeo discriminante tras aprobar el plan: probar el verificador contra una
pagina publica sin formulario, una sesion de otro RUT y una sesion expirada;
debe rechazar las tres. Luego comprobar identidad, acceso al RCV y periodo en
una prueba real controlada por cada mecanismo. No descargar datos de otro RUT.

## Incertidumbres que requieren comprobacion

| Tema | Comprobacion prevista | Criterio |
| --- | --- | --- |
| Stagehand | Prueba local con la version fijada, sin solicitudes LLM | Navegar e interactuar sin necesitar IA |
| WSL y DNS | Resolucion del sistema y navegacion publica con TLS valido | Diferenciar DNS, certificados y timeout |
| Clave Unica | Inspeccion del enlace oficial y sus redirecciones | Origen autorizado antes de rellenar campos |
| Sesion | Evidencia positiva de identidad y acceso al RCV | RUT autenticado y contribuyente activo coinciden |
| Periodo | Inspeccion de controles y estado cargado | Febrero de 2026 antes de cada descarga |
| Descargas | Evento o mecanismo soportado por la version, por cada clic | CSV completo, no HTML de login ni archivo anterior |
| CSV | Encabezados y codificacion de muestras controladas | No inventar columnas ni perder celdas |
| Cuenta | Una prueba por mecanismo, secuencial | Sin reintentos de credenciales rechazadas |

## IA y privacidad

Hipotesis inicial: los pasos conocidos pueden resolverse con Stagehand y
selectores deterministas, sin IA. La prueba local debe poder desmentir esa
hipotesis antes de incorporar un adaptador o pagar inferencias.

La documentacion oficial v4 confirma que `Stagehand.create({ browser })`
puede inicializarse sin modelo con un navegador local. La necesidad de modelo
se resuelve cuando una operacion solicita inferencia. Usar las operaciones
deterministas de pagina y locator, sin `act`, `observe` ni `extract` con IA.
Cerrar tanto Stagehand como el navegador, pues `stagehand.close()` no cierra
el navegador que recibe. Esta evidencia documental no reemplaza la prueba
con la version instalada.

OpenRouter queda como integracion opcional, apagada por defecto. No enviar
credenciales, cookies, tokens, RUT, DOM autenticado ni registros tributarios a
un proveedor de IA. No habilitar una recuperacion automatica que envie el DOM
al modelo si falla un selector. Evaluar cualquier uso futuro solo en paginas
publicas y con una necesidad demostrada y un modelo disponible y compatible.

La API v4 no admite `baseURL` en la configuracion de modelo: el transporte a
OpenRouter debe implementarse con el callback `model: { generate }`, solo si
resulta necesario. El modelo debe soportar respuestas estructuradas. No se
ha probado el token ni el modelo configurado; no se ha consumido inferencia
de OpenRouter para esta investigacion.

## Fuentes oficiales

- [Indice Stagehand](https://docs.stagehand.dev/llms.txt): identifica documentacion v4 y v3.
- [API Stagehand v3](https://docs.stagehand.dev/v3/references/stagehand): referencia consultada, NO contrato de v4.
- [API Stagehand v4](https://docs.stagehand.dev/v4/reference/stagehand.md): inicializacion y cierre verificados documentalmente.
- [Modelos v4](https://docs.stagehand.dev/v4/configuration/models.md): configuracion local sin modelo y callback personalizado.
- [Navegador v4](https://docs.stagehand.dev/v4/configuration/browser.md): `localBrowser.launch`, ruta del ejecutable y descargas.

No hay pruebas reales de login ni de descarga RCV ejecutadas en esta fase.