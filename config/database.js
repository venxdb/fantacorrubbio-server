const { Pool } = require('pg');
require('dotenv').config();

// Configurazione pool di connessioni PostgreSQL
const pool = new Pool({
    // Se c'è DATABASE_URL (produzione), usalo. Altrimenti usa config locale
    connectionString: process.env.DATABASE_URL,
    
    // Configurazione per sviluppo locale (solo se non c'è DATABASE_URL)
    host: !process.env.DATABASE_URL ? process.env.DB_HOST || 'localhost' : undefined,
    port: !process.env.DATABASE_URL ? process.env.DB_PORT || 5432 : undefined,
    database: !process.env.DATABASE_URL ? process.env.DB_NAME || 'fantacalcio_asta' : undefined,
    user: !process.env.DATABASE_URL ? process.env.DB_USER || 'postgres' : undefined,
    password: !process.env.DATABASE_URL ? process.env.DB_PASSWORD || 'password' : undefined,
    
    // Configurazioni pool (sempre)
    max: 20,                    
    idleTimeoutMillis: 30000,   
    connectionTimeoutMillis: 2000,
    
    // Per produzione (Supabase)
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test connessione al database
const testConnection = async () => {
    try {
        const client = await pool.connect();
        const result = await client.query('SELECT NOW() as current_time');
        console.log('✅ Database connesso:', result.rows[0].current_time);
        client.release();
        return true;
    } catch (err) {
        console.error('❌ Errore connessione database:', err.message);
        return false;
    }
};

// Helper function per query semplici
const query = async (text, params) => {
    const start = Date.now();
    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;
        
        if (process.env.NODE_ENV === 'development') {
            console.log('🗄️  Query eseguita:', { text, duration: duration + 'ms', rows: res.rowCount });
        }
        
        return res;
    } catch (err) {
        console.error('❌ Errore query:', err.message);
        throw err;
    }
};

// Helper per transazioni
const transaction = async (callback) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

// Chiusura pool quando l'app termina
process.on('SIGINT', async () => {
    console.log('\n🔄 Chiusura connessioni database...');
    await pool.end();
    console.log('✅ Database disconnesso');
    process.exit(0);
});

module.exports = {
    pool,
    query,
    transaction,
    testConnection
};