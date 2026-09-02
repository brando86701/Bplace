# 🎨 BPlace — Lienzo Colaborativo de Pixel Art en Tiempo Real

<p align="center">
  <img src="https://raw.githubusercontent.com/brando86701/Bplace/main/public/favicon.ico" alt="BPlace Logo" width="80" height="80" onerror="this.style.display='none'"/>
</p>

<p align="center">
  <b>Un estudio colaborativo y lienzo masivo de Pixel Art (3000 × 3000 px) en tiempo real con sincronización global en la nube (Supabase), inspirado en r/place y wplace.live.</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Supabase-Cloud%20Database-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white" alt="Supabase"/>
  <img src="https://img.shields.io/badge/PostgreSQL-17.6-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL"/>
  <img src="https://img.shields.io/badge/Node.js-v18+-68a063?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js"/>
  <img src="https://img.shields.io/badge/WebSockets-Realtime-0288d1?style=for-the-badge&logo=websocket&logoColor=white" alt="WebSockets"/>
  <img src="https://img.shields.io/badge/Vercel-Ready-000000?style=for-the-badge&logo=vercel&logoColor=white" alt="Vercel"/>
  <img src="https://img.shields.io/badge/HTML5-Canvas%202D-e34f26?style=for-the-badge&logo=html5&logoColor=white" alt="HTML5 Canvas"/>
</p>

---

## ✨ Características Principales

- ☁️ **Sincronización Global en la Nube con Supabase:**
  - **Supabase Storage (CDN):** Almacenamiento y descarga en CDN del lienzo de 9 MB para carga ultra veloz.
  - **Supabase PostgreSQL:** Tablas en la nube para usuarios (`public.users`) y plantillas (`public.templates`).
  - **Sincronización multi-dispositivo:** Cualquier cambio realizado en tu PC, móvil o despliegue en la nube se sincroniza automáticamente con la base de datos de Supabase.
- 🌐 **Sincronización en Tiempo Real:** Todos los usuarios conectados pintan y ven los cambios de forma instantánea mediante WebSockets (`ws`) de baja latencia con procesamiento en lotes (*batching*).
- 🖼️ **Lienzo Masivo de 3000 × 3000 px (9 Megapíxeles):** Renderizado acelerado por GPU con búfers `Uint32Array` para una tasa de 60/120 FPS sin caídas de rendimiento.
- 🎨 **Paleta Extendida de 64 Colores:** Colores organizados por tonos cálidos, fríos, neutros y tonos de piel, con selector de color hexadecimal y guardado de favoritos.
- 📱 **Soporte Táctil Completo (Móvil / Tablet):**
  - Desplazamiento y zoom fluido con pellizco (*pinch-to-zoom*).
  - Bloqueo de lienzo para pintar con precisión en pantallas táctiles.
  - Interfaz adaptable y responsive estilo Glassmorphism flotante.
- 🖼️ **Plantillas de Referencia Inteligentes:**
  - Carga imágenes PNG/JPG/GIF y colócalas en cualquier coordenada del lienzo.
  - Modo Guía de Punto (*Cross-Stitch Dots*) para replicar arte píxel por píxel con facilidad.
  - Filtro por color específico de plantilla y estampado automático con un solo clic.
- 💾 **Persistencia Híbrida (Nube + Local + IndexedDB):**
  - **Nube:** Supabase Storage y PostgreSQL con subida asíncrona no bloqueante.
  - **Servidor:** Respaldo binario atómico en disco (`data/canvas.bin`).
  - **Cliente:** Respaldo y caché local instantáneo en **IndexedDB**.
- 🛠️ **Suite de Herramientas de Dibujo:**
  - 🖌️ Pincel continuo (con grosor ajustable)
  - 🧹 Borrador
  - 💧 Cuentagotas / Gotero inteligente (muestrea tanto el lienzo como las plantillas)
  - 📏 Líneas rectas (Algoritmo de Bresenham)
  - ⬛ Rectángulos (Rellenos o huecos)
  - ⭕ Círculos / Elipses
  - 🪣 Bote de pintura (Flood Fill)
- 🌓 **Temas:** Modo Oscuro y Modo Claro con diseño flotante translúcido.
- 📤 **Exportador PNG en Alta Resolución:** Descarga el lienzo completo a escala 1×, 2×, 4× u 8× (hasta 24,000 × 24,000 px).

---

## 🚀 Instalación y Puesta en Marcha

### Prerrequisitos
- [Node.js](https://nodejs.org/) (Versión 18 o superior recomendada)
- Proyecto en [Supabase](https://supabase.com/) *(ya configurado y conectado)*

### 1. Ejecución Local

1. **Clonar el repositorio:**
   ```bash
   git clone https://github.com/brando86701/Bplace.git
   cd Bplace
   ```

2. **Instalar dependencias:**
   ```bash
   npm install
   ```

3. **Configurar variables de entorno (opcional):**
   Copia el archivo `.env.example` a `.env` con las credenciales de tu proyecto de Supabase.

4. **Iniciar el servidor:**
   - **En Windows:** Haz doble clic en el archivo `iniciar_servidor.bat` o ejecuta:
     ```bash
     npm start
     ```
   - **En Linux / macOS:**
     ```bash
     node server.js
     ```

5. **Abrir en el navegador:**
   - **En la misma PC:** [http://localhost:3002](http://localhost:3002)
   - **En tu red local (móvil u otra PC):** Abre `http://<IP-DE-TU-PC>:3002` (el servidor mostrará la IP en la consola al iniciar).

---

### 2. Despliegue en Vercel

Este repositorio incluye la configuración de `vercel.json` lista para desplegarse:

1. Importa el repositorio `brando86701/Bplace` en [Vercel](https://vercel.com/).
2. Añade las variables de entorno en Vercel:
   - `SUPABASE_URL`: `https://jtwbuempcdjrbqfgvaar.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY`: *(Tu clave secreta de Supabase)*
3. Haz clic en **Deploy**. ¡Listo!

---

## ⌨️ Atajos de Teclado

| Tecla | Acción |
| :--- | :--- |
| <kbd>B</kbd> | Activar Pincel (*Brush*) |
| <kbd>E</kbd> | Activar Borrador (*Eraser*) |
| <kbd>I</kbd> | Gotero / Muestreador (*Eyedropper*) |
| <kbd>L</kbd> | Herramienta Línea |
| <kbd>R</kbd> | Herramienta Rectángulo |
| <kbd>C</kbd> | Herramienta Círculo |
| <kbd>X</kbd> | Intercambiar color primario / secundario |
| <kbd>F</kbd> | Ajustar vista completa del lienzo (*Fit*) |
| <kbd>+</kbd> / <kbd>-</kbd> | Zoom In / Zoom Out |
| <kbd>[</kbd> / <kbd>]</kbd> | Disminuir / Aumentar tamaño del pincel |
| <kbd>Espacio</kbd> | Mantener para pintar trazos continuos |
| <kbd>Esc</kbd> | Salir del modo pintura a modo navegación |

---

## 📂 Estructura del Proyecto

```
Bplace/
├── public/                  # Frontend estático de alto rendimiento
│   ├── index.html           # Estructura principal y UI flotante
│   ├── style.css            # Estilos Glassmorphism, temas y responsive
│   └── app.js               # Motor Canvas 2D, WebSockets y controladores táctiles
├── data/                    # Respaldo y caché local del servidor
│   ├── canvas.bin           # Datos binarios del lienzo (9 MB)
│   ├── templates.json       # Plantillas sincronizadas
│   └── users.json           # Usuarios y roles
├── server.js                # Servidor Express + WebSockets + Sync con Supabase
├── iniciar_servidor.bat     # Lanzador rápido para Windows
├── vercel.json              # Configuración para despliegue en Vercel
├── .env.example             # Plantilla de variables de entorno
├── package.json             # Manifiesto de dependencias y scripts
└── README.md                # Documentación del proyecto
```

---

## 🛡️ Seguridad y Administración

El servidor incluye un usuario administrador por defecto:
- **Usuario:** `admin`
- **Contraseña:** `admin123`

Los administradores pueden gestionar usuarios y realizar guardados manuales o limpiezas del lienzo desde la API protegida.

---

## 📄 Licencia

Este proyecto es de código abierto bajo la licencia MIT. ¡Siéntete libre de utilizarlo, modificarlo y colaborar!
