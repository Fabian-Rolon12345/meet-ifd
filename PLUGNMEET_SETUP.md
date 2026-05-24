# 🎥 PlugNMeet — Integración con IFD Meet

## ¿Qué se agregó?

PlugNMeet ahora está **integrado** en tu sistema IFD Meet:

- ✅ Botón **"Iniciar con PlugNMeet"** en el lobby (antes de entrar a la sala)
- ✅ Botón **"PlugNMeet"** en la barra de controles (dentro de la sala)
- ✅ En desktop → abre **iframe integrado** (sin salir de IFD Meet)
- ✅ En móvil → abre **nueva pestaña** (mejor compatibilidad)
- ✅ Notifica a todos en el chat cuando alguien abre PlugNMeet
- ✅ La sala de PlugNMeet usa el **mismo ID** que tu sala IFD

---

## ⚙️ Configuración en `.env`

Agregá esta línea a tu `.env`:

```env
# Opción A — Servidor público (para probar, sin instalar nada)
PLUGNMEET_URL=https://demo.plugnmeet.com

# Opción B — Tu propio PlugNMeet en Render (recomendado)
PLUGNMEET_URL=https://tu-plugnmeet.onrender.com

# Opción C — PlugNMeet local
PLUGNMEET_URL=http://localhost:3001
```

---

## 🚀 Opción A: Usar el servidor público de PlugNMeet (YA FUNCIONA)

No necesitás instalar nada. Solo usá:

```env
PLUGNMEET_URL=https://demo.plugnmeet.com
```

✅ **Ventajas:** funciona inmediatamente  
⚠️ **Desventajas:** es un servidor compartido, no es tuyo

---

## 🏠 Opción B: Tu propio PlugNMeet en Render (RECOMENDADO)

### Paso 1 — Fork de PlugNMeet
Ve a: https://github.com/miroslavpejic85/plugnmeet  
Hacé fork a tu cuenta GitHub.

### Paso 2 — Deploy en Render
1. Entrá a https://render.com
2. New → Web Service
3. Conectá tu fork de PlugNMeet
4. Configuración:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free

### Paso 3 — Variables de entorno en PlugNMeet (Render)
```
NODE_ENV=production
PORT=3000
```

### Paso 4 — Actualizar tu IFD Meet
```env
PLUGNMEET_URL=https://tu-plugnmeet-xxxx.onrender.com
```

---

## 🔄 Cómo funciona la integración

```
Usuario en IFD Meet
        ↓
   Clic en "🎥 PlugNMeet"
        ↓
   Modal de confirmación
        ↓
   Desktop → Iframe integrado (dentro de IFD Meet)
   Móvil   → Nueva pestaña
        ↓
   Sala PlugNMeet: IFD-{ROOM_ID_primeros_12_chars}
        ↓
   Chat de IFD notifica: "Usuario abrió PlugNMeet → Sala: IFD-XXXX"
```

La sala PlugNMeet siempre corresponde al mismo ID de tu sala IFD, 
así todos entran a la misma videollamada automáticamente.

---

## 📋 Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `views/room.ejs` | Botones PlugNMeet, modales, estilos, JS |
| `server.js` | Variable `PLUGNMEET_URL`, log en inicio |
| `.env.example` | Documentación de `PLUGNMEET_URL` |
| `PLUGNMEET_SETUP.md` | Este archivo (nuevo) |

---

## ❓ Preguntas frecuentes

**¿El chat y archivos siguen funcionando?**  
Sí, 100%. PlugNMeet es solo el video. Todo lo demás es tu sistema.

**¿Los usuarios necesitan cuenta en PlugNMeet?**  
No. Entran directamente con el link/iframe.

**¿Funciona sin Google OAuth?**  
Sí, PlugNMeet funciona aunque el usuario no esté logueado en IFD.

**¿Puedo quitar el video integrado (PeerJS) y solo usar PlugNMeet?**  
Sí, pero no es necesario. Ambos pueden coexistir. Los usuarios eligen.
