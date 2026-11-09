# Plan de implementacion y validacion

Fecha: 2026-09-30. Estado: COMPLETADO Y VERIFICADO.
Periodo solicitado: febrero de 2026 (`2026-02`).

Referencias: [prompt inicial](../initialPrompt.md),
[instrucciones](../AGENTS.MD), [investigacion](01-investigacion.md) y
[arquitectura](02-arquitectura.md).

## Puerta de aprobacion

El usuario aprobo explicitamente el plan el 2026-09-29 y autorizo continuar
la implementacion con Gemini 3.8 Flash sin importar el nivel de esfuerzo.
Esta aprobacion habilita las tareas del plan, incluidas las pruebas reales
controladas. No autoriza sustituir el modelo ni omitir las guardas de seguridad.

## Supuestos para revision

- Uso local e individual en WSL/Debian, no servidor publico ni multiusuario.
- RUT consultado igual al autenticado; sin actuar por otros contribuyentes.
- Febrero de 2026 fijo para ambas descargas, sin selector de periodo en la UI.
- Se descargan CSV, de acuerdo con el flujo detallado, sin conversion a Excel.
- CSV/perfiles temporales y resultados solo en memoria. Persistencia exclusiva
  de marcas de tiempo sin identidad para respetar enfriamientos tras reinicios.
- IA desactivada mientras las operaciones deterministas sean suficientes.
- Credenciales de prueba ya configuradas, pero aun no comprobadas contra el SII.

## Tareas y orden

| ID | Tarea | Depende de | Resultado verificable | Estado verificado |
| --- | --- | --- | --- | --- |
| T0 | Aprobacion y condiciones de delegacion | Plan presentado | Usuario aprueba alcance; modelo/esfuerzo resueltos | COMPLETADA |
| T1 | Base TypeScript, workspaces y seguridad local | T0 | API/web minimas, secretos excluidos, typecheck y build | COMPLETADA |
| T2 | Comprobar Stagehand v4 en WSL | T1 | Navegacion y descarga sintetica sin IA ni credenciales | COMPLETADA |
| T3 | Guardas y ambos flujos de autenticacion | T2 | Tests locales de identidad, 15 segundos y 30 minutos | COMPLETADA |
| T4 | Navegar RCV y descargar por tipo/periodo | T3 | Dos capturas independientes con periodo y RUT verificados | COMPLETADA |
| T5 | Parser CSV y contrato de resultados | T1 | Fixtures sinteticas pasan; valores y columnas preservados | COMPLETADA |
| T6 | Formulario, API y tablas | T1, contrato T5 | Un boton, dos modos y dos tablas; estados probados | COMPLETADA |
| T7 | Integracion y pruebas automatizadas completas | T3, T4, T5, T6 | Errores, limpieza, privacidad y controles funcionando | COMPLETADA |
| T8 | Smoke real Clave Tributaria | T7 | Login y RCV febrero de 2026, o impedimento documentado | COMPLETADA Y VERIFICADA con descarga real de CSV y parseo |
| T9 | Smoke real Clave Unica | T8 sin bloqueo activo | Login y RCV febrero de 2026, o impedimento documentado | COMPLETADA Y VERIFICADA con descarga real de CSV y parseo |
| T10 | Entrega y revision de resultados | T8, T9 | Reporte honesto, docs actualizados y URL local | COMPLETADA (app local activa en http://127.0.0.1:5173, API 3001) |

## Detalle de ejecucion

### T1: base reproducible

Crear solo los modulos iniciales necesarios. Instalar versiones compatibles con
Node disponible, fijar lockfile y configurar TypeScript estricto, lint, tests y
build. Conservar instrucciones y secretos actuales. Crear ejemplo de entorno
sin credenciales, exclusiones y configuracion de loopback. Separar la carga de
credenciales de pruebas de la aplicacion. Verificar alias `TIBUTARIA_USER`.

### T2: prueba tecnica acotada

Comprobar ejecutable Chromium, librerias Linux, Stagehand v4 y su API real.
Una pagina local sintetica debe permitir navegar, rellenar campos y descargar
un archivo sin modelo ni llamadas externas de IA; comprobar cierre completo.
Verificar como correlacionar y esperar descargas en esa version antes de
implementar el RCV. No asumir `page.waitForEvent` de Playwright en Stagehand.

Despues diagnosticar conectividad publica a SII/RCV, sin enviar credenciales.
Identificar enlaces oficiales, dominios y controles de acceso de ambos modos.
No copiar flags inseguros de ejemplos. Si falta un paquete del sistema que
requiera privilegios, documentar el comando para que lo ejecute el usuario.

### T3 y T4: navegacion y autenticacion

Implementar estrategias separadas, limitador compartido y verificacion positiva
de sesion. Probarlos en paginas sinteticas antes de cualquier login real.
Rechazar paginas publicas sin formulario, sesiones de otro RUT y caducadas.
Reservar el intento antes de pulsar ingreso; un timeout posterior no autoriza
un nuevo envio. Manejar estados de rechazo, bloqueo, desafio y retorno incompleto.

Tras confirmar sesion, verificar contribuyente, seleccionar febrero de 2026 y
capturar Compras y Ventas por separado. Asegurar que la inspección de "sin movimientos"
esté circunscrita estrictamente al contenedor de la pestaña activa y al período
confirmado en los controles de la página, sin admitir texto global de pestañas
inactivas ni inventar selectores desconocidos (fail-closed ante falta de botón
o ausencia de mensaje explícito). No asumir ausencia de movimientos por timeout.
Validación de ausencia y meses sin movimientos probada localmente con simulación
DOM aislada (JSDOM) sin login real ni tráfico privado.

### T5: procesamiento

Usar un parser CSV probado. Definir fixtures sinteticas de ambos tipos y ajustar
el adaptador al formato real cuando pueda verificarse. No versionar archivos
tributarios reales. Validar codificacion, delimitador, estructura, limites y
estados vacios (incluyendo CSV válido con únicamente fila de encabezados como
status `empty`). Errores de descarga o CSV corrupto nunca se transforman en vacío.
estados vacios. Rechazar archivos ajenos o HTML; no recortar datos para hacer
pasar un test ni convertir cifras a flotantes innecesariamente.

### T6 y T7: experiencia e integracion

Conectar formulario, unico POST y tablas. No autocompletar el formulario con
secretos del servidor. Deshabilitar envios duplicados, mostrar carga real,
mensajes claros y errores parciales; no ocultar la ausencia de una descarga.
Comprobar limpieza en exito, fallo, cancelacion, timeout y cierre del proceso.

Ejecutar pruebas locales, typecheck, lint y build. Verificar interfaz con
Playwright a 360 y 1440 px de ancho, usando datos sinteticos y sin solapamientos.
Comprobar alto volumen y que todas las columnas/registros sean accesibles.
Revisar bundle, respuestas y logs por ausencia de secretos y datos innecesarios.

## Delegacion requerida

El usuario requiere subagentes para tareas pequenas de implementacion, usando
Gemini 3.8 Flash. El 2026-09-29 autorizo cualquier nivel de esfuerzo. Invocar el
modelo explicitamente para cada tarea y asignar archivos concretos; no
sustituirlo en silencio. Si no esta disponible, comunicar el bloqueo. La
herramienta no expone un parametro de esfuerzo; no atribuirle uno no verificable.

La seleccion del modelo de un subagente de desarrollo es independiente del
modelo configurado en OpenRouter para la aplicacion. No utilizar el token local
de OpenRouter para intentar cambiar el modelo del asistente.

El coordinador fija contratos, asigna una tarea por invocacion e integra y prueba
los cambios. T5 y la UI de T6 pueden avanzar en paralelo despues de fijar el
contrato; autenticaciones reales siempre son secuenciales y centralizadas.
Los subagentes no leen secretos ni ejecutan logins reales por su cuenta.

Se preparan prompts reutilizables dentro de `docs/prompts`, como solicita el
usuario. Esa ubicacion documental no registra comandos slash automaticamente;
pueden adjuntarse al delegado o ejecutarse desde el editor. No modificar la
configuracion global de VS Code para registrarlos.

- [Implementar una tarea](prompts/implementar-tarea.prompt.md): plantilla para
   cada delegado T1-T7, con modelo solicitado y limites de acceso.
- [Validar una autenticacion](prompts/validar-autenticacion.prompt.md): una
   ejecucion real T8 o T9 por el coordinador, siempre secuencial.

## Matriz de pruebas automatizadas

| Area | Casos obligatorios | Evidencia esperada |
| --- | --- | --- |
| Entrada/config | RUT valido/invalido, modos, contrasena intacta, alias, sin fallback de credenciales | Errores seguros antes del navegador |
| Limitador | 14,999 s / 15 s, cambio de modo, bloqueo 30 min, reinicio, concurrencia | Nunca enviar antes del plazo; usar reloj falso |
| Identidad | Redireccion sin sesion, otro RUT, sesion caducada, sesion valida | Solo la ultima permite descargar |
| Autenticacion | Ambos formularios, retorno, rechazo, desafio, origen no autorizado | Flujo determinista, sin reenvio automatico |
| Periodo | Febrero de 2026, periodo incorrecto, carga pendiente | Captura prohibida sin periodo confirmado |
| Descargas | Compras/ventas distintas, archivo previo, incompleto, timeout, HTML | No confundir registros ni declarar falso exito |
| CSV | BOM, Windows-1252, separadores, comillas, multilinea, duplicados, ceros, vacio | Todas las celdas preservadas o error explicito |
| API | Origen ajeno, doble envio, partial, ambos fallan, desconexion, limites | Codigos correctos y limpieza |
| Privacidad | Credenciales/DOM/CSV en logs, IA deshabilitada, cache y bundle | Sin filtraciones ni llamadas LLM |
| UI | Dos modos, un boton, carga, errores, vacio, tablas, movil, alto volumen | Uso correcto sin solapamientos ni datos truncados |

Scripts previstos, que se crearan en T1: `npm run typecheck`, `npm run lint`,
`npm test`, `npm run build` y `npm run test:e2e`. Son pruebas locales y NO deben
contactar al SII. Los tests reales estaran separados y desactivados por defecto.

## Protocolo de pruebas reales

1. Confirmar plan aprobado, credenciales configuradas para ambos modos y ausencia
   de bloqueo activo. No solicitar contrasenas ni tokens por el chat.
2. Activar explicitamente el ejecutor real y procesar una autenticacion a la vez
   a traves del mismo servidor/limitador. No hacer logins desde subagentes,
   pruebas unitarias, CI o una sesion de navegador diferente en paralelo.
3. Primera prueba con `TRIBUTARIA_USER` o su alias `TIBUTARIA_USER`, y
   `TRIBUTARIA_PASS`. Verificar identidad, febrero de 2026 y ambos CSV/tablas.
4. Segunda prueba con `CLAVE_UNICA_USER` y `CLAVE_UNICA_PASS`, en contexto limpio.
   Respetar al menos 15 segundos desde el ultimo envio aunque sean RUT diferentes.
5. Ante rechazo, resultado ambiguo, CAPTCHA/MFA o bloqueo, detener el flujo
   afectado. No probar contrasenas deliberadamente incorrectas en el portal.
   Un bloqueo detiene las pruebas restantes por 30 minutos como minimo. Cualquier
   nuevo intento tras fallo requiere revision y autorizacion del usuario.
6. Mostrar resultados por mecanismo: autenticacion, periodo confirmado, estado
   de cada CSV, recuento de filas, duracion y motivo de fallo si existe. Sin
   valores tributarios, RUT, capturas privadas o credenciales en el reporte.
7. Pedir revision y aprobacion de los resultados. Un resultado bloqueado o no
   ejecutado no cuenta como exito. Sin movimientos debe estar confirmado por
   el portal y distinguirse de haber probado una descarga con filas reales.

| Prueba real | Periodo | Estado actual | Siguiente paso / Bloqueador |
| --- | --- | --- | --- |
| Clave Tributaria: login + Compras + Ventas | 2026-02 | COMPLETADA Y VERIFICADA con descarga real de CSV y parseo | SUCCESS rcvStatus complete, compras ok count 3, ventas status EMPTY count 0 (el RUT tributario no registra ventas en febrero 2026, confirmado por el usuario y por el mensaje del portal 'No hay información de Ventas.'), elapsed 8365 ms, blocked false. |
| Clave Unica: login + Compras + Ventas | 2026-02 | COMPLETADA Y VERIFICADA con descarga real de CSV y parseo | SUCCESS rcvStatus complete, compras ok count 3, ventas ok count 1, reproducible en 3 ejecuciones (elapsed 14966/38542/12062 ms), blocked false. |

### Resultados reales finales de ejecucion y diagnostico (2026-09-30)

- **Resultados de pruebas reales (periodo 2026-02)**:
  - **(1) CLAVE UNICA (`--full`)**:
    - Resultado: `SUCCESS`, `rcvStatus: complete`.
    - Compras: estado `ok`, recuento 3 (`count: 3`).
    - Ventas: estado `ok`, recuento 1 (`count: 1`).
    - Reproducibilidad: comprobado y reproducible en 3 ejecuciones reales consecutivas (`elapsedMs: 14966`, `38542`, `12062`).
    - Guardas de seguridad: `blocked: false`, reserva de tiempo de enfriamiento de autenticacion confirmada.
    - Estado de tarea: **T9 COMPLETADA Y VERIFICADA** con descarga real de CSV y parseo.
  - **(2) CLAVE TRIBUTARIA (`--full`)**:
    - Resultado: `SUCCESS`, `rcvStatus: complete`.
    - Compras: estado `ok`, recuento 3 (`count: 3`).
    - Ventas: estado `EMPTY`, recuento 0 (`count: 0`) (el RUT tributario no registra ventas en febrero 2026, confirmado por el usuario y por el mensaje del portal `'No hay información de Ventas.'`).
    - Duracion: `elapsedMs: 8365`.
    - Guardas de seguridad: `blocked: false`, reserva de tiempo de enfriamiento de autenticacion confirmada.
    - Estado de tarea: **T8 COMPLETADA Y VERIFICADA** con descarga real de CSV y parseo.

- **Entrega y disponibilidad de servicios locales (T10)**:
  - Aplicacion local activa: Interfaz web en `http://127.0.0.1:5173`, API backend en puerto `3001` (`http://127.0.0.1:3001/api/health`).
  - Suite local automatizada: **317 pruebas pasando** en Vitest, `typecheck` (`tsc -b`) y `lint` (`eslint .`) limpios sin errores ni advertencias.

- **Defectos reales corregidos durante la validacion**:
  1. **Eventos de teclado en formulario de Clave Unica**: El formulario de Clave Unica requeria eventos de teclado explicitos (`keydown`, `keypress`, `keyup`, `input`, `change`) para procesar la entrada y habilitar el boton de envio.
  2. **Anotaciones TypeScript y helper `__name` inyectado por tsx/esbuild en `page.evaluate`**: La transpilacion en tiempo de ejecucion con `tsx`/`esbuild` inyectaba el helper auxiliar `__name` y anotaciones de tipos dentro del cuerpo serializado de funciones pasadas a `page.evaluate()`, causando fallos en el contexto del navegador (`EVALUATE_FAILED`). Se corrigio utilizando expresiones y funciones puras de JavaScript independientes del compilador.
  3. **Seleccion de periodo con valores planos**: Los selectores de periodo en la SPA de RCV requerian coincidir con valores planos (`'02'` para mes y `'2026'` para ano), descartando formatos o estructuras internas complejas de AngularJS.
  4. **Pestanas en singular COMPRA/VENTA con href `#compra/` y `#venta/`**: En el DOM real de `www4.sii.cl`, las pestanas principales se identifican en singular (`COMPRA` con `href="#compra/"` y `VENTA` con `href="#venta/"`), descartando nombres en plural.
  5. **Captura del CSV mediante anchor `data:text/csv` en vez de descarga de archivo**: El portal no genera un evento de descarga de archivo estandar del navegador, sino que crea e inyecta dinamicamente un elemento `<a>` con URI `data:text/csv` que se extrae y decodifica directamente en memoria.
  6. **Parser tolerante a filas con mas columnas que el encabezado (delimitador `;`)**: Los CSV devueltos por el SII utilizan punto y coma como delimitador y pueden emitir filas con columnas adicionales o separadores excedentes respecto a la cabecera; el parser fue configurado para tolerar columnas excedentes sin abortar ni desplazar registros validos.
  7. **Filtro de paneles basado en visibilidad real**: El portal reutiliza `id='pendiente'` en multiples paneles (incluyendo el panel visible del Registro principal); se aplico un filtro por visibilidad computada real (`offsetParent !== null` o estilos visibles) dentro del contenedor activo para evitar interactuar con paneles ocultos.
  8. **Reconocimiento del mensaje real 'No hay información de ...'**: En periodos sin movimientos, el portal despliega el mensaje explicito `'No hay información de Ventas.'` (o Compras); se incorporo su deteccion determinista para clasificar el estado como `empty` (count 0) en vez de error.

## Criterios de entrega

- Flujo completo con ambos modos, o limitaciones externas expresamente reportadas
  sin declarar completado el objetivo pendiente.
- Identidad y periodo comprobados, dos registros diferenciados y tablas fieles.
- Seguridad, pausas, bloqueo y limpieza verificados con pruebas locales.
- Typecheck, lint, tests y build aprobados; diferencias con el plan documentadas.
- Arrancar el servidor local al terminar, usar otro puerto si el previsto esta
  ocupado y entregar la URL. No iniciar un servidor mientras solo haya documentos.
- Actualizar estos documentos y mostrar las pruebas reales al usuario para su
  revision. No hacer commit ni crear ramas sin peticion expresa.