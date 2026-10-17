(() => {
  const role = document.currentScript.dataset.role;
  const sidebar = document.querySelector('.right-column');

  if (!sidebar || document.getElementById('liveChat')) return;
  if (!['emisor', 'receptor'].includes(role)) return;

  // Este HTML es fijo. Los mensajes se insertan después como texto.
  const panel = document.createElement('section');

  panel.id = 'liveChat';
  panel.className = 'panel chat-panel';

  panel.innerHTML = `
    <div class="panel-heading">
      <h2>La conversación</h2>

      <span id="chatBadge" class="chat-badge">
        ESPERANDO
      </span>
    </div>

    <p class="chat-description">
      Un directo, cuatro lugares y mucho por compartir.
    </p>

    <div
      class="chat-window"
      id="chatWindow"
      tabindex="0"
      aria-label="Historial del chat"
    >
      <p class="chat-empty" id="chatEmpty">
        Aquí comienza la conversación.
      </p>

      <div
        id="chatMessages"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Mensajes"
      ></div>
    </div>

    <form id="chatForm">
      <label class="chat-label" for="chatName">
        Tu nombre en el chat
      </label>

      <input
        id="chatName"
        class="chat-input"
        maxlength="24"
        required
        autocomplete="nickname"
        placeholder="Escribe tu nombre"
      >

      <label class="chat-label" for="chatText">
        Mensaje
      </label>

      <textarea
        id="chatText"
        class="chat-input"
        maxlength="500"
        rows="3"
        placeholder="Comparte una idea o pregunta…"
        disabled
      ></textarea>

      <div class="chat-actions">
        <span id="chatCounter">0 / 500</span>

        <button
          id="chatSend"
          class="button button-primary"
          type="submit"
          disabled
        >
          Enviar ↗
        </button>
      </div>

      <p
        id="chatHint"
        class="chat-hint"
        role="status"
      ></p>
    </form>
  `;

  // Inserta el chat después de la primera tarjeta de controles.
  sidebar.insertBefore(panel, sidebar.children[1] || null);

  const get = id => document.getElementById(id);

  const nameInput = get('chatName');
  const textInput = get('chatText');
  const sendButton = get('chatSend');
  const messages = get('chatMessages');
  const scrollBox = get('chatWindow');

  const nodes = new Map();
  const storageKey = `pulse-chat-name-${role}`;

  if (
    typeof db === 'undefined' ||
    typeof ROOM_PATH === 'undefined'
  ) {
    get('chatHint').textContent =
      'No se pudo cargar Firebase. Revisa la configuración.';

    return;
  }

  const room = db.ref(ROOM_PATH);

  // Genera un identificador local; no escribe una nueva sala.
  const senderId = room.push().key;

  let storedName = '';

  try {
    storedName = sessionStorage.getItem(storageKey) || '';
  } catch {
    // El chat también funciona si el navegador bloquea el almacenamiento.
  }

  nameInput.value =
    storedName.slice(0, 24) ||
    (role === 'emisor' ? 'Emisor' : '');

  let active = false;
  let online = false;

  let sessionId = null;
  let boundSession = null;

  let query = null;
  let handlers = null;

  let sending = false;

  let fatalError = '';
  let readError = '';
  let sendError = '';

  // Comprueba el estado de los scripts de streaming existentes.
  function participating() {
    if (role === 'emisor') {
      const button = get('stopBtn');

      return Boolean(
        button &&
        !button.disabled &&
        typeof localStream !== 'undefined' &&
        localStream
      );
    }

    return Boolean(
      typeof pc !== 'undefined' &&
      pc &&
      pc.connectionState === 'connected'
    );
  }

  function eligible() {
    return Boolean(
      active &&
      sessionId &&
      participating() &&
      !fatalError
    );
  }

  function canChat() {
    return Boolean(
      eligible() &&
      online &&
      query &&
      !readError
    );
  }

  function showMessage(snapshot, previousKey) {
    const data = snapshot.val();

    if (
      !data ||
      typeof data.text !== 'string' ||
      typeof data.name !== 'string'
    ) {
      return;
    }

    if (
      !data.text.trim() ||
      data.text.length > 500 ||
      data.name.length > 24
    ) {
      return;
    }

    const nearBottom =
      scrollBox.scrollHeight -
      scrollBox.scrollTop -
      scrollBox.clientHeight < 70;

    let item = nodes.get(snapshot.key);

    if (!item) {
      const element = document.createElement('article');
      element.className = 'chat-message';

      const header = document.createElement('div');
      header.className = 'chat-message-header';

      const author = document.createElement('strong');

      const badge = document.createElement('span');
      badge.className = 'chat-author-badge';

      const time = document.createElement('time');
      const body = document.createElement('p');

      header.append(author, badge, time);
      element.append(header, body);

      item = {
        element,
        author,
        badge,
        time,
        body
      };

      const previous = nodes.get(previousKey);

      const insertBefore = previousKey === null
        ? messages.firstChild
        : previous
          ? previous.element.nextSibling
          : null;

      messages.insertBefore(element, insertBefore);
      nodes.set(snapshot.key, item);
    }

    // El contenido del usuario nunca se interpreta como HTML.
    item.author.textContent = data.name;
    item.body.textContent = data.text;

    item.badge.textContent =
      data.role === 'emisor' ? 'EMISOR' : '';

    item.badge.hidden = data.role !== 'emisor';

    item.element.classList.toggle(
      'chat-message-mine',
      data.senderId === senderId
    );

    const date = new Date(
      typeof data.createdAt === 'number'
        ? data.createdAt
        : NaN
    );

    item.time.textContent = Number.isNaN(date.getTime())
      ? 'Ahora'
      : date.toLocaleTimeString('es-GT', {
          hour: '2-digit',
          minute: '2-digit'
        });

    get('chatEmpty').hidden = true;

    // Respeta al usuario si está leyendo mensajes anteriores.
    if (nearBottom || data.senderId === senderId) {
      scrollBox.scrollTop = scrollBox.scrollHeight;
    }
  }

  function detach() {
    // Elimina únicamente los listeners de este chat.
    if (query && handlers) {
      for (const [event, callback] of Object.entries(handlers)) {
        query.off(event, callback);
      }
    }

    query = null;
    handlers = null;
    boundSession = null;
    readError = '';

    nodes.clear();
    messages.replaceChildren();

    get('chatEmpty').hidden = false;
  }

  function attach(id) {
    detach();

    boundSession = id;

    // Cada transmisión tiene su propio historial.
    query = room
      .child('chat')
      .child(id)
      .orderByKey()
      .limitToLast(100);

    handlers = {
      child_added: (snapshot, previousKey) => {
        if (boundSession === id) {
          showMessage(snapshot, previousKey);
        }
      },

      child_changed: snapshot => {
        if (boundSession === id) {
          showMessage(snapshot);
        }
      },

      child_removed: snapshot => {
        if (boundSession !== id) return;

        const item = nodes.get(snapshot.key);

        if (item) {
          item.element.remove();
        }

        nodes.delete(snapshot.key);
        get('chatEmpty').hidden = nodes.size > 0;
      }
    };

    for (const [event, callback] of Object.entries(handlers)) {
      query.on(event, callback, error => {
        if (boundSession !== id) return;

        console.error('Lectura del chat:', error);

        readError =
          'Firebase no permite leer el chat. ' +
          'Revisa los permisos de esta sala.';

        updateControls();
      });
    }
  }

  function updateControls() {
    const available = canChat();

    textInput.disabled = !available || sending;
    nameInput.readOnly = sending;

    sendButton.disabled =
      !available ||
      sending ||
      !textInput.value.trim() ||
      !nameInput.value.trim();

    sendButton.textContent = sending
      ? 'Enviando…'
      : 'Enviar ↗';

    get('chatCounter').textContent =
      `${textInput.value.length} / 500`;

    get('chatBadge').classList.toggle(
      'chat-badge-ready',
      available
    );

    get('chatBadge').textContent = available
      ? 'EN LÍNEA'
      : 'ESPERANDO';

    let hint =
      'Enter para enviar · Mayús + Enter para otra línea.';

    if (fatalError || readError) {
      hint = fatalError || readError;
    } else if (!online) {
      hint = 'Chat sin conexión. Tu texto se conserva.';
    } else if (!active || !sessionId) {
      hint = 'El chat se abre cuando comienza el directo.';
    } else if (!participating()) {
      hint = role === 'emisor'
        ? 'Inicia la transmisión para participar.'
        : 'Conéctate al directo para participar.';
    } else if (sending) {
      hint = 'Esperando confirmación de envío…';
    } else if (sendError) {
      hint = sendError;
    }

    if (get('chatHint').textContent !== hint) {
      get('chatHint').textContent = hint;
    }
  }

  function sync() {
    if (eligible()) {
      if (boundSession !== sessionId) {
        attach(sessionId);
      }
    } else if (query) {
      detach();
    }

    updateControls();
  }

  function metadataError(error) {
    console.error('Estado del chat:', error);

    fatalError =
      'No se pudo leer el estado de la sala. ' +
      'Revisa los permisos de Firebase.';

    sync();
  }

  room.child('active').on(
    'value',
    snapshot => {
      active = snapshot.val() === true;
      sync();
    },
    metadataError
  );

  room.child('startedAt').on(
    'value',
    snapshot => {
      const value = snapshot.val();

      sessionId =
        typeof value === 'number' &&
        Number.isFinite(value)
          ? String(value)
          : null;

      sync();
    },
    metadataError
  );

  db.ref('.info/connected').on(
    'value',
    snapshot => {
      online = snapshot.val() === true;
      sync();
    },
    metadataError
  );

  for (const input of [nameInput, textInput]) {
    input.addEventListener('input', () => {
      sendError = '';
      updateControls();
    });
  }

  get('chatForm').addEventListener(
    'submit',
    async event => {
      event.preventDefault();

      const rawText = textInput.value;
      const text = rawText.trim();

      const name = nameInput.value
        .trim()
        .replace(/\s+/g, ' ');

      if (
        sending ||
        !canChat() ||
        !text ||
        !name
      ) {
        return;
      }

      if (text.length > 500 || name.length > 24) {
        return;
      }

      const messageRef = room
        .child('chat')
        .child(boundSession)
        .push();

      sending = true;
      sendError = '';

      updateControls();

      try {
        await messageRef.set({
          senderId,
          name,
          role,
          text,
          createdAt: firebase.database.ServerValue.TIMESTAMP
        });

        if (textInput.value === rawText) {
          textInput.value = '';
        }

        try {
          sessionStorage.setItem(storageKey, name);
        } catch {
          // Guardar el nombre es opcional.
        }
      } catch (error) {
        console.error('Envío del chat:', error);

        sendError =
          'No se pudo enviar. Tu texto se conserva; ' +
          'revisa la conexión y los permisos.';
      } finally {
        sending = false;

        sync();

        if (!textInput.disabled) {
          textInput.focus();
        }
      }
    }
  );

  textInput.addEventListener('keydown', event => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.isComposing
    ) {
      event.preventDefault();

      if (!sendButton.disabled) {
        get('chatForm').requestSubmit();
      }
    }
  });

  const status = get('status');

  if (status) {
    new MutationObserver(sync).observe(status, {
      childList: true,
      subtree: true
    });
  }

  setInterval(sync, 1000);
  sync();
})();