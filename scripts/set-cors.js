const { initializeApp, cert } = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');

const serviceAccount = require('../service-account.json');

initializeApp({
  credential: cert(serviceAccount),
  storageBucket: 'fublev-attendance.firebasestorage.app'
});

const bucket = getStorage().bucket();

const corsConfig = [
  {
    origin: ['*'],
    method: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD'],
    responseHeader: ['Content-Type'],
    maxAgeSeconds: 3600
  }
];

bucket.setCorsConfiguration(corsConfig)
  .then(() => console.log('CORS設定完了'))
  .catch(err => console.error('エラー:', err));
