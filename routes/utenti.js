const express = require('express');
const { query } = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const router = express.Router();

// GET /api/utenti/me/rosa - Rosa dell'utente corrente (PRIMA di /:id/rosa!)
router.get('/me/rosa', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        // Recupera info utente
        const utenteResult = await query(`
            SELECT u.username, u.crediti_totali, u.crediti_spesi,
                   (u.crediti_totali - u.crediti_spesi) as crediti_disponibili
            FROM utenti u
            WHERE u.id = $1
        `, [userId]);

        if (utenteResult.rows.length === 0) {
            return res.status(404).json({ error: 'Utente non trovato' });
        }

        const utente = utenteResult.rows[0];

        // Recupera rosa con calciatori
        const rosaResult = await query(`
            SELECT r.*, c.nome, c.squadra, c.ruolo, c.quotazione,
                   r.prezzo_acquisto, r.created_at as data_acquisto
            FROM rose r
            JOIN calciatori c ON r.calciatore_id = c.id
            WHERE r.utente_id = $1
            ORDER BY c.ruolo, r.prezzo_acquisto DESC
        `, [userId]);

        // Statistiche rosa per ruolo
        const statsResult = await query(`
            SELECT c.ruolo, 
                   COUNT(*) as quantita,
                   SUM(r.prezzo_acquisto) as costo_totale,
                   AVG(r.prezzo_acquisto) as costo_medio,
                   AVG(c.quotazione) as quotazione_media
            FROM rose r
            JOIN calciatori c ON r.calciatore_id = c.id
            WHERE r.utente_id = $1
            GROUP BY c.ruolo
            ORDER BY c.ruolo
        `, [userId]);

        res.json({
            utente: utente,
            rosa: rosaResult.rows,
            statistiche: {
                totale_calciatori: rosaResult.rows.length,
                costo_totale: rosaResult.rows.reduce((sum, c) => sum + c.prezzo_acquisto, 0),
                per_ruolo: statsResult.rows
            }
        });

    } catch (error) {
        console.error('Errore recupero rosa personale:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// GET /api/utenti - Lista tutti gli utenti (solo admin)
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await query(`
            SELECT u.id, u.username, u.email, u.crediti_totali, u.crediti_spesi,
                   (u.crediti_totali - u.crediti_spesi) as crediti_disponibili,
                   COUNT(r.id) as calciatori_acquistati,
                   u.created_at, u.is_admin
            FROM utenti u
            LEFT JOIN rose r ON u.id = r.utente_id
            GROUP BY u.id, u.username, u.email, u.crediti_totali, u.crediti_spesi, u.created_at, u.is_admin
            ORDER BY u.created_at DESC
        `);

        res.json({ utenti: result.rows });

    } catch (error) {
        console.error('Errore recupero utenti:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// GET /api/utenti/:id/rosa - Rosa di un utente specifico
router.get('/:id/rosa', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Nel fantasy football, tutti dovrebbero vedere tutte le rose per trasparenza
        // Solo per "La Mia Rosa" serve essere proprietario
        // Per "Tutte le Rose" tutti possono vedere tutto
        
        console.log(`🔍 Richiesta rosa utente ${id} da parte di ${req.user.username} (ID: ${req.user.id})`);

        // Recupera info utente
        const utenteResult = await query(`
            SELECT u.username, u.crediti_totali, 
                   COALESCE(SUM(r.prezzo_acquisto), 0) as crediti_spesi,
                   (u.crediti_totali - COALESCE(SUM(r.prezzo_acquisto), 0)) as crediti_disponibili
            FROM utenti u
            LEFT JOIN rose r ON u.id = r.utente_id
            WHERE u.id = $1
            GROUP BY u.id, u.username, u.crediti_totali
        `, [id]);

        if (utenteResult.rows.length === 0) {
            return res.status(404).json({ error: 'Utente non trovato' });
        }

        const utente = utenteResult.rows[0];

        // Recupera rosa con calciatori
        const rosaResult = await query(`
            SELECT r.*, c.nome, c.squadra, c.ruolo, c.quotazione,
                   r.prezzo_acquisto, r.created_at as data_acquisto
            FROM rose r
            JOIN calciatori c ON r.calciatore_id = c.id
            WHERE r.utente_id = $1
            ORDER BY c.ruolo, r.prezzo_acquisto DESC
        `, [id]);

        // Statistiche rosa per ruolo
        const statsResult = await query(`
            SELECT c.ruolo, 
                   COUNT(*) as quantita,
                   SUM(r.prezzo_acquisto) as costo_totale,
                   AVG(r.prezzo_acquisto) as costo_medio,
                   AVG(c.quotazione) as quotazione_media
            FROM rose r
            JOIN calciatori c ON r.calciatore_id = c.id
            WHERE r.utente_id = $1
            GROUP BY c.ruolo
            ORDER BY c.ruolo
        `, [id]);

        console.log(`✅ Rosa utente ${id}: ${rosaResult.rows.length} giocatori`);

        res.json({
            utente: utente,
            rosa: rosaResult.rows,
            statistiche: {
                totale_calciatori: rosaResult.rows.length,
                costo_totale: rosaResult.rows.reduce((sum, c) => sum + c.prezzo_acquisto, 0),
                per_ruolo: statsResult.rows
            }
        });

    } catch (error) {
        console.error('Errore recupero rosa:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// GET /api/utenti/me/rosa - Rosa dell'utente corrente
router.get('/me/rosa', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        // Recupera info utente
        const utenteResult = await query(`
            SELECT u.username, u.crediti_totali, u.crediti_spesi,
                   (u.crediti_totali - u.crediti_spesi) as crediti_disponibili
            FROM utenti u
            WHERE u.id = $1
        `, [userId]);

        if (utenteResult.rows.length === 0) {
            return res.status(404).json({ error: 'Utente non trovato' });
        }

        const utente = utenteResult.rows[0];

        // Recupera rosa con calciatori
        const rosaResult = await query(`
            SELECT r.*, c.nome, c.squadra, c.ruolo, c.quotazione,
                   r.prezzo_acquisto, r.created_at as data_acquisto
            FROM rose r
            JOIN calciatori c ON r.calciatore_id = c.id
            WHERE r.utente_id = $1
            ORDER BY c.ruolo, r.prezzo_acquisto DESC
        `, [userId]);

        // Statistiche rosa per ruolo
        const statsResult = await query(`
            SELECT c.ruolo, 
                   COUNT(*) as quantita,
                   SUM(r.prezzo_acquisto) as costo_totale,
                   AVG(r.prezzo_acquisto) as costo_medio,
                   AVG(c.quotazione) as quotazione_media
            FROM rose r
            JOIN calciatori c ON r.calciatore_id = c.id
            WHERE r.utente_id = $1
            GROUP BY c.ruolo
            ORDER BY c.ruolo
        `, [userId]);

        res.json({
            utente: utente,
            rosa: rosaResult.rows,
            statistiche: {
                totale_calciatori: rosaResult.rows.length,
                costo_totale: rosaResult.rows.reduce((sum, c) => sum + c.prezzo_acquisto, 0),
                per_ruolo: statsResult.rows
            }
        });

    } catch (error) {
        console.error('Errore recupero rosa personale:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// GET /api/utenti/rose/all - Tutte le rose (pubbliche)
router.get('/rose/all', authenticateToken, async (req, res) => {
    try {
        const result = await query(`
            SELECT u.id, u.username, u.is_admin,
                   u.crediti_totali, 
                   COALESCE(SUM(r.prezzo_acquisto), 0) as crediti_spesi,
                   (u.crediti_totali - COALESCE(SUM(r.prezzo_acquisto), 0)) as crediti_disponibili,
                   COUNT(r.id) as calciatori_acquistati,
                   COALESCE(SUM(r.prezzo_acquisto), 0) as spesa_totale
            FROM utenti u
            LEFT JOIN rose r ON u.id = r.utente_id
            GROUP BY u.id, u.username, u.crediti_totali, u.is_admin
            ORDER BY spesa_totale DESC, calciatori_acquistati DESC, u.username ASC
        `);

        console.log('🔍 Utenti trovati:', result.rows.length);
        console.log('🔍 Primo utente:', result.rows[0]);

        res.json({ 
            rose: result.rows,
            totale_partecipanti: result.rows.length
        });

    } catch (error) {
        console.error('Errore recupero tutte le rose:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// GET /api/utenti/rose/classifica - Classifica per gestione crediti e completamento rosa
router.get('/rose/classifica', authenticateToken, async (req, res) => {
    try {
        const result = await query(`
            SELECT u.id, u.username, u.is_admin,
                   COUNT(r.id) as calciatori_acquistati,
                   COALESCE(SUM(r.prezzo_acquisto), 0) as spesa_totale,
                   u.crediti_totali,
                   (u.crediti_totali - COALESCE(SUM(r.prezzo_acquisto), 0)) as crediti_rimanenti,
                   -- Statistiche per ruolo
                   COUNT(CASE WHEN c.ruolo = 'P' THEN 1 END) as portieri,
                   COUNT(CASE WHEN c.ruolo = 'D' THEN 1 END) as difensori,
                   COUNT(CASE WHEN c.ruolo = 'C' THEN 1 END) as centrocampisti,
                   COUNT(CASE WHEN c.ruolo = 'A' THEN 1 END) as attaccanti,
                   -- Calcolo slot occupati su requisiti (3P + 8D + 8C + 6A = 25 totali)
                   LEAST(COUNT(CASE WHEN c.ruolo = 'P' THEN 1 END), 3) +
                   LEAST(COUNT(CASE WHEN c.ruolo = 'D' THEN 1 END), 8) +
                   LEAST(COUNT(CASE WHEN c.ruolo = 'C' THEN 1 END), 8) +
                   LEAST(COUNT(CASE WHEN c.ruolo = 'A' THEN 1 END), 6) as slot_utili_occupati
            FROM utenti u
            LEFT JOIN rose r ON u.id = r.utente_id
            LEFT JOIN calciatori c ON r.calciatore_id = c.id
            GROUP BY u.id, u.username, u.crediti_totali, u.is_admin
            ORDER BY 
                crediti_rimanenti DESC,           -- Prima priorità: più crediti rimanenti
                slot_utili_occupati DESC,         -- Seconda priorità: più slot utili occupati
                spesa_totale ASC,                 -- Terza priorità: meno spesa a parità di condizioni
                u.username ASC                    -- Quarta priorità: ordine alfabetico
        `);

        console.log('🔍 Classifica crediti - utenti trovati:', result.rows.length);
        console.log('🔍 Primo per gestione crediti:', result.rows[0]);

        res.json({ classifica: result.rows });

    } catch (error) {
        console.error('Errore recupero classifica crediti:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// PUT /api/utenti/:id/crediti - Modifica crediti utente (solo admin)
router.put('/:id/crediti', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { nuovi_crediti } = req.body;

        if (!nuovi_crediti || nuovi_crediti < 0) {
            return res.status(400).json({ error: 'Numero di crediti non valido' });
        }

        // Verifica che l'utente esista
        const utenteResult = await query(`
            SELECT username, crediti_spesi FROM utenti WHERE id = $1
        `, [id]);

        if (utenteResult.rows.length === 0) {
            return res.status(404).json({ error: 'Utente non trovato' });
        }

        const utente = utenteResult.rows[0];

        // Verifica che i nuovi crediti siano sufficienti per coprire la spesa
        if (nuovi_crediti < utente.crediti_spesi) {
            return res.status(400).json({ 
                error: 'I nuovi crediti devono coprire la spesa già sostenuta',
                crediti_spesi: utente.crediti_spesi,
                crediti_richiesti: nuovi_crediti
            });
        }

        // Aggiorna i crediti
        await query(`
            UPDATE utenti 
            SET crediti_totali = $1
            WHERE id = $2
        `, [nuovi_crediti, id]);

        res.json({
            message: `Crediti di ${utente.username} aggiornati a ${nuovi_crediti}`,
            crediti_precedenti: utenteResult.rows[0].crediti_totali || 0,
            crediti_nuovi: nuovi_crediti
        });

    } catch (error) {
        console.error('Errore aggiornamento crediti:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

module.exports = router;