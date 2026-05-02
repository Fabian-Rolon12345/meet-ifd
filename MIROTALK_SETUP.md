# 🎥 MiroTalk — Integración con IFD Meet

## ¿Qué se agregó?

MiroTalk ahora está **integrado** en tu sistema IFD Meet:

- ✅ Botón **"Iniciar con MiroTalk"** en el lobby (antes de entrar a la sala)
- ✅ Botón **"MiroTalk"** en la barra de controles (dentro de la sala)
- ✅ En desktop → abre **iframe integrado** (sin salir de IFD Meet)
- ✅ En móvil → abre **nueva pestaña** (mejor compatibilidad)
- ✅ Notifica a todos en el chat cuando alguien abre MiroTalk
- ✅ La sala de MiroTalk usa el **mismo ID** que tu sala IFD

---

## ⚙️ Configuración en `.env`

Agregá esta línea a tu `.env`:

```env
# Opción A — Servidor público (para probar, sin instalar nada)
MIROTALK_URL=https://p2p.mirotalk.com

# Opción B — Tu propio MiroTalk en Render (recomendado)
MIROTALK_URL=https://tu-mirotalk.onrender.com

# Opción C — MiroTalk local
MIROTALK_URL=http://localhost:3001
```

---

## 🚀 Opción A: Usar el servidor público de MiroTalk (YA FUNCIONA)

No necesitás instalar nada. Solo usá:

```env
MIROTALK_URL=https://p2p.mirotalk.com
```

✅ **Ventajas:** funciona inmediatamente  
⚠️ **Desventajas:** es un servidor compartido, no es tuyo

---

## 🏠 Opción B: Tu propio MiroTalk en Render (RECOMENDADO)

### Paso 1 — Fork de MiroTalk
Ve a: https://github.com/miroslavpejic85/mirotalk  
Hacé fork a tu cuenta GitHub.

### Paso 2 — Deploy en Render
1. Entrá a https://render.com
2. New → Web Service
3. Conectá tu fork de MiroTalk
4. Configuración:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free

### Paso 3 — Variables de entorno en MiroTalk (Render)
```
NODE_ENV=production
PORT=3000
```

### Paso 4 — Actualizar tu IFD Meet
```env
MIROTALK_URL=https://tu-mirotalk-xxxx.onrender.com
```

---

## 🔄 Cómo funciona la integración

```
Usuario en IFD Meet
        ↓
   Clic en "🎥 MiroTalk"
        ↓
   Modal de confirmación
        ↓
   Desktop → Iframe integrado (dentro de IFD Meet)
   Móvil   → Nueva pestaña
        ↓
   Sala MiroTalk: IFD-{ROOM_ID_primeros_12_chars}
        ↓
   Chat de IFD notifica: "Usuario abrió MiroTalk → Sala: IFD-XXXX"
```

La sala MiroTalk siempre corresponde al mismo ID de tu sala IFD, 
así todos entran a la misma videollamada automáticamente.

---

## 📋 Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `views/room.ejs` | Botones MiroTalk, modales, estilos, JS |
| `server.js` | Variable `MIROTALK_URL`, log en inicio |
| `.env.example` | Documentación de `MIROTALK_URL` |
| `MIROTALK_SETUP.md` | Este archivo (nuevo) |

---

## ❓ Preguntas frecuentes

**¿El chat y archivos siguen funcionando?**  
Sí, 100%. MiroTalk es solo el video. Todo lo demás es tu sistema.

**¿Los usuarios necesitan cuenta en MiroTalk?**  
No. Entran directamente con el link/iframe.

**¿Funciona sin Google OAuth?**  
Sí, MiroTalk funciona aunque el usuario no esté logueado en IFD.

**¿Puedo quitar el video integrado (PeerJS) y solo usar MiroTalk?**  
Sí, pero no es necesario. Ambos pueden coexistir. Los usuarios eligen.
