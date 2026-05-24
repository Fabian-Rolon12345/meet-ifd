# 🎓 IFD Meet - Plataforma de Videoconferencias

**Instituto de Formación Docente · Santa Rosa, Misiones, Paraguay**

---

## ✅ Cambios y mejoras realizadas

### 1. 🎭 Sistema Docente / Estudiante
Después de iniciar sesión con Google, el usuario elige su rol:
- **Soy Docente** → pide la contraseña institucional → accede completo
- **Soy Estudiante** → ve advertencia: *"Solo los docentes pueden iniciar reuniones. Los invitados entran por el enlace."*

### 2. 🔒 Control de acceso diferenciado
- **Docentes:** pueden crear reuniones, ver el enlace de invitación, grabar, compartir pantalla, admitir/rechazar participantes
- **Estudiantes / Invitados:** solo pueden unirse por enlace, NO ven el enlace en la llamada, NO pueden iniciar reuniones

### 3. 🎥 Grabación mejorada - Carpeta "Grabación IFD"
- Usa la **File System Access API** del navegador para guardar directamente en el Escritorio
- Al grabar se abre un diálogo para elegir dónde guardar (recomendado: crear carpeta "Grabación IFD" en el Escritorio)
- Fallback automático: guarda en servidor + descarga local si el navegador no soporta la API

### 4. 📺 Layout tipo Google Meet
- Grilla automática que se adapta según la cantidad de participantes (1, 2, 3-4, 5-6, 7-9, 10-16)
- Modo **Spotlight**: clic en cualquier video para agrandarlo (aparece grande + tira lateral)
- Auto-spotlight cuando alguien comparte pantalla
- Badges: "Anfitrión", "Tú", "Compartiendo pantalla"
- Detector de voz (borde verde al hablar)

### 5. 🖥️ Compartir pantalla completo
- Botón en barra de controles
- Auto-spotlight al compartir pantalla (todos lo ven grande)
- Badge visual "Compartiendo pantalla"
- Notificación a todos los participantes

---

## 🚀 Instalación y uso

### Requisitos
- Node.js 18+
- npm

### Pasos

```bash
# 1. Entrar al directorio
cd meet-ifd

# 2. Instalar dependencias
npm install

# 3. Configurar variables de entorno
# Copiar .env.example a .env y completar:
cp .env.example .env

# 4. Iniciar el servidor
node server.js
# o para desarrollo con auto-reload:
npm run dev
```

### Variables de entorno (.env)

```env
GOOGLE_CLIENT_ID=tu_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=tu_client_secret
IFD_PASSWORD=TuContraseñaDocente
SESSION_SECRET=una_clave_secreta_larga
PORT=3000
NODE_ENV=development
APP_URL=http://localhost:3000
ADMIN_PASS=ifd2024
PLUGNMEET_URL=https://demo.plugnmeet.com
```

---

## 👨‍🏫 Flujo de uso

### Para Docentes:
1. Ir a IFD Meet → **Iniciar sesión con Google**
2. Elegir **"Soy Docente"** → ingresar contraseña institucional
3. Hacer clic en **"Nueva reunión"** → **"Iniciar reunión instantánea"**
4. Copiar el enlace del lobby y compartirlo con los estudiantes
5. Hacer clic en **"Iniciar reunión"**
6. Admitir estudiantes desde el panel de solicitudes

### Para Estudiantes / Invitados:
1. Recibir el enlace del docente
2. Pegar el enlace en el campo "Ingresar código o enlace" del inicio
   **o** abrir el enlace directamente
3. En la sala: ingresar su nombre y hacer clic en "Unirse a la reunión"
4. Esperar que el docente los admita

> ⚠️ Los estudiantes **NO** deben iniciar sesión con Google para unirse.
> Solo ponen su nombre y esperan admisión.

---

## 🎙️ Grabación

1. Hacer clic en el botón **⏺ Grabar** en la barra de controles
2. Seleccionar qué compartir (pantalla + audio recomendado)
3. Al detener la grabación:
   - Se abre un diálogo para **guardar en el Escritorio**
   - Crear una carpeta **"Grabación IFD"** y guardar ahí
   - Los archivos se guardan como `IFD-Clase-FECHA-HORA.webm`
4. También se guarda automáticamente en el servidor como respaldo

---

## 📋 Funcionalidades completas

| Función | Docente | Estudiante/Invitado |
|---------|---------|---------------------|
| Crear reunión | ✅ | ❌ |
| Ver enlace de invitación | ✅ | ❌ |
| Iniciar sesión Google | ✅ | ❌ (no necesario) |
| Unirse por enlace | ✅ | ✅ |
| Video y audio | ✅ | ✅ |
| Chat | ✅ | ✅ |
| Compartir archivos | ✅ | ✅ |
| Compartir pantalla | ✅ | ✅ |
| Grabar clase | ✅ | ✅ |
| Admitir/rechazar | ✅ | ❌ |
| Expulsar participantes | ✅ | ❌ |
| Silenciar participantes | ✅ | ❌ |
| Crear encuestas | ✅ | ❌ |
| Salas de grupos | ✅ | ✅ |
| Levantar la mano | ✅ | ✅ |
| Subtítulos | ✅ | ✅ |
| Reacciones con emoji | ✅ | ✅ |

---

## 🔧 Configuración Google OAuth

1. Ir a [Google Cloud Console](https://console.cloud.google.com)
2. Crear un proyecto nuevo
3. Activar **Google+ API** u **OAuth Consent Screen**
4. Crear credenciales OAuth 2.0 → Web Application
5. Agregar URI de redirección: `http://localhost:3000/auth/google/callback`
6. Copiar Client ID y Client Secret al `.env`
