# 🎬 VIDEOCOMICS Cloud Renderer

Repositorio satélite público dedicado exclusivamente al **renderizado distribuido y gratuito en la nube** de proyectos **VIDEOCOMICS**.

Al ser un repositorio público, el renderizado con **GitHub Actions es 100% gratuito e ilimitado** (no consume la cuota mensual de 2.000 minutos de repositorios privados).

---

## ⚡ ¿Cómo funciona?

1. **Subir archivos a la cola:**
   - Ve a la pestaña **[Releases](https://github.com/enyosim/videocomics-cloud/releases)**.
   - Abre el Release **`cola-render`**.
   - Haz clic en *Edit release* y sube uno o varios archivos `.videocomics`. Guarda los cambios.
2. **Iniciar renderizado cuando estés listo:**
   - Ve a la pestaña **[Actions](https://github.com/enyosim/videocomics-cloud/actions)**.
   - Selecciona **Renderizar Vídeo (VIDEOCOMICS Cloud)** y pulsa el botón **Run workflow**.
   - El motor procesará automáticamente todos los archivos en la cola uno tras otro, dividiendo cada uno en **6 a 8 servidores paralelos** con WebCodecs.
   - Ensambla el MP4 final a 1080p sin recodificar en cuestión de segundos.
3. **Descarga del vídeo:**
   - Los vídeos terminados se publican directamente en el Release **`videos-listos`**.
   - Cada archivo `.videocomics` procesado se retira de la cola automáticamente.
   - Si subiste varios archivos a la vez, el sistema procesará uno tras otro en orden continuo hasta vaciar la cola.

---

## 🚀 Arquitectura

- **Preparación:** Analiza los frames, extrae el audio a 48 kHz y genera la intro con FFmpeg.
- **Renderizado paralelo:** 6 servidores de GitHub Actions renderizan en simultáneo con WebCodecs H.264.
- **Ensamblado:** FFmpeg concatena todos los fragmentos y el audio con `-c copy` instantáneamente.
