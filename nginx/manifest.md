# Nginx Reverse Proxy Manifest (`nginx/`)

## Purpose
Local and container reverse proxy configuration (`nginx/default.conf`) routing `/socket.io/` WebSocket connections to the Express + Socket.IO ingestion service on Port `4000` and standard HTTP requests to the Next.js server on Port `3000`.
