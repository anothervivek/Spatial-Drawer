const http = require('http');
const { WebSocketServer } = require('ws');

let pointsQueue = [];

const httpServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

    if (req.method === 'POST' && req.url === '/draw') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                pointsQueue.push(data);
                console.log(`📍 [HTTP] ${data.action}: (${data.x?.toFixed(2)}, ${data.y?.toFixed(2)}, ${data.z?.toFixed(2)})`);
                res.writeHead(200); res.end('OK');
            } catch (e) { res.writeHead(400); res.end('Bad Request'); }
        });
    } else if (req.method === 'GET' && req.url === '/sync') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (pointsQueue.length > 0) console.log(`🔄 Blender polled - sending ${pointsQueue.length} points`);
        res.end(JSON.stringify(pointsQueue));
        pointsQueue = [];
    } else if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Spectacles Relay Server</h1><p>WebSocket + HTTP ready.</p>');
    } else { res.writeHead(404); res.end('Not found'); }
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
    console.log('🔌 Spectacles WebSocket CONNECTED!');
    
    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw.toString());
            pointsQueue.push(data);
            console.log(`📍 [WS] ${data.action}: (${data.x?.toFixed(2)}, ${data.y?.toFixed(2)}, ${data.z?.toFixed(2)})`);
        } catch (e) {
            console.error("WS parse error:", e);
        }
    });
    
    ws.on('close', () => { console.log('🔌 Spectacles WebSocket DISCONNECTED'); });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Spectacles Relay Server running on port ${PORT}`);
});
