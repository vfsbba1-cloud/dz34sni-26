# DZ34SNI Relay Server

Serveur relais entre l'extension Chrome (agent) et l'APK (client).

## Déploiement sur Glitch (GRATUIT)

1. Va sur https://glitch.com
2. Clique "New Project" → "Import from GitHub" (ou "glitch-hello-node")
3. Supprime tous les fichiers existants
4. Upload `server.js` et `package.json`
5. Le serveur démarre automatiquement
6. Ton URL sera: `https://ton-projet.glitch.me`

## Déploiement sur Render (GRATUIT)

1. Va sur https://render.com
2. New → Web Service → Upload files
3. Upload `server.js` et `package.json`
4. Build command: `npm install`
5. Start command: `node server.js`
6. Ton URL sera: `https://ton-service.onrender.com`

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /task/:phone | Extension envoie la tâche liveness |
| GET | /task/:phone | APK récupère la tâche |
| POST | /result/:phone | APK envoie le résultat selfie |
| GET | /result/:phone | Extension récupère le résultat |
| DELETE | /clear/:phone | Nettoyer après usage |

## Test

```bash
curl https://ton-projet.glitch.me/
# → {"status":"ok","service":"DZ34SNI Relay",...}
```
