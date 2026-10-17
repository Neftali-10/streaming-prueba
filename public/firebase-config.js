// Firebase Realtime Database se utiliza como servidor de señalización.
const firebaseConfig = {
  apiKey: "AIzaSyA_su_8doU7wlw8nHxJ2W_LxXi8phYvseA",
  authDomain: "webrtc-2b603.firebaseapp.com",
  databaseURL: "https://webrtc-2b603-default-rtdb.firebaseio.com",
  projectId: "webrtc-2b603",
  storageBucket: "webrtc-2b603.firebasestorage.app",
  messagingSenderId: "120974216016",
  appId: "1:120974216016:web:77049dde31881cd225ba55"

  // Si Firebase te proporciona apiKey, agrégala aquí:
  // apiKey: 'TU_API_KEY'
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const db = firebase.database();

const ROOM_PATH = 'rooms/main';

const RTC_CONFIG = {
  iceServers: [
    {
      urls: 'stun:stun.l.google.com:19302'
    },
    {
      urls: 'stun:stun1.l.google.com:19302'
    }
  ]
};