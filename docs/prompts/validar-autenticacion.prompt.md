---
description: "Validar un mecanismo de autenticacion y sus dos registros RCV de febrero de 2026."
agent: "agent"
argument-hint: "Modo tributaria o clave-unica, aprobacion registrada y servidor local preparado."
---

# Prueba real de un mecanismo RCV

Lee [plan y protocolo](../03-plan-implementacion.md),
[arquitectura](../02-arquitectura.md) e [instrucciones](../../AGENTS.MD).
Este prompt lo ejecuta el coordinador, nunca un subagente concurrente.

## Condiciones previas

- Aprobacion explicita del plan y de cualquier desviacion de modelo/esfuerzo.
- Implementacion integrada y pruebas locales, typecheck, lint y build aprobados.
- Un solo modo seleccionado: `tributaria` o `clave-unica`. El periodo siempre
  es febrero de 2026 (`2026-02`), para Compras y Ventas.
- Variables del modo presentes, navegador local listo, limitador compartido
  disponible y sin bloqueo vigente. Ninguna otra autenticacion en paralelo.
- Si falta una condicion, informa NO EJECUTADA y el motivo. No simules exito.

## Procedimiento

1. Carga los secretos dentro del proceso de prueba, sin imprimirlos, incluirlos
   en comandos/argumentos, pasarlos por chat ni copiarlos a prompts.
2. Usa el mismo servicio y limitador que la app. Respeta al menos 15 segundos
   entre envios incluso al cambiar de modo; nunca evites la guarda con otro script.
3. Ejecuta una sola autenticacion del modo indicado en contexto limpio. Si hay
   rechazo, resultado ambiguo, desafio o bloqueo, detente y reporta evidencia
   no sensible. No reintentes hasta revision y autorizacion del usuario.
4. Un bloqueo suspende todos los intentos por al menos 30 minutos, o mas si lo
   exige el portal. No intentes resolver CAPTCHA/MFA ni otros controles por codigo.
5. Verifica RUT autenticado y contribuyente activo sin incluirlos en el reporte.
   No confies solo en URL, HTTP 200 o desaparicion del formulario.
6. Selecciona y comprueba febrero de 2026 antes de cada captura. Descarga Compras
   y Ventas por separado, valida ambos CSV y su representacion en las tablas.
   Si hay cero movimientos, confirma ese estado y no lo presentes como fallo ni
   como evidencia de una descarga con datos. No cambies de periodo para obtener filas.
7. Cierra recursos y elimina los archivos/perfil temporales incluso ante fallos.
   No registres CSV, capturas privadas, DOM, cookies ni URLs con tokens.

## Reporte

Informa modo, fecha, estado de autenticacion, periodo confirmado, estado y numero
de filas por registro, duracion y limpieza. Usa PASO, FALLO, BLOQUEADA o
NO EJECUTADA segun evidencia. Distingue sin movimientos de descarga con datos.
Solicita revision del resultado. No declares comprobado el otro modo: requiere
su propia ejecucion secuencial del protocolo.