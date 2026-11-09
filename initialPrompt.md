# Prompt inicial para generar app: Obtener registro de compras y ventas (RCV) #

## Contexto

El objetivo de esta aplicación es obtener el registro de compras y ventas (RCV) correspondiente al rut logueado desde la url https://sii.cl . La aplicación debe ser capaz de navegar por la página web, localizar el documento Excel y descargarlo automáticamente. La aplicación debe manejar el proceso de autenticación de manera segura y eficiente, solicitando al usuario sus credenciales.

## Arquitectura de la aplicación
- Utilizar node.js como entorno de ejecución.
- Utilizar express como framework para construir el servidor web.
- Para la navegacion en la página web del SII, utilizar el paquete Stagehand.
- Utilizar openrouter para la IA de stagehand. Importante: Primero evaluar si es necesario utilizar IA, si asi fuera, evaluar tambien el modelo apropiado para el uso.
- Guardar token de autenticación IA en variables de entorno para mayor seguridad. 
- Utilizar vite como herramienta de construcción y desarrollo de la interfaz.
- Utilizar React como biblioteca para construir la interfaz de usuario.
- Utilizar Typescript para el desarrollo de la aplicación, con el fin de mejorar la calidad del código y reducir errores.
- Importante: usar principios Clean Code y Clean Architecture junto a principios KISS de forma equilibrada para alcanzar el óptimo en cuanto a código limpio, simple, modular y fácil de mantener.

## Requisitos funcionales
- Esta app debe tener una interfaz en extremo simple. Un formulario con el usuario y contraseña, modo de autenticacion (clave unica o tributaria, radio input) y solamente un boton para obtener el registro. Al presionar el botón, la aplicación debe iniciar el proceso de autenticación a través de clave única o tributaria, y una vez autenticado, debe navegar por la página web del SII para localizar y obtener los registros de compra y venta mostrando el detalle de cada uno en una tabla.

## Datos adicionales
- El archivo .env ya está creado y configurado con el usuarios y contraseñas de prueba y token de autenticación , revisar. 
- En la página del SII, el documento Excel se encuentra en la sección de "Trámites en linea" (menu izquierdo), luego en "Factura electrónica". Esperar carga y hacer click en "Registro de compras y venta". Esperar carga y hacer click en "Ingresar al Registro de Compras y Ventas", OPcionalmente puedes entrar directamente a la url https://www4.sii.cl/consdcvinternetui/#/index
- Este ambiente corre sobre wsl (debian), tenlo en cuenta para los path y comandos.
- Revisa el proyecto en la carpeta ../ImpuestoHerenciasSii que podria servir como referencia para la implementación de esta app. Esta app manejo bien la navegación y temas de conexion, como el dns, pero no logró autentificarse correctamente.

### Flujo de la navegación en SII
1. Ingresar a la url https://sii.cl
2. Si el usuario ya está autenticado, continuar al paso 4.
3. Si el usuario seleccionó clave tributaria, ingresar usuario y contraseña, luego hacer click en "INGRESAR". Si el usuario seleccionó clave única, hacer click en "Iniciar sesion", esto lleva a una navegacion al portal de clave unica, luego ingresar usuario y contraseña, y hacer click en "INGRESA".
4. Una vez autenticado, navegar a https://www4.sii.cl/consdcvinternetui/#/index.
5. Esperar carga y seleccionar el periodo Febrero de 2026.
6. Esperar carga. Seleccionar pestaña Compras, luego en el botón descargar detalles, lo cual entrega un archivo csv con del detalle de las compras.
7. Hacer click en la pestaña Ventas, luego en el botón descargar detalles, lo cual entrega un archivo csv con del detalle de las ventas.
8. Con los archivos csv descargados, la aplicación debe procesarlos y mostrar el detalle de cada uno en una tabla en la interfaz de usuario.

### IMPORTANTE: Precauciones de uso automatizado de la página web del SII
- La página web del SII tiene un sistema de seguridad que puede detectar el uso automatizado de la página web. Por lo tanto, es importante que la aplicación utilice técnicas de navegación que simulen el comportamiento humano, como esperar tiempos aleatorios entre acciones, mover el mouse de manera natural, y evitar patrones de navegación repetitivos. Además, es recomendable utilizar un agente de usuario (user agent) que simule un navegador web real, y evitar el uso de proxies o VPNs que puedan ser detectados por el sistema de seguridad del SII. También es importante manejar los errores de manera adecuada, mostrando mensajes de error claros y concisos al usuario en caso de que ocurra algún problema durante el proceso de autenticación o navegación en la página web del SII.
- Siempre esperar 15 segundos entre cada intento de autenticación, para evitar bloqueos de la cuenta. En caso de que la cuenta sea bloqueada, mostrar un mensaje de error al usuario indicando que debe esperar 30 minutos antes de intentar nuevamente.

## Pasos para la implementación
1. Primero planificar el proyecto, definiendo la arquitectura, los componentes y las dependencias necesarias. Planificar también la estructura de carpetas y archivos del proyecto. Definir las tareas a realizar y los pasos de implementación. Realizar cualquier pregunta necesaria para aclarar dudas antes de comenzar la implementación. 
2. Guardar el plan en forma de archivos .md y prompts md en la carpeta docs del proyecto.
3. IMPORTANTE: Mostrar el resumen del plan de implementación al usuario para su revisión y aprobación antes de comenzar la implementación. Realizar las modificaciones necesarias según los comentarios del usuario. IMPORTANTE: Este paso debe realizarse si o si, aunque este en modo piloto automático y aunque el agente tenga los permisos más altos.
4. Una vez aprobado el plan, comenzar la implementación del proyecto siguiendo los pasos definidos en el plan. Implementar cada componente de manera modular. Para tareas complejas, dividirlas en subtareas más pequeñas y manejables. Importante: Las tareas mas pequeñas y manejables deben ser implementadas usando subagentes con el modelo Gemini 3.8 Flash en High o Extra high.
5. Ejecutar al menos una prueba simple para cada tipo de autenticacion (clave única y clave tributaria) para verificar que la aplicación funciona correctamente y puede obtener el registro de compras y ventas (RCV) desde la página web del SII. Mostrar los resultados de las pruebas al usuario para su revisión y aprobación.