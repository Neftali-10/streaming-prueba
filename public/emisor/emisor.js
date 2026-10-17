const localVideo = document.getElementById('localVideo');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');

const MAX_RECEIVERS = 4;

let localStream = null;
let roomRef = null;
let viewersRef = null;

// Cada receptor tendrá su propia RTCPeerConnection.
const peerConnections = new Map();

function setStatus(text) {
  statusEl.textContent = text;
}

function updateReceiverCount() {
  const numberOfReceivers = peerConnections.size;

  if (numberOfReceivers === 0) {
    setStatus('Emisor activo. Esperando receptores...');
    return;
  }

  setStatus(
    `Transmitiendo a ${numberOfReceivers} de ` +
    `${MAX_RECEIVERS} receptores.`
  );
}

async function createViewerConnection(viewerId) {
  if (!localStream || !viewersRef) return;

  if (peerConnections.has(viewerId)) return;

  const viewerRef = viewersRef.child(viewerId);

  // Rechaza al quinto receptor.
  if (peerConnections.size >= MAX_RECEIVERS) {
    await viewerRef.child('rejected').set({
      reason: 'La transmisión alcanzó el límite de 4 receptores.'
    });

    return;
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);

  const state = {
    pc,
    viewerRef,
    answerRef: viewerRef.child('answer'),
    calleeCandidatesRef: viewerRef.child('calleeCandidates'),
    pendingCandidates: []
  };

  // Se registra inmediatamente para reservar uno de los cuatro lugares.
  peerConnections.set(viewerId, state);
  updateReceiverCount();

  // Comparte las mismas pistas locales con este receptor.
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });

  // Publica los candidatos ICE del emisor.
  pc.onicecandidate = async (event) => {
    if (!event.candidate) return;

    try {
      await viewerRef
        .child('callerCandidates')
        .push(event.candidate.toJSON());
    } catch (error) {
      console.error(
        `Error enviando candidato a ${viewerId}:`,
        error
      );
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(
      `Receptor ${viewerId}: ${pc.connectionState}`
    );

    updateReceiverCount();

    if (pc.connectionState === 'failed') {
      viewerRef.remove().catch(console.error);
    }
  };

  // Escucha únicamente la respuesta de este receptor.
  state.answerRef.on('value', async (snapshot) => {
    const answer = snapshot.val();

    if (
      !answer ||
      pc.signalingState === 'closed' ||
      pc.currentRemoteDescription
    ) {
      return;
    }

    try {
      await pc.setRemoteDescription(
        new RTCSessionDescription(answer)
      );

      // Agrega candidatos que llegaron antes que la respuesta.
      for (const candidate of state.pendingCandidates) {
        await pc.addIceCandidate(candidate);
      }

      state.pendingCandidates = [];
    } catch (error) {
      console.error(
        `Error procesando la respuesta de ${viewerId}:`,
        error
      );
    }
  });

  // Escucha únicamente los candidatos ICE de este receptor.
  state.calleeCandidatesRef.on(
    'child_added',
    async (snapshot) => {
      const data = snapshot.val();

      if (!data || pc.signalingState === 'closed') return;

      const candidate = new RTCIceCandidate(data);

      try {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(candidate);
        } else {
          state.pendingCandidates.push(candidate);
        }
      } catch (error) {
        console.error(
          `Error agregando candidato de ${viewerId}:`,
          error
        );
      }
    }
  );

  try {
    // Cada receptor recibe una oferta independiente.
    const offer = await pc.createOffer();

    await pc.setLocalDescription(offer);

    await viewerRef.child('offer').set({
      type: offer.type,
      sdp: offer.sdp
    });
  } catch (error) {
    console.error(
      `Error creando conexión para ${viewerId}:`,
      error
    );

    await viewerRef.child('error').set({
      message: 'No fue posible crear la conexión WebRTC.'
    });

    removeViewerConnection(viewerId);
  }
}

function removeViewerConnection(viewerId) {
  const state = peerConnections.get(viewerId);

  if (!state) return;

  state.answerRef.off();
  state.calleeCandidatesRef.off();

  state.pc.onicecandidate = null;
  state.pc.onconnectionstatechange = null;

  if (state.pc.signalingState !== 'closed') {
    state.pc.close();
  }

  peerConnections.delete(viewerId);
  updateReceiverCount();
}

async function start() {
  startBtn.disabled = true;
  setStatus('Solicitando acceso a cámara y micrófono...');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });

    localVideo.srcObject = localStream;

    roomRef = db.ref(ROOM_PATH);

    // Limpia cualquier transmisión anterior.
    await roomRef.remove();

    await roomRef.set({
      active: true,
      maximumReceivers: MAX_RECEIVERS,
      startedAt: firebase.database.ServerValue.TIMESTAMP
    });

    // Elimina la sala si el emisor pierde la conexión con Firebase.
    await roomRef.onDisconnect().remove();

    viewersRef = roomRef.child('viewers');

    // Atiende cada receptor que ingrese.
    viewersRef.on('child_added', (snapshot) => {
      createViewerConnection(snapshot.key).catch((error) => {
        console.error('Error creando receptor:', error);
      });
    });

    // Cierra la conexión cuando un receptor sale.
    viewersRef.on('child_removed', (snapshot) => {
      removeViewerConnection(snapshot.key);
    });

    stopBtn.disabled = false;
    updateReceiverCount();
  } catch (error) {
    console.error(error);

    setStatus(
      'No fue posible iniciar la transmisión: ' +
      error.message
    );

    if (localStream) {
      localStream.getTracks().forEach((track) => {
        track.stop();
      });

      localStream = null;
    }

    localVideo.srcObject = null;
    startBtn.disabled = false;
  }
}

async function stop() {
  stopBtn.disabled = true;

  if (viewersRef) {
    viewersRef.off();
  }

  // Copia las claves para poder eliminarlas mientras se recorre.
  const viewerIds = Array.from(peerConnections.keys());

  viewerIds.forEach((viewerId) => {
    removeViewerConnection(viewerId);
  });

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      track.stop();
    });

    localStream = null;
  }

  localVideo.srcObject = null;

  if (roomRef) {
    try {
      await roomRef.onDisconnect().cancel();
      await roomRef.remove();
    } catch (error) {
      console.error('Error eliminando la sala:', error);
    }
  }

  roomRef = null;
  viewersRef = null;

  setStatus('Transmisión detenida.');
  startBtn.disabled = false;
}

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);