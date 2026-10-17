(() => {
  const role = document.currentScript.dataset.role;
  const player = document.getElementById('player');

  if (
    !player ||
    !['emisor', 'receptor'].includes(role) ||
    document.getElementById('reactionBar')
  ) return;

  const options = new Map([
    ['👍', 'Me gusta'],
    ['👏', 'Aplausos'],
    ['❤️', 'Corazón'],
    ['😂', 'Risa'],
    ['🎉', 'Celebración'],
    ['😮', 'Sorpresa']
  ]);

  const layer = document.createElement('div');
  layer.className = 'reaction-layer';
  layer.setAttribute('aria-hidden', 'true');
  player.append(layer);

  const bar = document.createElement('section');
  bar.id = 'reactionBar';
  bar.className = 'reaction-bar';
  bar.innerHTML = `
    <strong>Reacciones en vivo</strong>
    <div class="reaction-buttons"></div>
    <p class="extra-hint" role="status" aria-live="polite"></p>
  `;
  player.insertAdjacentElement('afterend', bar);

  const buttons = bar.querySelector('.reaction-buttons');
  const hint = bar.querySelector('p');
  const controls = [];

  if (role === 'receptor') {
    for (const [emoji, label] of options) {
      const button = document.createElement('button');

      button.type = 'button';
      button.className = 'reaction-button';
      button.textContent = emoji;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.disabled = true;

      button.addEventListener('click', () => send(emoji));
      buttons.append(button);
      controls.push(button);
    }
  } else {
    buttons.hidden = true;
  }

  if (typeof db === 'undefined' || typeof ROOM_PATH === 'undefined') {
    hint.textContent = 'No se cargó la configuración de Firebase.';
    return;
  }

  const room = db.ref(ROOM_PATH);
  const clientId = room.push().key;

  let active = false;
  let online = false;
  let session = null;
  let offset = 0;
  let binding = null;
  let pending = false;
  let nextSend = 0;
  let errorText = '';
  let fatalError = '';

  const now = () => Date.now() + offset;

  function participating() {
    if (role === 'emisor') {
      return (
        typeof localStream !== 'undefined' &&
        localStream &&
        !document.getElementById('stopBtn').disabled
      );
    }

    return (
      typeof pc !== 'undefined' &&
      pc &&
      pc.connectionState === 'connected'
    );
  }

  function ready() {
    return (
      active &&
      online &&
      session &&
      participating() &&
      !fatalError
    );
  }

  function draw(data) {
    // Evita llenar el reproductor con demasiadas animaciones.
    if (layer.children.length >= 6) {
      layer.firstElementChild.remove();
    }

    const bubble = document.createElement('div');
    bubble.className = 'reaction-bubble';
    bubble.style.left = `${12 + Math.random() * 65}%`;

    const emoji = document.createElement('span');
    emoji.textContent = data.emoji;

    const name = document.createElement('small');
    name.textContent = typeof data.name === 'string'
      ? data.name.slice(0, 24)
      : 'Espectador';

    bubble.append(emoji, name);
    layer.append(bubble);

    setTimeout(() => bubble.remove(), 3200);
  }

  function detach() {
    if (binding) {
      binding.query.off('child_added', binding.receive);
      binding.query.off('child_changed', binding.receive);
    }

    binding = null;
    layer.replaceChildren();
  }

  function attach() {
    detach();

    const state = {
      session,
      since: now(),
      seen: new Set(),
      query: room
        .child('reactions')
        .child(session)
        .orderByKey()
        .limitToLast(30)
    };

    binding = state;

    state.receive = snapshot => {
      if (binding !== state || !ready()) return;

      const data = snapshot.val();

      if (
        !data ||
        !options.has(data.emoji) ||
        typeof data.createdAt !== 'number'
      ) return;

      // Ignora reacciones anteriores a esta conexión o ya vencidas.
      if (
        data.createdAt < state.since ||
        now() - data.createdAt > 5000 ||
        data.createdAt > now() + 2000
      ) return;

      // Firebase puede actualizar la hora al confirmar una escritura.
      // Esto evita animar dos veces la misma reacción.
      if (state.seen.has(snapshot.key)) return;

      state.seen.add(snapshot.key);

      if (state.seen.size > 200) {
        state.seen.delete(state.seen.values().next().value);
      }

      draw(data);
    };

    const failed = error => {
      if (binding !== state) return;

      console.error('Leer reacciones:', error);
      fatalError =
        'No se pueden leer las reacciones. Revisa los permisos de Firebase.';
      sync();
    };

    state.query.on('child_added', state.receive, failed);
    state.query.on('child_changed', state.receive, failed);
  }

  function sync() {
    if (ready()) {
      if (!binding || binding.session !== session) attach();
    } else if (binding) {
      detach();
    }

    controls.forEach(button => {
      button.disabled =
        !ready() || pending || Date.now() < nextSend;
    });

    hint.textContent = fatalError || (
      !online
        ? 'Conectando las reacciones…'
        : !active || !session
          ? 'Las reacciones se activan durante el directo.'
          : !participating()
            ? 'Conéctate al directo para ver y enviar reacciones.'
            : errorText || (
              role === 'emisor'
                ? 'Aquí verás las reacciones de tus espectadores.'
                : 'El emisor y los demás receptores verán tu reacción.'
            )
    );
  }

  async function send(emoji) {
    if (
      role !== 'receptor' ||
      !ready() ||
      pending ||
      Date.now() < nextSend
    ) return;

    const target = room
      .child('reactions')
      .child(session)
      .push();

    const sentSession = session;
    const name =
      document.getElementById('chatName')?.value.trim().slice(0, 24) ||
      'Espectador';

    pending = true;
    nextSend = Date.now() + 1000;
    errorText = '';
    sync();

    try {
      await target.set({
        emoji,
        name,
        senderId: clientId,
        createdAt: firebase.database.ServerValue.TIMESTAMP
      });

      // Son eventos pasajeros, separados del historial del chat.
      setTimeout(() => {
        target.remove().catch(console.error);
      }, 6000);
    } catch (error) {
      console.error('Enviar reacción:', error);

      if (session === sentSession) {
        errorText =
          'No se pudo enviar la reacción. Revisa los permisos y la conexión.';
      }
    } finally {
      pending = false;
      sync();
    }
  }

  function failed(error) {
    console.error('Estado de reacciones:', error);
    fatalError =
      'No se pudo leer la sala. Revisa los permisos de Firebase.';
    sync();
  }

  db.ref('.info/serverTimeOffset').on('value', snapshot => {
    const nextOffset = Number(snapshot.val()) || 0;

    if (binding) {
      binding.since += nextOffset - offset;
    }

    offset = nextOffset;
  });

  room.child('active').on('value', snapshot => {
    active = snapshot.val() === true;
    sync();
  }, failed);

  room.child('startedAt').on('value', snapshot => {
    session = typeof snapshot.val() === 'number'
      ? String(snapshot.val())
      : null;

    errorText = '';
    sync();
  }, failed);

  db.ref('.info/connected').on('value', snapshot => {
    online = snapshot.val() === true;
    sync();
  }, failed);

  setInterval(sync, 300);
  sync();
})();