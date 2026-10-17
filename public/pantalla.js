(() => {
  const video = document.getElementById('localVideo');
  const stopButton = document.getElementById('stopBtn');

  if (
    !video ||
    !stopButton ||
    document.getElementById('screenButton')
  ) return;

  const box = document.createElement('div');
  box.className = 'screen-tools';

  box.innerHTML = `
    <button
      id="screenButton"
      class="button button-secondary"
      type="button"
      disabled
    >
      Compartir pantalla
    </button>

    <p
      id="screenHint"
      class="extra-hint"
      role="status"
    ></p>
  `;

  (stopButton.closest('.controls') || stopButton)
    .insertAdjacentElement('afterend', box);

  const button = document.getElementById('screenButton');
  const hint = document.getElementById('screenHint');

  const supported =
    window.isSecureContext &&
    Boolean(navigator.mediaDevices?.getDisplayMedia);

  let display = null;
  let composition = null;
  let camera = null;
  let busy = false;
  let returnRequested = false;
  let version = 0;
  let message = '';

  function running() {
    return (
      typeof localStream !== 'undefined' &&
      localStream &&
      !stopButton.disabled
    );
  }

  function endCapture(stream) {
    if (!stream) return;

    if (stream === display && composition) {
      composition.stop();
      composition = null;
    }

    stream.getTracks().forEach(track => {
      track.onended = null;
      track.stop();
    });
  }

  // Une la pantalla y la cámara en una sola pista de video.
  function compose(screenStream, cameraTrack) {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;

    const context = canvas.getContext('2d');

    if (!context || !canvas.captureStream) {
      throw new Error(
        'El navegador no permite combinar los videos.'
      );
    }

    const screenVideo = document.createElement('video');
    const cameraVideo = document.createElement('video');

    for (const element of [screenVideo, cameraVideo]) {
      element.muted = true;
      element.autoplay = true;
      element.playsInline = true;
    }

    screenVideo.srcObject = screenStream;
    cameraVideo.srcObject = new MediaStream([cameraTrack]);

    const output = canvas.captureStream(25);

    let timer = null;
    let closed = false;

    // Ajusta la imagen sin deformarla.
    function fit(element, x, y, width, height, cover = false) {
      if (
        element.readyState < 2 ||
        !element.videoWidth ||
        !element.videoHeight
      ) return;

      const scale = (cover ? Math.max : Math.min)(
        width / element.videoWidth,
        height / element.videoHeight
      );

      const w = element.videoWidth * scale;
      const h = element.videoHeight * scale;

      context.drawImage(
        element,
        x + (width - w) / 2,
        y + (height - h) / 2,
        w,
        h
      );
    }

    function draw() {
      if (closed) return;

      // Pantalla compartida como imagen principal.
      context.fillStyle = '#08090a';
      context.fillRect(0, 0, canvas.width, canvas.height);

      fit(
        screenVideo,
        0,
        0,
        canvas.width,
        canvas.height
      );

      // Tamaño de la cámara pequeña.
      const width = 240;
      const height = 135;

      // Posición: esquina inferior izquierda.
      const x = 20;
      const y = canvas.height - height - 20;

      context.save();
      context.beginPath();

      if (context.roundRect) {
        context.roundRect(x, y, width, height, 12);
      } else {
        context.rect(x, y, width, height);
      }

      context.clip();

      context.fillStyle = '#17191d';
      context.fillRect(x, y, width, height);

      fit(cameraVideo, x, y, width, height, true);

      context.restore();

      // Borde discreto de la miniatura.
      context.strokeStyle = '#e0e3e7';
      context.lineWidth = 2;
      context.stroke();
    }

    function release() {
      closed = true;
      clearInterval(timer);

      output.getTracks().forEach(track => track.stop());

      for (const element of [screenVideo, cameraVideo]) {
        element.pause();
        element.srcObject = null;
      }
    }

    const ready = Promise.all([
      screenVideo.play(),
      cameraVideo.play()
    ]).then(() => {
      if (closed) {
        throw new Error('La captura ya terminó.');
      }

      draw();
      timer = setInterval(draw, 40);
    });

    return {
      track: output.getVideoTracks()[0],
      ready,
      stop: release
    };
  }

  function cleanup() {
    version++;

    endCapture(display);

    if (camera) {
      camera.stop();
    }

    display = null;
    camera = null;
    busy = false;
    returnRequested = false;
    message = '';
  }

  function update() {
    if (!running() && (display || camera || busy)) {
      cleanup();
    }

    button.disabled = !supported || !running() || busy;

    button.textContent = busy
      ? 'Cambiando…'
      : display
        ? 'Volver a la cámara'
        : 'Compartir pantalla';

    button.setAttribute(
      'aria-pressed',
      String(Boolean(display))
    );

    hint.textContent = !supported
      ? 'Compartir pantalla requiere HTTPS o localhost y un navegador compatible.'
      : !running()
        ? 'Inicia el directo para compartir pantalla.'
        : message ||
          'Comparte pantalla con tu cámara en una miniatura a la izquierda.';
  }

  async function useVideo(stream, track) {
    if (!track || track.readyState !== 'live') {
      throw new Error('La fuente de video terminó.');
    }

    // Actualiza la fuente para quienes se conecten después.
    // El micrófono permanece dentro del mismo stream.
    stream.getVideoTracks().forEach(current => {
      stream.removeTrack(current);
    });

    stream.addTrack(track);
    video.srcObject = stream;

    // Actualiza el video de los receptores ya conectados.
    const peers = Array.from(peerConnections.values())
      .map(state => state.pc);

    const results = await Promise.allSettled(
      peers.map(async connection => {
        if (connection.signalingState === 'closed') return;

        const sender = connection.getSenders()
          .find(item => item.track?.kind === 'video');

        if (!sender) {
          throw new Error(
            'No se encontró la pista de video.'
          );
        }

        await sender.replaceTrack(track);
      })
    );

    const failed = results.some((result, index) => {
      return (
        result.status === 'rejected' &&
        peers[index].signalingState !== 'closed'
      );
    });

    if (failed) {
      throw new Error(
        'No se pudo cambiar el video para todos los receptores.'
      );
    }
  }

  async function toggleScreen() {
    if (busy || !running() || !supported) return;

    const stream = localStream;
    const token = ++version;

    const valid = () => {
      return (
        token === version &&
        localStream === stream &&
        running()
      );
    };

    let captured = null;

    busy = true;
    returnRequested = false;
    message = '';
    update();

    try {
      if (display) {
        // Recupera la cámara como imagen principal.
        await useVideo(stream, camera);

        if (!valid()) return;

        endCapture(display);
        display = null;

        message = 'Estás transmitiendo la cámara.';
      } else {
        camera = stream.getVideoTracks()[0];

        // Abre el selector de pantalla del navegador.
        captured = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 15, max: 30 }
          },
          audio: false
        });

        if (!valid()) return;

        display = captured;

        const track = display.getVideoTracks()[0];

        if (!track) {
          throw new Error('No se recibió una pantalla.');
        }

        // Regresa a la cámara al pulsar
        // "Dejar de compartir" en el navegador.
        track.onended = () => {
          returnRequested = true;

          if (!busy) {
            toggleScreen();
          }
        };

        // Combina pantalla grande y cámara pequeña.
        composition = compose(display, camera);

        await composition.ready;

        if (!valid()) return;

        if (track.readyState !== 'live') {
          throw new Error(
            'La pantalla dejó de compartirse.'
          );
        }

        // Envía la composición, no la pantalla sola.
        await useVideo(stream, composition.track);

        if (!valid()) return;

        message =
          'Pantalla compartida, cámara a la izquierda y micrófono activo.';

        if (track.readyState === 'ended') {
          returnRequested = true;
        }
      }
    } catch (error) {
      if (!valid()) return;

      console.error('Compartir pantalla:', error);

      // Si ocurre un error, intenta volver a la cámara.
      try {
        await useVideo(stream, camera);

        if (!valid()) return;

        endCapture(display);
        display = null;

        message =
          error.name === 'NotAllowedError' ||
          error.name === 'AbortError'
            ? 'No se compartió pantalla. La cámara sigue activa.'
            : 'No se pudo cambiar la fuente. Se mantiene la cámara.';
      } catch (restoreError) {
        if (valid()) {
          console.error(
            'Restaurar cámara:',
            restoreError
          );

          await stop();

          document.getElementById('status').textContent =
            'No se pudo recuperar la cámara. Vuelve a iniciar el directo.';
        }
      }
    } finally {
      if (token !== version) {
        endCapture(captured);
      } else {
        busy = false;
        update();

        if (returnRequested && display && running()) {
          toggleScreen();
        }
      }
    }
  }

  button.addEventListener('click', toggleScreen);

  // Libera los recursos al detener la transmisión.
  stopButton.addEventListener('click', () => {
    cleanup();
    update();
  }, true);

  new MutationObserver(update).observe(stopButton, {
    attributes: true,
    attributeFilter: ['disabled']
  });

  window.addEventListener('pagehide', cleanup);

  update();
})();