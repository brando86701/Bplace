# Guardado del lienzo

Ejecutar `npm ci` y `npm start`; abrir http://localhost:3002.

Los cambios locales de pincel, borrador, figuras y relleno programan una subida
del lienzo a Supabase Storage tras un segundo. Realtime distribuye los trazos,
pero el guardado ya no depende de que un servidor escuche esos mensajes.
La barra muestra cambios pendientes, guardando, guardado o error con reintento.
Esperar a «Guardado» antes de cerrar. Un error HTTP o de red conserva los cambios
pendientes y reintenta; dibujar durante una subida programa otra posterior.
Las subidas de calcados y limpieza usan la misma cola para evitar que se solapen.

Validación: `npm test`. La prueba `tests/browser-persistence.cjs` necesita
Playwright y Chrome (o `BPLACE_BROWSER=msedge`); intercepta las peticiones a
Supabase para probar clic, subida y recarga sin pintar el lienzo de producción.
También se verificó escritura, lectura y borrado de un archivo temporal con
la clave pública del proyecto real.

Se mantiene el formato existente: una instantánea completa de 9 MB por subida.
Entre dispositivos independientes, las subidas simultáneas todavía pueden
sobrescribirse; resolver esos conflictos requiere persistencia de cambios
por píxel o por bloques en la base de datos. IndexedDB es un respaldo local,
no una confirmación de guardado en la nube.

Los cambios están en la copia local. Vercel requiere publicar los cambios en
la rama de GitHub conectada a su despliegue para incorporar esta corrección.
