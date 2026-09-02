# 🎨 BPlace — Lienzo Colaborativo de Pixel Art en Tiempo Real

<p align="center">
  <img src="https://raw.githubusercontent.com/brando86701/Bplace/main/public/favicon.ico" alt="BPlace Logo" width="80" height="80" onerror="this.style.display='none'"/>
</p>

<p align="center">
  <b>Un estudio colaborativo y lienzo masivo de Pixel Art (3000 × 3000 px) en tiempo real, inspirado en r/place y wplace.live.</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-v18+-68a063?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js"/>
  <img src="https://img.shields.io/badge/WebSockets-Realtime-0288d1?style=for-the-badge&logo=websocket&logoColor=white" alt="WebSockets"/>
  <img src="https://img.shields.io/badge/HTML5-Canvas%202D-e34f26?style=for-the-badge&logo=html5&logoColor=white" alt="HTML5 Canvas"/>
  <img src="https://img.shields.io/badge/CSS3-Glassmorphism-264de4?style=for-the-badge&logo=css3&logoColor=white" alt="CSS3"/>
</p>

---

## ✨ Características Principales

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
  - Filtro por color específico de plantilla.
  - Estampado automático con un solo clic.
- 💾 **Doble Persistencia:**
  - **Servidor:** Guardado binario atómico y ultra liviano en disco (`data/canvas.bin`).
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

### Pasos

1. **Clonar el repositorio:**
   ```bash
   git clone https://github.com/brando86701/Bplace.git
   cd Bplace
   ```

2. **Instalar dependencias:**
   ```bash
   npm install
   ```

3. **Iniciar el servidor:**
   - **En Windows:** Haz doble clic en el archivo `iniciar_servidor.bat` o ejecuta:
     ```bash
     npm start
     ```
   - **En Linux / macOS:**
     ```bash
     node server.js
     ```

4. **Abrir en el navegador:**
   - **En la misma PC:** [http://localhost:3002](http://localhost:3002)
   - **En tu red local (móvil u otra PC):** Abre `http://<IP-DE-TU-PC>:3002` (el servidor mostrará la IP en la consola al iniciar).

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
├── public/                  # Frontend estático
│   ├── index.html           # Estructura principal y UI flotante
│   ├── style.css            # Estilos Glassmorphism, temas y responsive
│   └── app.js               # Motor Canvas 2D, WebSockets y controladores táctiles
├── data/                    # Almacenamiento persistente del servidor
│   ├── canvas.bin           # Datos binarios del lienzo (9 MB)
│   ├── templates.json       # Plantillas sincronizadas
│   └── users.json           # Usuarios y roles (admin/user)
├── server.js                # Servidor Express + WebSocket Server
├── iniciar_servidor.bat     # Lanzador rápido para Windows
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
