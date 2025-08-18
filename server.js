const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();

// Import database e scheduler
const { testConnection } = require('./config/database');
const { avviaScheduler } = require('./utils/scheduler');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware di sicurezza e logging
app.use(helmet());
app.use(morgan('combined'));

// CORS - permetti richieste dal frontend React
app.use(cors({
    origin: [
        'http://localhost:3000',
        'https://fantacorrubbio-client.vercel.app'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Parsing JSON
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Test route con database
app.get('/api/test', async (req, res) => {
    try {
        const dbConnected = await testConnection();
        res.json({ 
            message: 'Server funziona!', 
            database: dbConnected ? 'Connesso' : 'Disconnesso',
            timestamp: new Date().toISOString() 
        });
    } catch (error) {
        res.status(500).json({ 
            message: 'Errore server', 
            error: error.message 
        });
    }
});

// Routes principali
app.use('/api/auth', require('./routes/auth'));
app.use('/api/calciatori', require('./routes/calciatori'));
app.use('/api/aste', require('./routes/aste'));
app.use('/api/utenti', require('./routes/utenti'));
app.use('/api/admin', require('./routes/admin'));

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ 
        error: 'Qualcosa è andato storto!',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Errore interno del server'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint non trovato' });
});

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Server avviato su porta ${PORT}`);
    console.log(`📡 API disponibile su http://0.0.0.0:${PORT}/api`);
    
    const dbConnected = await testConnection();
    if (dbConnected) {
        console.log('✅ Database PostgreSQL connesso');
        avviaScheduler();
    } else {
        console.log('❌ Impossibile connettersi al database');
    }
});

// Gestione graceful shutdown
process.on('SIGTERM', () => {
    console.log('🔄 Ricevuto SIGTERM, chiusura graceful...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('🔄 Ricevuto SIGINT, chiusura graceful...');
    process.exit(0);
});