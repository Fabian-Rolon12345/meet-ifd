/**
 * =====================================================
 * IFD MEET - MÓDULO DE GRABACIÓN
 * Graba audio + video de la reunión y lo guarda como
 * WebM en la carpeta public/recordings/ del servidor
 * =====================================================
 *
 * CÓMO INTEGRAR EN room.ejs:
 * 1. Incluí este script: <script src="/js/recorder.js"></script>
 * 2. Asegurate de que el botón de grabación tenga id="btnRecord"
 * 3. Asegurate de tener un elemento con id="recordingIndicator"
 * 4. Pasale la variable `socket` y `localStream` al inicializar
 */

class IFDRecorder {
    constructor(options = {}) {
      this.socket = options.socket || null;
      this.roomId = options.roomId || '';
      this.userName = options.userName || 'Usuario';
  
      this.mediaRecorder = null;
      this.recordedChunks = [];
      this.isRecording = false;
      this.startTime = null;
      this.timerInterval = null;
  
      // Elementos UI
      this.btnRecord = document.getElementById('btnRecord');
      this.recordingIndicator = document.getElementById('recordingIndicator');
      this.recordingTimer = document.getElementById('recordingTimer');
      this.recordingStatus = document.getElementById('recordingStatus');
  
      this._bindEvents();
    }
  
    _bindEvents() {
      if (this.btnRecord) {
        this.btnRecord.addEventListener('click', () => this.toggleRecording());
      }
    }
  
    async toggleRecording() {
      if (this.isRecording) {
        this.stopRecording();
      } else {
        await this.startRecording();
      }
    }
  
    async startRecording() {
      try {
        // Capturar pantalla + audio del sistema + micrófono
        let displayStream;
        try {
          displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              mediaSource: 'screen',
              width: { ideal: 1920 },
              height: { ideal: 1080 },
              frameRate: { ideal: 30 }
            },
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              sampleRate: 44100
            }
          });
        } catch (err) {
          console.warn('No se pudo capturar pantalla, grabando solo audio:', err);
        }
  
        // Micrófono del usuario
        let micStream;
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch (err) {
          console.warn('No se pudo acceder al micrófono:', err);
        }
  
        // Combinar streams con AudioContext
        const audioContext = new AudioContext();
        const destination = audioContext.createMediaStreamDestination();
  
        if (displayStream?.getAudioTracks().length > 0) {
          const displayAudio = audioContext.createMediaStreamSource(displayStream);
          displayAudio.connect(destination);
        }
  
        if (micStream?.getAudioTracks().length > 0) {
          const micAudio = audioContext.createMediaStreamSource(micStream);
          micAudio.connect(destination);
        }
  
        // Stream final combinado
        const tracks = [];
        if (displayStream?.getVideoTracks().length > 0) {
          tracks.push(...displayStream.getVideoTracks());
        }
        tracks.push(...destination.stream.getAudioTracks());
  
        const combinedStream = new MediaStream(tracks);
  
        // Elegir el mejor codec disponible
        const mimeType = this._getBestMimeType();
  
        this.mediaRecorder = new MediaRecorder(combinedStream, {
          mimeType,
          videoBitsPerSecond: 2500000,
          audioBitsPerSecond: 128000
        });
  
        this.recordedChunks = [];
  
        this.mediaRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            this.recordedChunks.push(event.data);
          }
        };
  
        this.mediaRecorder.onstop = () => {
          this._saveRecording();
          // Detener todos los tracks
          combinedStream.getTracks().forEach(t => t.stop());
          if (displayStream) displayStream.getTracks().forEach(t => t.stop());
          if (micStream) micStream.getTracks().forEach(t => t.stop());
        };
  
        // Capturar cada 1 segundo para reducir pérdida de datos
        this.mediaRecorder.start(1000);
  
        this.isRecording = true;
        this.startTime = Date.now();
        this._updateUI(true);
        this._startTimer();
  
        // Notificar a otros participantes
        if (this.socket) {
          this.socket.emit('recording-started', {
            roomId: this.roomId,
            userName: this.userName
          });
        }
  
        // Si el usuario cierra el stream de pantalla
        if (displayStream) {
          displayStream.getVideoTracks()[0].addEventListener('ended', () => {
            if (this.isRecording) this.stopRecording();
          });
        }
  
        console.log('🎥 Grabación iniciada - codec:', mimeType);
  
      } catch (err) {
        console.error('Error al iniciar grabación:', err);
        this._showError('No se pudo iniciar la grabación: ' + err.message);
      }
    }
  
    stopRecording() {
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      }
      this.isRecording = false;
      this._updateUI(false);
      this._stopTimer();
  
      if (this.socket) {
        this.socket.emit('recording-stopped', {
          roomId: this.roomId,
          userName: this.userName
        });
      }
  
      console.log('⏹️ Grabación detenida');
    }
  
    _getBestMimeType() {
      const types = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=h264,opus',
        'video/webm',
        'video/mp4',
      ];
      for (const type of types) {
        if (MediaRecorder.isTypeSupported(type)) return type;
      }
      return 'video/webm';
    }
  
    async _saveRecording() {
      if (this.recordedChunks.length === 0) {
        this._showError('No se grabó ningún dato.');
        return;
      }
  
      const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
      const duration = Math.round((Date.now() - this.startTime) / 1000);
  
      // ✅ Nombre del archivo con fecha y hora
      const now = new Date();
      const dateStr = now.toLocaleDateString('es-PY').replace(/\//g, '-');
      const timeStr = now.toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h');
      const filename = `IFD-Clase-${dateStr}-${timeStr}.webm`;
  
      // Mostrar indicador de guardado
      this._showSavingIndicator(blob.size);
  
      // ✅ OPCIÓN 1: Subir al servidor (se guarda en public/recordings/)
      try {
        const formData = new FormData();
        formData.append('recording', blob, filename);
  
        const response = await fetch('/upload-recording', {
          method: 'POST',
          body: formData
        });
  
        const result = await response.json();
  
        if (result.ok) {
          console.log('✅ Grabación guardada en servidor:', result.filename);
          this._showSuccessMessage(result.filename, blob.size, duration, result.url);
        } else {
          throw new Error(result.error);
        }
      } catch (serverErr) {
        console.warn('No se pudo subir al servidor, descargando localmente:', serverErr);
        // ✅ OPCIÓN 2 (fallback): Descargar directamente al PC del usuario
        this._downloadLocally(blob, filename, blob.size, duration);
      }
    }
  
    _downloadLocally(blob, filename, size, duration) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
  
      setTimeout(() => URL.revokeObjectURL(url), 10000);
  
      this._showSuccessMessage(filename, size, duration, null, true);
    }
  
    _showSavingIndicator(size) {
      const mb = (size / 1024 / 1024).toFixed(1);
      this._showToast(`💾 Guardando grabación (${mb}MB)...`, 'info', 0);
    }
  
    _showSuccessMessage(filename, size, duration, serverUrl, local = false) {
      const mb = (size / 1024 / 1024).toFixed(1);
      const mins = Math.floor(duration / 60);
      const secs = duration % 60;
      const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
  
      const message = local
        ? `✅ Grabación descargada: ${filename}\n📁 Revisá tu carpeta de Descargas\n⏱️ Duración: ${timeStr} | 📦 ${mb}MB`
        : `✅ Grabación guardada: ${filename}\n⏱️ Duración: ${timeStr} | 📦 ${mb}MB`;
  
      this._showToast(message, 'success', 8000);
  
      // Mostrar modal con opción de descarga
      this._showRecordingModal(filename, size, duration, serverUrl, local);
    }
  
    _showRecordingModal(filename, size, duration, serverUrl, local) {
      const mb = (size / 1024 / 1024).toFixed(1);
      const mins = Math.floor(duration / 60);
      const secs = duration % 60;
  
      // Crear modal
      const modal = document.createElement('div');
      modal.style.cssText = `
        position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;
        display:flex;align-items:center;justify-content:center;padding:20px;
      `;
      modal.innerHTML = `
        <div style="background:white;border-radius:16px;padding:32px;max-width:420px;width:100%;text-align:center;box-shadow:0 24px 64px rgba(0,0,0,0.3)">
          <div style="font-size:48px;margin-bottom:16px">🎥</div>
          <h3 style="font-size:20px;margin-bottom:8px;color:#1c1c1e">¡Grabación completada!</h3>
          <p style="color:#666;font-size:14px;margin-bottom:20px">${filename}</p>
          <div style="display:flex;gap:12px;justify-content:center;margin-bottom:20px">
            <div style="text-align:center;padding:12px 16px;background:#f5f5f5;border-radius:10px">
              <div style="font-size:20px;font-weight:700;color:#1a6b3c">${mins}:${secs.toString().padStart(2,'0')}</div>
              <div style="font-size:11px;color:#888">Duración</div>
            </div>
            <div style="text-align:center;padding:12px 16px;background:#f5f5f5;border-radius:10px">
              <div style="font-size:20px;font-weight:700;color:#1a6b3c">${mb}MB</div>
              <div style="font-size:11px;color:#888">Tamaño</div>
            </div>
          </div>
          ${serverUrl ? `
          <p style="font-size:12px;color:#4caf50;background:#e8f5e9;padding:10px;border-radius:8px;margin-bottom:16px">
            📁 Guardada en el servidor en: <strong>public/recordings/</strong>
          </p>
          <a href="${serverUrl}" download style="
            display:block;padding:12px;background:#1a6b3c;color:white;
            border-radius:10px;text-decoration:none;font-weight:600;margin-bottom:12px;font-size:14px
          ">⬇️ Descargar grabación</a>
          ` : `
          <p style="font-size:12px;color:#ff9800;background:#fff3e0;padding:10px;border-radius:8px;margin-bottom:16px">
            📁 Archivo descargado a tu carpeta de Descargas
          </p>
          `}
          <button onclick="this.closest('div[style]').remove()" style="
            width:100%;padding:12px;background:#f5f5f5;border:none;
            border-radius:10px;cursor:pointer;font-size:14px;color:#666;font-family:inherit
          ">Cerrar</button>
        </div>
      `;
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    }
  
    _showError(msg) {
      this._showToast('❌ ' + msg, 'error', 5000);
    }
  
    _showToast(msg, type = 'info', duration = 3000) {
      // Remover toast anterior si existe
      const existing = document.getElementById('ifd-toast');
      if (existing) existing.remove();
  
      const colors = {
        success: { bg: '#1a6b3c', text: 'white' },
        error: { bg: '#d32f2f', text: 'white' },
        info: { bg: '#1565c0', text: 'white' }
      };
      const color = colors[type] || colors.info;
  
      const toast = document.createElement('div');
      toast.id = 'ifd-toast';
      toast.style.cssText = `
        position:fixed;bottom:90px;left:50%;transform:translateX(-50%);
        background:${color.bg};color:${color.text};padding:12px 20px;
        border-radius:10px;font-size:13px;z-index:9998;max-width:380px;
        white-space:pre-line;text-align:center;line-height:1.5;
        box-shadow:0 8px 24px rgba(0,0,0,0.2);
        animation:fadeIn 0.3s ease;
      `;
      toast.textContent = msg;
      document.body.appendChild(toast);
  
      if (duration > 0) {
        setTimeout(() => toast.remove(), duration);
      }
    }
  
    _updateUI(recording) {
      if (this.btnRecord) {
        this.btnRecord.classList.toggle('recording', recording);
        this.btnRecord.title = recording ? 'Detener grabación' : 'Grabar clase';
        // Cambiar ícono
        const icon = this.btnRecord.querySelector('.btn-icon') || this.btnRecord;
        if (recording) {
          this.btnRecord.style.background = '#d32f2f';
          this.btnRecord.style.color = 'white';
        } else {
          this.btnRecord.style.background = '';
          this.btnRecord.style.color = '';
        }
      }
  
      if (this.recordingIndicator) {
        this.recordingIndicator.style.display = recording ? 'flex' : 'none';
      }
    }
  
    _startTimer() {
      if (this.recordingTimer) {
        this.timerInterval = setInterval(() => {
          const elapsed = Math.round((Date.now() - this.startTime) / 1000);
          const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
          const secs = (elapsed % 60).toString().padStart(2, '0');
          this.recordingTimer.textContent = `${mins}:${secs}`;
        }, 1000);
      }
    }
  
    _stopTimer() {
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }
      if (this.recordingTimer) {
        this.recordingTimer.textContent = '00:00';
      }
    }
  }
  
  // ✅ Estilos CSS para el indicador de grabación (se inyectan automáticamente)
  const recorderStyles = document.createElement('style');
  recorderStyles.textContent = `
    @keyframes fadeIn {
      from { opacity: 0; transform: translateX(-50%) translateY(10px); }
      to { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
  
    #recordingIndicator {
      display: none;
      align-items: center;
      gap: 8px;
      background: rgba(211,47,47,0.15);
      border: 1px solid rgba(211,47,47,0.4);
      border-radius: 20px;
      padding: 6px 14px;
      font-size: 13px;
      color: #d32f2f;
    }
  
    #recordingIndicator .rec-dot {
      width: 8px;
      height: 8px;
      background: #d32f2f;
      border-radius: 50%;
      animation: pulse-red 1s infinite;
    }
  
    @keyframes pulse-red {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.8); }
    }
  
    #btnRecord.recording {
      background: #d32f2f !important;
      color: white !important;
    }
  `;
  document.head.appendChild(recorderStyles);
  