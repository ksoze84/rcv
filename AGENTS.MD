# Arquitectura de la aplicación
- Utilizar node.js como entorno de ejecución.
- Utilizar express como framework para construir el servidor web.
- Para la navegacion en la página web del SII, utilizar el paquete Stagehand.
- Utilizar openrouter para la IA de stagehand. Importante: Primero evaluar si es necesario utilizar IA, si asi fuera, evaluar tambien el modelo apropiado para el uso.
- Guardar token de autenticación IA en variables de entorno para mayor seguridad. 
- Utilizar vite como herramienta de construcción y desarrollo de la interfaz.
- Utilizar React como biblioteca para construir la interfaz de usuario.
- Utilizar Typescript para el desarrollo de la aplicación, con el fin de mejorar la calidad del código y reducir errores.
- Importante: usar principios Clean Code y Clean Architecture junto a principios KISS de forma equilibrada para alcanzar el óptimo en cuanto a código limpio, simple, modular y fácil de mantener.


# IMPORTANTE: Precauciones de uso automatizado de la página web del SII
- La página web del SII tiene un sistema de seguridad que puede detectar el uso automatizado de la página web. Por lo tanto, es importante que la aplicación utilice técnicas de navegación que simulen el comportamiento humano, como esperar tiempos aleatorios entre acciones, mover el mouse de manera natural, y evitar patrones de navegación repetitivos. Además, es recomendable utilizar un agente de usuario (user agent) que simule un navegador web real, y evitar el uso de proxies o VPNs que puedan ser detectados por el sistema de seguridad del SII. También es importante manejar los errores de manera adecuada, mostrando mensajes de error claros y concisos al usuario en caso de que ocurra algún problema durante el proceso de autenticación o navegación en la página web del SII.
- Siempre esperar 15 segundos entre cada intento de autenticación, para evitar bloqueos de la cuenta. En caso de que la cuenta sea bloqueada, mostrar un mensaje de error al usuario indicando que debe esperar 30 minutos antes de intentar nuevamente.


# Agentes y subagentes
Para evitar el uso de tokens excesivos, se recomienda utilizar subagentes para tareas complejas, dividiéndolas en subtareas más pequeñas y manejables, siempre que sea posible y conveniente.
- Para tareas de planificacion, razonamiento, toma de decisiones y diseño de arquitectura se recomienda utilizar el modelo Claude Opus 5 con esfuerzo Extra High o GPT 6 Astra con esfuerzo Extra High.
- Para tareas de coordinacion, diseño de componentes y diseño de la interfaz de usuario, se recomienda utilizar el modelo Claude Opus 5 con esfuerzo High o GPT 6 Astra con esfuerzo High.
- Para tareas de implementación de código, se recomienda utilizar el modelo Gemini 3.8 Flash con esfuerzo High o Extra High, dependiendo de la complejidad de la tarea. 
- Para tareas de pruebas y validación, se recomienda utilizar el modelo GPT 6 Astra con esfuerzo Medium o Claude Opus 5 con esfuerzo Medium.
- Cuando sea posible, generar subagentes en paralelo.
- Usar los modelos registrados bajo el proveedor universal-chat-provider.

# Planes y definiciones
- Siempre tener en cuenta los archivos en la carpeta docs, que contienen memorias, la investigación, arquitectura y plan de implementación de la aplicación. Actualizar estos documentos si es necesario.

## Datos adicionales
- Este ambiente corre sobre wsl (debian), tenlo en cuenta para los path y comandos.