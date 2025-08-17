const express = require('express');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

// Solo una route di test
app.get('/api/test', (req, res) => {
    res.json({ 
        message: 'Server funziona!', 
        timestamp: new Date().toISOString() 
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server avviato su porta ${PORT}`);
    console.log(`📡 API disponibile su http://0.0.0.0:${PORT}/api`);
    console.log('✅ Server minimale attivo');
});

// Gestione graceful shutdown
process.on('SIGTERM', () => {
    console.log('🔄 Ricevuto SIGTERM, chiusura graceful...');
    process.exit(0);
});