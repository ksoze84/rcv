---
description: "Implementar una tarea acotada del plan RCV aprobado para febrero de 2026."
agent: "agent"
model: "Gemini 3.8 Flash (copilot)"
argument-hint: "ID T1-T7, archivos autorizados, contrato y criterio de aceptacion."
---

# Implementar una tarea RCV

Lee [instrucciones](../../AGENTS.MD), [investigacion](../01-investigacion.md),
[arquitectura](../02-arquitectura.md) y [plan](../03-plan-implementacion.md).

## Condiciones previas

- El coordinador debe aportar aprobacion explicita del usuario, una tarea T1-T7,
  archivos bajo tu responsabilidad, contratos acordados y una prueba de aceptacion.
- Sin aprobacion, devuelve el bloqueo y no implementes. No interpretes una
  correccion de periodo como aprobacion del proyecto.
- Modelo requerido: Gemini 3.8 Flash. El usuario autorizo cualquier nivel de
   esfuerzo el 2026-09-29. Si el modelo no esta disponible, reportalo antes
   de implementar; no sustituyas silenciosamente ni afirmes un ajuste no verificable.

## Ejecucion

1. Trabaja exclusivamente en la tarea y archivos asignados. No edites otros
   modulos, secretos, instrucciones ni archivos del proyecto hermano.
2. Formula una hipotesis local comprobable y el chequeo mas pequeno que pueda
   refutarla. Realiza un cambio acotado y ejecuta ese chequeo inmediatamente.
3. Usa Node, Express, React/Vite, TypeScript estricto y Stagehand v4 conforme al
   contrato de la tarea. No copies APIs de Stagehand v3 o Playwright sin verificar
   los tipos reales. Conserva el periodo febrero de 2026 (`2026-02`).
4. Aplica KISS y los limites de responsabilidad definidos, sin crear archivos
   vacios ni abstracciones genericas. Preserva modificaciones ajenas.
5. Usa datos sinteticos. No leas valores del archivo de secretos, no registres
   datos privados, no ejecutes login real ni gastes tokens de OpenRouter.
6. Respeta las dos autenticaciones, sesion verificada, capturas independientes,
   intervalo de 15 segundos y bloqueo de 30 minutos cuando correspondan a la tarea.
7. No conviertas selectores no inspeccionados en hechos ni etiquetes un mock como
   prueba del SII. Reporta lo que requiera una sesion real al coordinador.
8. Ejecuta tests del modulo y typecheck/lint aplicables. No crees commits, ramas
   o subagentes adicionales. No inicies servidores ni logins de manera paralela.

## Resultado requerido

Devuelve archivos cambiados, comportamiento implementado, comando y resultado
de cada comprobacion, cambios de contrato y bloqueos concretos. Distingue tests
sinteticos de verificaciones reales. Nunca incluyas credenciales o datos fiscales.